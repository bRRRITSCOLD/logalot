// Package config loads query-service configuration from the environment. Every
// dependency DSN is sourced from the shared platform helpers so the env var
// contract is defined once across services (DRY).
package config

import (
	"fmt"
	"os"
	"strconv"
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

	// Cold-read routing (AC#2 / ADR-0003 / cold-tier.md §5.2).
	// COLD_SEARCH_ENABLED is now true in production — cold_smoke_aws CI gate
	// passed; query-service routes searches > HotDays to Athena (closes #63 AC#3).

	// ColdSearchEnabled gates cold-read routing (COLD_SEARCH_ENABLED env var).
	// Default TRUE in production (docker-compose.aws.yml / user-data.sh.tftpl).
	// Set to "false" to fall back to Postgres-only path for debugging.
	ColdSearchEnabled bool
	// HotDays is the global hot-partition horizon for routing decisions.
	// Default 30 (app.DefaultHotDays). Used only when ColdSearchEnabled=true.
	HotDays int
	// ColdS3Bucket is the S3 cold-tier bucket (COLD_S3_BUCKET env var).
	// Required only when ColdSearchEnabled=true.
	ColdS3Bucket string
	// ColdGlueDB is the Glue database (COLD_GLUE_DB env var).
	// Required only when ColdSearchEnabled=true.
	ColdGlueDB string
	// ColdAthenaResultBucket is the Athena output S3 location
	// (COLD_ATHENA_RESULT_BUCKET env var). Required only when
	// ColdSearchEnabled=true.
	ColdAthenaResultBucket string
	// AWSEndpoint is an optional AWS endpoint override (AWS_ENDPOINT_URL env
	// var) — points at floci for local dev (endpoint :4566, image floci/floci).
	AWSEndpoint string
}

// DefaultAddr is the listen address when neither QUERY_HTTP_ADDR nor PORT is set.
const DefaultAddr = ":8081"

// JWTSecretEnv is the env var carrying the shared HS256 session-token secret.
const JWTSecretEnv = "JWT_SECRET"

// Cold-read routing env var names.
const (
	// ColdSearchEnabledEnv gates cold-read routing.
	// Enabled (true) in docker-compose.aws.yml after cold_smoke_aws CI gate passed (closes #63 AC#3).
	ColdSearchEnabledEnv = "COLD_SEARCH_ENABLED"
	// HotDaysEnv overrides the hot-partition routing horizon. Default: 30.
	HotDaysEnv = "HOT_RETENTION_DAYS"
	// ColdS3BucketEnv is the S3 cold-tier bucket name.
	ColdS3BucketEnv = "COLD_S3_BUCKET"
	// ColdGlueDBEnv is the Glue database name.
	ColdGlueDBEnv = "COLD_GLUE_DB"
	// ColdAthenaResultBucketEnv is the Athena output S3 URL.
	ColdAthenaResultBucketEnv = "COLD_ATHENA_RESULT_BUCKET"
	// AWSEndpointEnv is the AWS endpoint override (floci for local dev).
	AWSEndpointEnv = "AWS_ENDPOINT_URL"
)

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

	cfg := Config{
		Addr:          listenAddr(),
		AppDBURL:      appDB,
		Redis:         redisCfg,
		JWTSecret:     jwtSecret,
		ShutdownGrace: 15 * time.Second,

		// Cold-read defaults: flag OFF, no AWS config required.
		ColdSearchEnabled:      false,
		HotDays:                30,
		ColdS3Bucket:           os.Getenv(ColdS3BucketEnv),
		ColdGlueDB:             os.Getenv(ColdGlueDBEnv),
		ColdAthenaResultBucket: os.Getenv(ColdAthenaResultBucketEnv),
		AWSEndpoint:            os.Getenv(AWSEndpointEnv),
	}

	// Parse COLD_SEARCH_ENABLED (string "true" → bool true; anything else → false).
	if v := os.Getenv(ColdSearchEnabledEnv); v == "true" {
		cfg.ColdSearchEnabled = true
	}

	// HOT_RETENTION_DAYS override.
	if v := os.Getenv(HotDaysEnv); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("config: %s must be a positive int, got %q", HotDaysEnv, v)
		}
		cfg.HotDays = n
	}

	// When cold search is enabled, the cold AWS config must be present.
	if cfg.ColdSearchEnabled {
		if cfg.ColdS3Bucket == "" {
			return Config{}, fmt.Errorf("config: %s is required when %s=true", ColdS3BucketEnv, ColdSearchEnabledEnv)
		}
		if cfg.ColdGlueDB == "" {
			return Config{}, fmt.Errorf("config: %s is required when %s=true", ColdGlueDBEnv, ColdSearchEnabledEnv)
		}
		if cfg.ColdAthenaResultBucket == "" {
			return Config{}, fmt.Errorf("config: %s is required when %s=true", ColdAthenaResultBucketEnv, ColdSearchEnabledEnv)
		}
	}

	return cfg, nil
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
