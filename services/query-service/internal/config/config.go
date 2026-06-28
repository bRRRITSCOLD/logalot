// Package config loads query-service configuration from the environment. Every
// dependency DSN is sourced from the shared platform helpers so the env var
// contract is defined once across services (DRY).
package config

import (
	"fmt"
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
	// JWTSecret is the HS256 secret query-service uses to verify control-plane
	// UI session tokens. It MUST be the same value control-plane signs with
	// (JWT_SECRET) or every UI search/tail request 401s.
	JWTSecret string
	// ShutdownGrace bounds in-flight request draining on shutdown.
	ShutdownGrace time.Duration
}

// DefaultAddr is the listen address when neither QUERY_HTTP_ADDR nor PORT is set.
const DefaultAddr = ":8081"

// JWTSecretEnv is the env var carrying the shared HS256 session-token secret.
const JWTSecretEnv = "JWT_SECRET"

// MinJWTSecretLen mirrors control-plane's zod `min(16)` on JWT_SECRET
// (services/control-plane/src/config/env.ts) so a weak or missing secret fails
// query-service at startup rather than letting it run unable to verify any UI
// token. The two services share one secret; they must agree on the floor.
const MinJWTSecretLen = 16

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
	jwtSecret, err := jwtSecretFromEnv()
	if err != nil {
		return Config{}, err
	}
	return Config{
		Addr:          listenAddr(),
		AppDBURL:      appDB,
		Redis:         redisCfg,
		JWTSecret:     jwtSecret,
		ShutdownGrace: 15 * time.Second,
	}, nil
}

// jwtSecretFromEnv reads and validates JWT_SECRET, failing closed if it is unset
// or shorter than MinJWTSecretLen — a service that cannot verify UI tokens must
// not start (it would 401 every browser request silently).
func jwtSecretFromEnv() (string, error) {
	s := os.Getenv(JWTSecretEnv)
	if len(s) < MinJWTSecretLen {
		return "", fmt.Errorf("config: %s must be set and at least %d characters", JWTSecretEnv, MinJWTSecretLen)
	}
	return s, nil
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
