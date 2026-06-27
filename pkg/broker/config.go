package broker

import (
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"time"
)

// Environment variables for broker connection. RABBITMQ_URL is authoritative;
// the host/port/user/pass parts are a convenience fallback that mirrors the
// docker-compose service env (.env.example §RabbitMQ).
const (
	URLEnv      = "RABBITMQ_URL"
	HostEnv     = "RABBITMQ_HOST"
	PortEnv     = "RABBITMQ_PORT"
	UserEnv     = "RABBITMQ_DEFAULT_USER"
	PasswordEnv = "RABBITMQ_DEFAULT_PASS"
)

// Defaults for the publisher channel pool and consumer prefetch. Conservative,
// correctness-first values; tune with measurements, not guesses (ADR-0004).
const (
	defaultPoolSize = 8
	defaultPrefetch = 64
)

// URLFromEnv resolves the AMQP URL. It prefers RABBITMQ_URL; otherwise it
// assembles one from RABBITMQ_HOST/RABBITMQ_PORT (+ optional user/pass). Fail
// closed: with neither a URL nor host+port, it errors rather than dialling a
// default that could point anywhere.
func URLFromEnv() (string, error) {
	if u := os.Getenv(URLEnv); u != "" {
		return u, nil
	}
	host, port := os.Getenv(HostEnv), os.Getenv(PortEnv)
	if host == "" || port == "" {
		return "", fmt.Errorf("broker: %s not set and %s/%s fallback incomplete", URLEnv, HostEnv, PortEnv)
	}
	u := url.URL{Scheme: "amqp", Host: host + ":" + port, Path: "/"}
	if user := os.Getenv(UserEnv); user != "" {
		u.User = url.UserPassword(user, os.Getenv(PasswordEnv))
	}
	return u.String(), nil
}

// Option configures a Broker.
type Option func(*config)

type config struct {
	topo     Topology
	log      *slog.Logger
	now      func() time.Time
	declare  bool
	poolSize int
	prefetch int
}

// WithTopology overrides the default ingest topology names (used by tests).
func WithTopology(t Topology) Option { return func(c *config) { c.topo = t } }

// WithLogger sets the structured logger (defaults to a discard logger).
func WithLogger(l *slog.Logger) Option { return func(c *config) { c.log = l } }

// WithClock injects a clock for deterministic ReceivedAt defaulting in tests.
func WithClock(now func() time.Time) Option { return func(c *config) { c.now = now } }

// WithoutTopologyDeclaration skips DeclareTopology on New. Use when the topology
// is provisioned out-of-band; by default New declares it (safe + idempotent).
func WithoutTopologyDeclaration() Option { return func(c *config) { c.declare = false } }

// WithPublisherPoolSize bounds the confirm-mode channel free-list.
func WithPublisherPoolSize(n int) Option { return func(c *config) { c.poolSize = n } }

// WithPrefetch sets the consumer QoS prefetch count.
func WithPrefetch(n int) Option { return func(c *config) { c.prefetch = n } }

func resolveConfig(opts ...Option) config {
	cfg := config{
		topo:     DefaultTopology(),
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:      time.Now,
		declare:  true,
		poolSize: defaultPoolSize,
		prefetch: defaultPrefetch,
	}
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.log == nil {
		cfg.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	if cfg.poolSize <= 0 {
		cfg.poolSize = defaultPoolSize
	}
	if cfg.prefetch <= 0 {
		cfg.prefetch = defaultPrefetch
	}
	return cfg
}
