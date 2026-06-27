package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sns/types"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// SNSPublisher is the subset of the AWS SNS API the notifier needs. Narrowed to a
// port so the adapter is unit-testable with a fake and so it works identically
// against floci (AWS-local @ :4566) or real SNS.
type SNSPublisher interface {
	Publish(ctx context.Context, in *sns.PublishInput, optFns ...func(*sns.Options)) (*sns.PublishOutput, error)
}

// SNS dispatches alert notifications by PUBLISHING them to an SNS topic. The topic
// fans out to its subscriptions: an SQS queue (proven in the integration test), an
// HTTPS webhook endpoint, and an email subscription (email-stub). The rule's own
// notify_channels travel in the JSON body and message attributes so a subscriber
// can route per-channel; SNS owns the actual fan-out, keeping this adapter thin.
//
// In floci, the SNS client is pointed at http://localhost:4566 (model.md /
// .env.example AWS_ENDPOINT_URL). The same code runs unchanged against real SNS.
type SNS struct {
	client   SNSPublisher
	topicARN string
	log      *slog.Logger
}

var _ app.Notifier = (*SNS)(nil)

// NewSNS builds an SNS notifier over an SNS client and the destination topic ARN.
func NewSNS(client SNSPublisher, topicARN string, log *slog.Logger) *SNS {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &SNS{client: client, topicARN: topicARN, log: log}
}

// snsPayload is the JSON published to SNS — the notification rendered for delivery.
type snsPayload struct {
	Kind           string        `json:"kind"` // "firing" | "resolved"
	NotificationID string        `json:"notification_id"`
	TenantID       string        `json:"tenant_id"`
	RuleID         string        `json:"rule_id"`
	RuleName       string        `json:"rule_name"`
	Severity       string        `json:"severity"`
	State          string        `json:"state"`
	ObservedCount  int64         `json:"observed_count"`
	Threshold      float64       `json:"threshold"`
	TransitionSeq  int64         `json:"transition_seq"`
	Channels       []app.Channel `json:"channels"`
	OccurredAt     string        `json:"occurred_at"`
}

// Notify publishes the notification to the topic. A publish error is returned so
// the evaluator leaves the outbox row pending (dispatched_at NULL) for redispatch.
func (s *SNS) Notify(ctx context.Context, n app.Notification) error {
	kind := "firing"
	if n.Resolved() {
		kind = "resolved"
	}
	body, err := json.Marshal(snsPayload{
		Kind:           kind,
		NotificationID: n.ID,
		TenantID:       string(n.TenantID),
		RuleID:         n.RuleID,
		RuleName:       n.RuleName,
		Severity:       n.Severity,
		State:          string(n.ToState),
		ObservedCount:  n.ObservedCount,
		Threshold:      n.Threshold,
		TransitionSeq:  n.TransitionSeq,
		Channels:       n.Channels,
		OccurredAt:     n.OccurredAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
	if err != nil {
		return fmt.Errorf("sns: marshal payload: %w", err)
	}

	_, err = s.client.Publish(ctx, &sns.PublishInput{
		TopicArn: aws.String(s.topicARN),
		Message:  aws.String(string(body)),
		Subject:  aws.String(fmt.Sprintf("[%s] %s: %s", kind, n.Severity, n.RuleName)),
		MessageAttributes: map[string]types.MessageAttributeValue{
			// Tenant + kind as attributes so subscriptions can filter without parsing
			// the body (and so an operator can audit fan-out by tenant).
			"tenant_id": {DataType: aws.String("String"), StringValue: aws.String(string(n.TenantID))},
			"kind":      {DataType: aws.String("String"), StringValue: aws.String(kind)},
			"severity":  {DataType: aws.String("String"), StringValue: aws.String(n.Severity)},
		},
	})
	if err != nil {
		return fmt.Errorf("sns: publish to %s: %w", s.topicARN, err)
	}
	s.log.Info("alert notification published", "kind", kind, "rule_id", n.RuleID,
		"tenant_id", n.TenantID, "topic", s.topicARN)
	return nil
}
