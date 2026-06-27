// Package config loads ingest-service configuration from the environment. Every
// dependency DSN is sourced from the shared platform/broker helpers so the env
// var contract is defined once across services (DRY).
package config

import (
	"os"
	"strconv"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/ratelimit"
)

// Config is the resolved ingest-service configuration.
type Config struct {
	// Addr is the HTTP listen address (host:port).
	Addr string
	// RabbitURL is the AMQP connection URL.
	RabbitURL string
	// AppDBURL is the NOSUPERUSER logalot_app Postgres DSN (RLS-governed).
	AppDBURL string
	// Redis is the key-cache / rate-limit Redis connection.
	Redis platform.RedisConfig
	// RateLimit holds the per-tenant ingest rate-limit configuration.
	RateLimit RateLimitConfig
	// ShutdownGrace bounds in-flight request draining on shutdown.
	ShutdownGrace time.Duration
}

// RateLimitConfig is the resolved per-tenant rate-limit configuration (ADR-0004).
type RateLimitConfig struct {
	// Enabled turns the limiter on. When false, no rate-limit middleware is wired.
	Enabled bool
	// FailOpen selects behaviour on a Redis outage: true admits (logs a warning),
	// false rejects with 503. Default true — ingest availability over enforcement.
	FailOpen bool
	// Default is the global token-bucket limit applied to any tenant without an
	// override.
	Default ratelimit.Limits
	// Overrides maps a tenant to its own limit (parsed from
	// INGEST_RATE_LIMIT_OVERRIDES). See ratelimit.ParseOverrides for the format.
	Overrides map[kernel.TenantID]ratelimit.Limits
}

// DefaultAddr is the listen address when neither INGEST_HTTP_ADDR nor PORT is set.
const DefaultAddr = ":8080"

// Rate-limit env vars and their defaults. Defaults are intentionally generous —
// a per-tenant safety valve, not a tight quota — and tuned down per tenant via
// INGEST_RATE_LIMIT_OVERRIDES as needed.
const (
	envRateEnabled   = "INGEST_RATE_LIMIT_ENABLED"
	envRateFailOpen  = "INGEST_RATE_LIMIT_FAIL_OPEN"
	envRateRPS       = "INGEST_RATE_LIMIT_RPS"
	envRateBurst     = "INGEST_RATE_LIMIT_BURST"
	envRateOverrides = "INGEST_RATE_LIMIT_OVERRIDES"

	defaultRateRPS   = 1000.0 // sustained requests/sec per tenant
	defaultRateBurst = 2000.0 // burst capacity per tenant
)

// Load resolves configuration, failing closed if a required dependency DSN is
// missing (a service that cannot reach its broker/DB/cache must not start).
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
	rateCfg, err := loadRateLimit()
	if err != nil {
		return Config{}, err
	}
	return Config{
		Addr:          listenAddr(),
		RabbitURL:     rabbitURL,
		AppDBURL:      appDB,
		Redis:         redisCfg,
		RateLimit:     rateCfg,
		ShutdownGrace: 15 * time.Second,
	}, nil
}

// loadRateLimit resolves the per-tenant rate-limit configuration from the
// environment, applying defaults and failing closed (returning an error) on a
// malformed RPS/burst/override so a typo never silently disables protection.
func loadRateLimit() (RateLimitConfig, error) {
	rps, err := envFloat(envRateRPS, defaultRateRPS)
	if err != nil {
		return RateLimitConfig{}, err
	}
	burst, err := envFloat(envRateBurst, defaultRateBurst)
	if err != nil {
		return RateLimitConfig{}, err
	}
	overrides, err := ratelimit.ParseOverrides(os.Getenv(envRateOverrides))
	if err != nil {
		return RateLimitConfig{}, err
	}
	return RateLimitConfig{
		Enabled:   envBool(envRateEnabled, true),
		FailOpen:  envBool(envRateFailOpen, true),
		Default:   ratelimit.Limits{Rate: rps, Burst: burst},
		Overrides: overrides,
	}, nil
}

func envFloat(key string, def float64) (float64, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	return strconv.ParseFloat(v, 64)
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func listenAddr() string {
	if a := os.Getenv("INGEST_HTTP_ADDR"); a != "" {
		return a
	}
	if p := os.Getenv("PORT"); p != "" {
		return ":" + p
	}
	return DefaultAddr
}
