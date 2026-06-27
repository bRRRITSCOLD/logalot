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

	return c, nil
}
