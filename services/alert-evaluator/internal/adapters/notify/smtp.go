package notify

import (
	"context"
	"fmt"
	"net/smtp"
	"strings"

	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// SMTPConfig configures the SMTP adapter. Mirrors the invites context's SmtpConfig
// (services/control-plane/src/adapters/email/smtp-email-sender.ts) so both
// contexts point at the same MailHog instance locally (ADR-0013) and the same
// shape of config in production.
type SMTPConfig struct {
	Host string
	Port int
	// User / Pass are optional — MailHog and many local/dev relays accept
	// unauthenticated SMTP.
	User string
	Pass string
	// From is the fixed envelope/header From address (R-INV-14 style: read from
	// config at construction, never derived from request data).
	From string
}

// sendMailFunc matches net/smtp.SendMail's signature. It is a seam: production
// code uses smtp.SendMail unchanged; tests inject a fake so no real network I/O
// (or MailHog dependency) is needed to prove the adapter builds a correct,
// injection-safe message.
type sendMailFunc func(addr string, a smtp.Auth, from string, to []string, msg []byte) error

// SMTPEmailSender is the real send path for the alert "email" channel — retiring
// the SNS email-stub. It is deliberately narrow (stdlib net/smtp, no pooling) since
// alert volume is low; a queue-backed sender would be premature (YAGNI).
type SMTPEmailSender struct {
	cfg  SMTPConfig
	send sendMailFunc
}

var _ app.EmailSender = (*SMTPEmailSender)(nil)

// NewSMTPEmailSender builds an SMTPEmailSender from cfg.
func NewSMTPEmailSender(cfg SMTPConfig) *SMTPEmailSender {
	return &SMTPEmailSender{cfg: cfg, send: smtp.SendMail}
}

// Send delivers one email. Header values (to, subject) are sanitized to strip any
// CR/LF before being placed in the message so a rule name or recipient can never
// inject extra headers or split the message body (header-injection hardening —
// the same concern R-INV-13 covers for the invites SMTP adapter).
func (s *SMTPEmailSender) Send(_ context.Context, to, subject, body string) error {
	if to == "" {
		return fmt.Errorf("smtp: empty recipient")
	}
	addr := fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)

	var auth smtp.Auth
	if s.cfg.User != "" {
		auth = smtp.PlainAuth("", s.cfg.User, s.cfg.Pass, s.cfg.Host)
	}

	msg := buildMessage(s.cfg.From, to, subject, body)
	if err := s.send(addr, auth, s.cfg.From, []string{to}, msg); err != nil {
		return fmt.Errorf("smtp: send to %s: %w", to, err)
	}
	return nil
}

// sanitizeHeaderValue strips CR/LF so untrusted content (rule name, recipient)
// can never smuggle extra MIME headers into the message.
func sanitizeHeaderValue(v string) string {
	v = strings.ReplaceAll(v, "\r", "")
	v = strings.ReplaceAll(v, "\n", " ")
	return v
}

// buildMessage renders a minimal RFC 5322 message. Headers are built from
// sanitized values only (never raw concatenation of untrusted strings without
// sanitization) — mirroring the invites adapter's "structured, never raw" rule,
// adapted to net/smtp's []byte message contract (it has no MIME builder).
func buildMessage(from, to, subject, body string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", sanitizeHeaderValue(from))
	fmt.Fprintf(&b, "To: %s\r\n", sanitizeHeaderValue(to))
	fmt.Fprintf(&b, "Subject: %s\r\n", sanitizeHeaderValue(subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return []byte(b.String())
}
