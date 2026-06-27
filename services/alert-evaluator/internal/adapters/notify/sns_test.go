package notify

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

type fakePublisher struct {
	in  *sns.PublishInput
	err error
}

func (f *fakePublisher) Publish(_ context.Context, in *sns.PublishInput, _ ...func(*sns.Options)) (*sns.PublishOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.in = in
	return &sns.PublishOutput{}, nil
}

func firingNotification() app.Notification {
	return app.Notification{
		ID:            "n-1",
		TenantID:      "00000000-0000-0000-0000-00000000000a",
		RuleID:        "r-1",
		RuleName:      "too many errors",
		TransitionSeq: 1,
		ToState:       app.StateFiring,
		Severity:      "critical",
		ObservedCount: 9,
		Threshold:     5,
		Channels:      []app.Channel{{Type: "webhook", URL: "https://hooks.example/x"}},
		OccurredAt:    time.Unix(0, 0).UTC(),
	}
}

func TestSNS_Notify_PublishesFiringPayloadToTopic(t *testing.T) {
	pub := &fakePublisher{}
	n := NewSNS(pub, "arn:aws:sns:us-east-1:000000000000:logalot-alerts", nil)

	if err := n.Notify(context.Background(), firingNotification()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if pub.in == nil {
		t.Fatal("expected a Publish call")
	}
	if *pub.in.TopicArn != "arn:aws:sns:us-east-1:000000000000:logalot-alerts" {
		t.Fatalf("topic = %q", *pub.in.TopicArn)
	}
	var got snsPayload
	if err := json.Unmarshal([]byte(*pub.in.Message), &got); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if got.Kind != "firing" || got.State != "firing" {
		t.Fatalf("payload kind/state = %q/%q, want firing/firing", got.Kind, got.State)
	}
	if got.ObservedCount != 9 || got.Threshold != 5 {
		t.Fatalf("payload count/threshold = %d/%v", got.ObservedCount, got.Threshold)
	}
	if attr, ok := pub.in.MessageAttributes["tenant_id"]; !ok || *attr.StringValue != string(got.TenantID) {
		t.Fatalf("tenant_id attribute missing/mismatched")
	}
}

func TestSNS_Notify_RendersResolvedKindForClear(t *testing.T) {
	pub := &fakePublisher{}
	n := NewSNS(pub, "arn:topic", nil)
	notif := firingNotification()
	notif.ToState = app.StateOK // firing -> ok == resolved

	if err := n.Notify(context.Background(), notif); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	var got snsPayload
	_ = json.Unmarshal([]byte(*pub.in.Message), &got)
	if got.Kind != "resolved" {
		t.Fatalf("kind = %q, want resolved", got.Kind)
	}
}

func TestSNS_Notify_PublishErrorIsReturned(t *testing.T) {
	pub := &fakePublisher{err: errors.New("floci down")}
	n := NewSNS(pub, "arn:topic", nil)
	if err := n.Notify(context.Background(), firingNotification()); err == nil {
		t.Fatal("expected publish error to propagate (so outbox stays pending)")
	}
}
