// Package config loads + validates the alert-evaluator's environment. It fails
// closed: a misconfigured evaluator must not start with a privileged or missing
// connection.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// Env var names. The evaluator holds TWO database connections by design
// (model.md §4.5): one BYPASSRLS scheduler login and one RLS-governed app login.
const (
	// EvaluatorDatabaseURLEnv points at the BYPASSRLS logalot_evaluator role — used
	// ONLY to read rule scheduling metadata + write state/outbox (never log content).
	EvaluatorDatabaseURLEnv = "LOGALOT_EVALUATOR_DATABASE_URL"
	// AppDatabaseURLEnv points at the NOSUPERUSER logalot_app role — used to COUNT
	// log_events under per-tenant RLS (the same var every other service uses).
	AppDatabaseURLEnv = "LOGALOT_APP_DATABASE_URL"

	IntervalEnv  = "ALERT_EVAL_INTERVAL"
	BatchSizeEnv = "ALERT_EVAL_BATCH_SIZE"

	// Notifier selection + floci SNS config.
	NotifierEnv    = "ALERT_NOTIFIER"      // "logsink" (default) | "sns"
	SNSTopicARNEnv = "ALERT_SNS_TOPIC_ARN" // required when NOTIFIER=sns
	AWSEndpointEnv = "AWS_ENDPOINT_URL"    // floci endpoint, e.g. http://localhost:4566

	// SMTP config for the real "email" channel send (issue #187, retiring the SNS
	// email-stub). Same var names as the invites context's control-plane adapter
	// (services/control-plane/src/config/env.ts) so both point at the same MailHog
	// instance locally. Email dispatch is enabled whenever SMTPHostEnv is set,
	// independent of NotifierEnv — email no longer routes through SNS at all.
	SMTPHostEnv = "SMTP_HOST"
	SMTPPortEnv = "SMTP_PORT"
	SMTPUserEnv = "SMTP_USER"
	SMTPPassEnv = "SMTP_PASS" // secret — read from env only, never logged.
	SMTPFromEnv = "SMTP_FROM"
)

// Config is the validated evaluator configuration.
type Config struct {
	EvaluatorDatabaseURL string
	AppDatabaseURL       string
	Interval             time.Duration
	BatchSize            int
	Notifier             string
	SNSTopicARN          string
	AWSEndpoint          string

	// SMTP is set (SMTPHost != "") when the email channel should really be sent.
	// When unset, email channels are silently skipped by the notifier decorator
	// (backward-compatible default — no behavior change for deployments that
	// haven't configured SMTP yet).
	SMTPHost string
	SMTPPort int
	SMTPUser string
	SMTPPass string
	SMTPFrom string
}

// Load reads + validates config from the process environment.
func Load() (Config, error) {
	c := Config{
		EvaluatorDatabaseURL: os.Getenv(EvaluatorDatabaseURLEnv),
		AppDatabaseURL:       os.Getenv(AppDatabaseURLEnv),
		// DRY: single source of truth for the defaults lives in the app core.
		Interval:    app.DefaultInterval,
		BatchSize:   app.DefaultBatchSize,
		Notifier:    "logsink",
		SNSTopicARN: os.Getenv(SNSTopicARNEnv),
		AWSEndpoint: os.Getenv(AWSEndpointEnv),
	}

	if c.EvaluatorDatabaseURL == "" {
		return Config{}, fmt.Errorf("config: %s is not set", EvaluatorDatabaseURLEnv)
	}
	if c.AppDatabaseURL == "" {
		return Config{}, fmt.Errorf("config: %s is not set", AppDatabaseURLEnv)
	}

	if v := os.Getenv(IntervalEnv); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("config: %s: %w", IntervalEnv, err)
		}
		// Keep the cadence under the 30s eval-latency NFR.
		if d <= 0 || d >= 30*time.Second {
			return Config{}, fmt.Errorf("config: %s must be > 0 and < 30s (NFR), got %s", IntervalEnv, d)
		}
		c.Interval = d
	}

	if v := os.Getenv(BatchSizeEnv); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: %s must be a positive int, got %q", BatchSizeEnv, v)
		}
		c.BatchSize = n
	}

	if v := os.Getenv(NotifierEnv); v != "" {
		c.Notifier = v
	}
	switch c.Notifier {
	case "logsink":
	case "sns":
		if c.SNSTopicARN == "" {
			return Config{}, fmt.Errorf("config: %s=sns requires %s", NotifierEnv, SNSTopicARNEnv)
		}
	default:
		return Config{}, fmt.Errorf("config: unknown %s=%q (want logsink|sns)", NotifierEnv, c.Notifier)
	}

	c.SMTPHost = os.Getenv(SMTPHostEnv)
	c.SMTPUser = os.Getenv(SMTPUserEnv)
	c.SMTPPass = os.Getenv(SMTPPassEnv)
	c.SMTPFrom = os.Getenv(SMTPFromEnv)
	if c.SMTPHost != "" {
		// Fail closed: a partially-configured SMTP block must not silently start
		// with no real email delivery (the whole point of #187).
		if c.SMTPFrom == "" {
			return Config{}, fmt.Errorf("config: %s is required when %s is set", SMTPFromEnv, SMTPHostEnv)
		}
		v := os.Getenv(SMTPPortEnv)
		if v == "" {
			return Config{}, fmt.Errorf("config: %s is required when %s is set", SMTPPortEnv, SMTPHostEnv)
		}
		port, err := strconv.Atoi(v)
		if err != nil || port <= 0 {
			return Config{}, fmt.Errorf("config: %s must be a positive int, got %q", SMTPPortEnv, v)
		}
		c.SMTPPort = port
	}

	return c, nil
}
