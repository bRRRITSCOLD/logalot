// Package config loads query-service configuration from the environment. Every
// dependency DSN is sourced from the shared platform helpers so the env var
// contract is defined once across services (DRY).
package config

import (
	"os"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/platform"
)

// Config is the resolved query-service configuration.
type Config struct {
	// Addr is the HTTP listen address (host:port).
	Addr string
	// AppDBURL is the NOSUPERUSER logalot_app Postgres DSN (RLS-governed), used by
	// the API-key Authenticator's key lookups.
	AppDBURL string
	// Redis is the pub/sub (tail bus) + key-cache Redis connection.
	Redis platform.RedisConfig
	// ShutdownGrace bounds in-flight request draining on shutdown.
	ShutdownGrace time.Duration
}

// DefaultAddr is the listen address when neither QUERY_HTTP_ADDR nor PORT is set.
const DefaultAddr = ":8081"

// Load resolves configuration, failing closed if a required dependency DSN is
// missing (a service that cannot reach its DB/cache/bus must not start).
func Load() (Config, error) {
	appDB, err := platform.AppDatabaseURL()
	if err != nil {
		return Config{}, err
	}
	redisCfg, err := platform.RedisConfigFromEnv()
	if err != nil {
		return Config{}, err
	}
	return Config{
		Addr:          listenAddr(),
		AppDBURL:      appDB,
		Redis:         redisCfg,
		ShutdownGrace: 15 * time.Second,
	}, nil
}

func listenAddr() string {
	if a := os.Getenv("QUERY_HTTP_ADDR"); a != "" {
		return a
	}
	if p := os.Getenv("PORT"); p != "" {
		return ":" + p
	}
	return DefaultAddr
}
