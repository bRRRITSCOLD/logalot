// Package notify holds the Notifier adapters. LogSink is the default and the test
// double; SNS is the floci SNS/SQS dispatch path (webhook + email-stub fan-out).
package notify

import (
	"context"
	"io"
	"log/slog"
	"sync"

	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// LogSink is a Notifier that records every dispatched notification and logs it. It
// is the safe default (a rule with no usable channel still produces an auditable
// record) and the integration/unit test double for proving "exactly one
// notification per transition".
type LogSink struct {
	mu   sync.Mutex
	sent []app.Notification
	log  *slog.Logger
}

var _ app.Notifier = (*LogSink)(nil)

// NewLogSink builds a LogSink. A nil logger discards.
func NewLogSink(log *slog.Logger) *LogSink {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &LogSink{log: log}
}

// Notify records and logs the notification.
func (s *LogSink) Notify(_ context.Context, n app.Notification) error {
	s.mu.Lock()
	s.sent = append(s.sent, n)
	s.mu.Unlock()
	kind := "firing"
	if n.Resolved() {
		kind = "resolved"
	}
	s.log.Info("alert notification",
		"kind", kind, "rule_id", n.RuleID, "rule", n.RuleName, "tenant_id", n.TenantID,
		"severity", n.Severity, "count", n.ObservedCount, "threshold", n.Threshold,
		"transition_seq", n.TransitionSeq)
	return nil
}

// Sent returns a copy of all recorded notifications (test/inspection helper).
func (s *LogSink) Sent() []app.Notification {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]app.Notification, len(s.sent))
	copy(out, s.sent)
	return out
}

// CountTo returns how many recorded notifications transitioned to the given state.
func (s *LogSink) CountTo(state app.State) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := 0
	for _, n := range s.sent {
		if n.ToState == state {
			c++
		}
	}
	return c
}
