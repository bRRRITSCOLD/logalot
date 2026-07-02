package notify

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// EmailNotifier decorates a base Notifier (LogSink or SNS) so an "email" channel
// ALSO gets a real SMTP send, on top of whatever the base notifier does. This is
// the real dispatch path retiring the SNS email-stub (issue #187): webhook fan-out
// keeps going through the base notifier UNCHANGED (AC "no behavior change to the
// working webhook channel"), while email is delivered directly via EmailSender.
type EmailNotifier struct {
	next   app.Notifier
	sender app.EmailSender
	log    *slog.Logger
}

var _ app.Notifier = (*EmailNotifier)(nil)

// NewEmailNotifier builds an EmailNotifier wrapping next. A nil logger discards.
func NewEmailNotifier(next app.Notifier, sender app.EmailSender, log *slog.Logger) *EmailNotifier {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &EmailNotifier{next: next, sender: sender, log: log}
}

// Notify forwards to the base notifier first (preserving its existing behavior
// and error semantics), then sends a real email for every channel of type
// "email". Errors from either path are joined so a failure on one side still
// leaves the outbox row pending for redispatch (at-least-once, per ports.go).
func (e *EmailNotifier) Notify(ctx context.Context, n app.Notification) error {
	var errs []error
	if err := e.next.Notify(ctx, n); err != nil {
		errs = append(errs, err)
	}

	kind := "firing"
	if n.Resolved() {
		kind = "resolved"
	}
	subject := fmt.Sprintf("[%s] %s: %s", kind, n.Severity, n.RuleName)
	body := emailBody(kind, n)

	for _, ch := range n.Channels {
		if ch.Type != "email" || ch.To == "" {
			continue
		}
		if err := e.sender.Send(ctx, ch.To, subject, body); err != nil {
			errs = append(errs, fmt.Errorf("email notify: %w", err))
			continue
		}
		e.log.Info("alert email sent", "kind", kind, "rule_id", n.RuleID,
			"tenant_id", n.TenantID, "to", ch.To)
	}

	return errors.Join(errs...)
}

// emailBody renders a minimal plain-text body for an alert email.
func emailBody(kind string, n app.Notification) string {
	return fmt.Sprintf(
		"Alert %q %s.\n\nSeverity: %s\nObserved count: %d\nThreshold: %v\nRule ID: %s\nTenant ID: %s\nOccurred at: %s\n",
		n.RuleName, kind, n.Severity, n.ObservedCount, n.Threshold, n.RuleID, n.TenantID,
		n.OccurredAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	)
}
