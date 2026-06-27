// Package config loads ingest-service configuration from the environment. Every
// dependency DSN is sourced from the shared platform/broker helpers so the env
// var contract is defined once across services (DRY).
package config

import (
	"os"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
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
	// ShutdownGrace bounds in-flight request draining on shutdown.
	ShutdownGrace time.Duration
}

// DefaultAddr is the listen address when neither INGEST_HTTP_ADDR nor PORT is set.
const DefaultAddr = ":8080"

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
	return Config{
		Addr:          listenAddr(),
		RabbitURL:     rabbitURL,
		AppDBURL:      appDB,
		Redis:         redisCfg,
		ShutdownGrace: 15 * time.Second,
	}, nil
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
