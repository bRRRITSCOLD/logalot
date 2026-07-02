package notify

import (
	"context"
	"errors"
	"testing"

	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// fakeNextNotifier records whether it was called and can be made to fail, so
// tests can prove EmailNotifier forwards to (and does not replace) the base
// notifier — the "no behavior change to the webhook channel" AC.
type fakeNextNotifier struct {
	calls int
	err   error
}

func (f *fakeNextNotifier) Notify(_ context.Context, _ app.Notification) error {
	f.calls++
	return f.err
}

// fakeEmailSender records every Send call.
type fakeEmailSender struct {
	sent []sentEmail
	err  error
}

type sentEmail struct {
	to, subject, body string
}

func (f *fakeEmailSender) Send(_ context.Context, to, subject, body string) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, sentEmail{to, subject, body})
	return nil
}

func webhookOnlyNotification() app.Notification {
	return app.Notification{
		ID: "n-1", TenantID: "t-1", RuleID: "r-1", RuleName: "too many errors",
		ToState: app.StateFiring, Severity: "critical", ObservedCount: 9, Threshold: 5,
		Channels: []app.Channel{{Type: "webhook", URL: "https://hooks.example/x"}},
	}
}

func emailNotification() app.Notification {
	n := webhookOnlyNotification()
	n.Channels = append(n.Channels, app.Channel{Type: "email", To: "oncall@example.com"})
	return n
}

func TestEmailNotifier_ForwardsToBaseNotifierUnchanged(t *testing.T) {
	next := &fakeNextNotifier{}
	sender := &fakeEmailSender{}
	n := NewEmailNotifier(next, sender, nil)

	if err := n.Notify(context.Background(), webhookOnlyNotification()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if next.calls != 1 {
		t.Fatalf("expected base notifier called once, got %d", next.calls)
	}
	if len(sender.sent) != 0 {
		t.Fatalf("expected no email sent for a webhook-only rule, got %v", sender.sent)
	}
}

func TestEmailNotifier_SendsRealEmailForEmailChannel(t *testing.T) {
	next := &fakeNextNotifier{}
	sender := &fakeEmailSender{}
	n := NewEmailNotifier(next, sender, nil)

	if err := n.Notify(context.Background(), emailNotification()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if next.calls != 1 {
		t.Fatalf("expected base notifier still called, got %d", next.calls)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("expected exactly one email sent, got %d", len(sender.sent))
	}
	if sender.sent[0].to != "oncall@example.com" {
		t.Fatalf("to = %q", sender.sent[0].to)
	}
	if sender.sent[0].subject == "" || sender.sent[0].body == "" {
		t.Fatal("expected non-empty subject/body")
	}
}

func TestEmailNotifier_BaseNotifierErrorStillAttemptsEmail(t *testing.T) {
	next := &fakeNextNotifier{err: errors.New("sns down")}
	sender := &fakeEmailSender{}
	n := NewEmailNotifier(next, sender, nil)

	err := n.Notify(context.Background(), emailNotification())
	if err == nil {
		t.Fatal("expected error from failed base notifier to propagate")
	}
	if len(sender.sent) != 1 {
		t.Fatalf("expected email still attempted despite base notifier failure, got %d sent", len(sender.sent))
	}
}

func TestEmailNotifier_EmailSendErrorIsReturned(t *testing.T) {
	next := &fakeNextNotifier{}
	sender := &fakeEmailSender{err: errors.New("mailhog down")}
	n := NewEmailNotifier(next, sender, nil)

	if err := n.Notify(context.Background(), emailNotification()); err == nil {
		t.Fatal("expected email send error to propagate (so outbox stays pending)")
	}
}
