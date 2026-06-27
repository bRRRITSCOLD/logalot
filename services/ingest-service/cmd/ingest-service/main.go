// Command ingest-service is the throughput-critical ingest edge (ADR-0004): it
// authenticates an API key, validates the event(s), and publishes a durable
// envelope to RabbitMQ, returning 202 only after a publisher confirm.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/auth"
	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/adapters/httpx"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/config"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/ratelimit"
	"github.com/redis/go-redis/v9"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(log); err != nil {
		log.Error("ingest-service exited with error", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Cancel on SIGINT/SIGTERM so startup and shutdown share one lifecycle ctx.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	pool, err := platform.NewPool(startCtx, cfg.AppDBURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	rc, err := platform.NewRedisClient(startCtx, cfg.Redis)
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()

	b, err := broker.New(startCtx, cfg.RabbitURL, broker.WithLogger(log))
	if err != nil {
		return err
	}
	defer func() { _ = b.Close() }()
	log.Info("broker topology declared",
		"exchange", b.Topology().Exchange,
		"queue", b.Topology().Queue,
		"dlx", b.Topology().DeadLetterExchange,
		"dlq", b.Topology().DeadLetterQueue,
	)

	authr := auth.New(pool, rc, auth.WithLogger(log))
	svc := app.New(b, app.WithLogger(log))
	handler := httpx.NewHandler(svc, readiness(b, pool, rc), log)

	// Per-tenant ingest rate limiter (ADR-0004): a Redis token bucket on the
	// accept path, after auth, keyed by the authenticated tenant. Disabled via
	// INGEST_RATE_LIMIT_ENABLED=false (then NewRouter wires no limiter middleware).
	var rl httpx.RateLimit
	if cfg.RateLimit.Enabled {
		resolver := ratelimit.NewStaticResolver(cfg.RateLimit.Default, cfg.RateLimit.Overrides)
		rl = httpx.RateLimit{
			Limiter:  ratelimit.NewRedisLimiter(rc, resolver),
			FailOpen: cfg.RateLimit.FailOpen,
		}
		log.Info("per-tenant ingest rate limiting enabled",
			"default_rps", cfg.RateLimit.Default.Rate,
			"default_burst", cfg.RateLimit.Default.Burst,
			"overrides", len(cfg.RateLimit.Overrides),
			"fail_open", cfg.RateLimit.FailOpen,
		)
	} else {
		log.Warn("per-tenant ingest rate limiting DISABLED (INGEST_RATE_LIMIT_ENABLED=false)")
	}

	router := httpx.NewRouter(handler, authr, rl, log)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("ingest-service listening", "addr", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutdown signal received; draining")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
		defer shutdownCancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// readiness reports whether every downstream dependency is reachable. It is the
// /readyz body: broker connection, Postgres, and Redis must all be live.
func readiness(b *broker.Broker, pool interface{ Ping(context.Context) error }, rc *redis.Client) func(context.Context) error {
	return func(ctx context.Context) error {
		if err := b.Check(ctx); err != nil {
			return err
		}
		if err := pool.Ping(ctx); err != nil {
			return err
		}
		return rc.Ping(ctx).Err()
	}
}
