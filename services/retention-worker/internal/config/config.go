// Package config loads retention-worker configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/app"
)

const (
	// RetentionDatabaseURLEnv is the BYPASSRLS logalot_retention role DSN.
	RetentionDatabaseURLEnv = "LOGALOT_RETENTION_DATABASE_URL"

	// ColdBucketEnv is the S3 cold-tier bucket name (e.g. "logalot-cold").
	ColdBucketEnv = "COLD_S3_BUCKET"

	// HotDaysEnv overrides the global hot-partition retention horizon.
	// Default: 30.
	HotDaysEnv = "HOT_RETENTION_DAYS"

	// IntervalEnv sets the cycle cadence (Go duration string, e.g. "24h").
	// Default: 24h.
	IntervalEnv = "RETENTION_INTERVAL"

	// AWSEndpointEnv is the AWS endpoint override for floci (e.g.
	// "http://localhost:4566"). Memory note: this project uses floci (NOT
	// localstack) for AWS-local — endpoint :4566, image floci/floci.
	AWSEndpointEnv = "AWS_ENDPOINT_URL"
)

// Config is the resolved retention-worker configuration.
type Config struct {
	// RetentionDatabaseURL is the BYPASSRLS logalot_retention DSN.
	RetentionDatabaseURL string
	// ColdBucket is the S3 cold-tier bucket (e.g. "logalot-cold").
	ColdBucket string
	// HotDays is the global hot-partition retention horizon (default 30).
	HotDays int
	// Interval is the retention cycle cadence (default 24h).
	Interval time.Duration
	// AWSEndpoint is an optional AWS endpoint override (floci for local dev).
	AWSEndpoint string
}

// Load reads and validates configuration from the process environment.
// Fails closed: required vars missing → error; service must not start.
func Load() (Config, error) {
	c := Config{
		RetentionDatabaseURL: os.Getenv(RetentionDatabaseURLEnv),
		ColdBucket:           os.Getenv(ColdBucketEnv),
		HotDays:              app.DefaultHotDays,
		Interval:             app.DefaultInterval,
		AWSEndpoint:          os.Getenv(AWSEndpointEnv),
	}

	if c.RetentionDatabaseURL == "" {
		return Config{}, fmt.Errorf("config: %s is not set", RetentionDatabaseURLEnv)
	}
	if c.ColdBucket == "" {
		return Config{}, fmt.Errorf("config: %s is not set", ColdBucketEnv)
	}

	if v := os.Getenv(HotDaysEnv); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: %s must be a positive int, got %q", HotDaysEnv, v)
		}
		c.HotDays = n
	}

	if v := os.Getenv(IntervalEnv); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("config: %s must be a positive duration, got %q", IntervalEnv, v)
		}
		c.Interval = d
	}

	return c, nil
}
