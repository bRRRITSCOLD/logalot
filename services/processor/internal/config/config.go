// Package config loads processor configuration from the environment. Dependency
// DSNs are sourced from the shared platform/broker helpers so the env var
// contract is defined once across services (DRY).
package config

import (
	"os"
	"strconv"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
)

// Config is the resolved processor configuration.
type Config struct {
	// RabbitURL is the AMQP connection URL (consume side of the ingest pipeline).
	RabbitURL string
	// AppDBURL is the NOSUPERUSER logalot_app Postgres DSN (RLS-governed).
	AppDBURL string
	// Redis is the tail-bus pub/sub connection.
	Redis platform.RedisConfig
	// Prefetch bounds unacked in-flight deliveries (consumer QoS).
	Prefetch int
	// MaxRetries bounds transient persist retries before dead-lettering.
	MaxRetries int
	// RetryBackoff is the base backoff between persist attempts.
	RetryBackoff time.Duration
	// ShutdownGrace bounds in-flight drain on shutdown.
	ShutdownGrace time.Duration
	// DrainTimeout bounds a single in-flight persist that runs on a shutdown drain
	// (issue #37). It must be < terminationGracePeriodSeconds so the drain finishes
	// before the orchestrator escalates to SIGKILL.
	DrainTimeout time.Duration
}

const (
	defaultPrefetch     = 64
	defaultMaxRetries   = 3
	defaultRetryBackoff = 200 * time.Millisecond
	defaultShutdown     = 20 * time.Second
	defaultDrain        = 8 * time.Second
)

// Load resolves configuration, failing closed if a required dependency DSN is
// missing (a processor that cannot reach its broker/DB/cache must not start).
func Load() (Config, error) {
	rabbitURL, err := broker.URLFromEnv()
	if err != nil {
		return Config{}, err
	}
	appDB, err := platform.AppDatabaseURL()
	if err != nil {
		return Config{}, err
	}
	redisCfg, err := platform.RedisConfigFromEnv()
	if err != nil {
		return Config{}, err
	}
	return Config{
		RabbitURL:     rabbitURL,
		AppDBURL:      appDB,
		Redis:         redisCfg,
		Prefetch:      envInt("PROCESSOR_PREFETCH", defaultPrefetch),
		MaxRetries:    envInt("PROCESSOR_MAX_RETRIES", defaultMaxRetries),
		RetryBackoff:  defaultRetryBackoff,
		ShutdownGrace: defaultShutdown,
		DrainTimeout:  defaultDrain,
	}, nil
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
