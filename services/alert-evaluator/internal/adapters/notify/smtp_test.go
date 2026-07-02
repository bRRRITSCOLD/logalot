package notify

import (
	"context"
	"errors"
	"net/smtp"
	"strings"
	"testing"
	"time"
)

func TestSMTPEmailSender_SendBuildsMessageAndDialsConfiguredHost(t *testing.T) {
	var gotAddr, gotFrom string
	var gotTo []string
	var gotMsg []byte
	sender := NewSMTPEmailSender(SMTPConfig{Host: "mailhog", Port: 1025, From: "alerts@logalot.local"})
	sender.send = func(addr string, _ smtp.Auth, from string, to []string, msg []byte) error {
		gotAddr, gotFrom, gotTo, gotMsg = addr, from, to, msg
		return nil
	}

	err := sender.Send(context.Background(), "oncall@example.com", "[firing] critical: too many errors", "body text")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotAddr != "mailhog:1025" {
		t.Fatalf("addr = %q", gotAddr)
	}
	if gotFrom != "alerts@logalot.local" {
		t.Fatalf("from = %q", gotFrom)
	}
	if len(gotTo) != 1 || gotTo[0] != "oncall@example.com" {
		t.Fatalf("to = %v", gotTo)
	}
	msg := string(gotMsg)
	if !strings.Contains(msg, "To: oncall@example.com") {
		t.Fatalf("message missing To header: %s", msg)
	}
	if !strings.Contains(msg, "Subject: [firing] critical: too many errors") {
		t.Fatalf("message missing Subject header: %s", msg)
	}
	if !strings.Contains(msg, "body text") {
		t.Fatalf("message missing body: %s", msg)
	}
	if !strings.Contains(msg, "Date: ") {
		t.Fatalf("message missing Date header: %s", msg)
	}
	if !strings.Contains(msg, "Message-ID: <") {
		t.Fatalf("message missing Message-ID header: %s", msg)
	}
}

// TestSMTPEmailSender_SendReturnsOnCtxCancelWithoutWaitingForSend proves a
// hung/slow relay cannot block the caller past ctx's deadline — the whole
// point of the timeout fix: one stuck send must not stall the outbox relay's
// single-goroutine dispatch loop (see app/evaluator.go dispatchPending).
func TestSMTPEmailSender_SendReturnsOnCtxCancelWithoutWaitingForSend(t *testing.T) {
	sendStarted := make(chan struct{})
	sendMayReturn := make(chan struct{})
	sender := NewSMTPEmailSender(SMTPConfig{Host: "mailhog", Port: 1025, From: "a@b.com"})
	sender.send = func(_ string, _ smtp.Auth, _ string, _ []string, _ []byte) error {
		close(sendStarted)
		<-sendMayReturn // simulate a hung relay that never returns on its own
		return nil
	}
	defer close(sendMayReturn) // let the leaked goroutine finish so the test doesn't hang the run

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- sender.Send(ctx, "x@y.com", "s", "b") }()

	<-sendStarted
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected error when ctx is canceled mid-send")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send did not return promptly after ctx cancel; it blocked on the hung relay")
	}
}

func TestSMTPEmailSender_SendUsesAuthWhenUserConfigured(t *testing.T) {
	var gotAuth smtp.Auth
	sender := NewSMTPEmailSender(SMTPConfig{Host: "smtp.example.com", Port: 587, User: "u", Pass: "p", From: "a@b.com"})
	sender.send = func(_ string, a smtp.Auth, _ string, _ []string, _ []byte) error {
		gotAuth = a
		return nil
	}
	if err := sender.Send(context.Background(), "x@y.com", "s", "b"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotAuth == nil {
		t.Fatal("expected non-nil auth when User is configured")
	}
}

func TestSMTPEmailSender_SendNoAuthWhenUnconfigured(t *testing.T) {
	var authWasNil bool
	sender := NewSMTPEmailSender(SMTPConfig{Host: "mailhog", Port: 1025, From: "a@b.com"})
	sender.send = func(_ string, a smtp.Auth, _ string, _ []string, _ []byte) error {
		authWasNil = a == nil
		return nil
	}
	if err := sender.Send(context.Background(), "x@y.com", "s", "b"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !authWasNil {
		t.Fatal("expected nil auth for unauthenticated relay (MailHog)")
	}
}

func TestSMTPEmailSender_SendSanitizesHeaderInjectionAttempt(t *testing.T) {
	var gotMsg []byte
	sender := NewSMTPEmailSender(SMTPConfig{Host: "mailhog", Port: 1025, From: "a@b.com"})
	sender.send = func(_ string, _ smtp.Auth, _ string, _ []string, msg []byte) error {
		gotMsg = msg
		return nil
	}
	maliciousSubject := "hi\r\nBcc: attacker@evil.com"
	if err := sender.Send(context.Background(), "x@y.com", maliciousSubject, "b"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	msg := string(gotMsg)
	if strings.Contains(msg, "\r\nBcc:") {
		t.Fatalf("header injection not sanitized: %s", msg)
	}
}

func TestSMTPEmailSender_SendErrorIsWrapped(t *testing.T) {
	sender := NewSMTPEmailSender(SMTPConfig{Host: "mailhog", Port: 1025, From: "a@b.com"})
	sender.send = func(_ string, _ smtp.Auth, _ string, _ []string, _ []byte) error {
		return errors.New("connection refused")
	}
	err := sender.Send(context.Background(), "x@y.com", "s", "b")
	if err == nil {
		t.Fatal("expected error to propagate")
	}
}

func TestSMTPEmailSender_SendRejectsEmptyRecipient(t *testing.T) {
	sender := NewSMTPEmailSender(SMTPConfig{Host: "mailhog", Port: 1025, From: "a@b.com"})
	sender.send = func(_ string, _ smtp.Auth, _ string, _ []string, _ []byte) error {
		t.Fatal("send should not be dialed for an empty recipient")
		return nil
	}
	if err := sender.Send(context.Background(), "", "s", "b"); err == nil {
		t.Fatal("expected error for empty recipient")
	}
}
