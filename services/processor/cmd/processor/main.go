// Command processor is the Log Processing worker (ADR-0001): it consumes ingest
// envelopes from RabbitMQ, normalizes each to a LogEvent, persists it to the hot
// store under the tenant's RLS context, and fans it out to the live-tail bus on
// tail:{tenant_id} (overview.md §5.2, ADR-0006). The cold-tier tee is out of
// scope here (#17).
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/logstore"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/pkg/tailbus"
	"github.com/bRRRITSCOLD/logalot/services/processor/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/processor/internal/config"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(log); err != nil {
		log.Error("processor exited with error", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// One lifecycle context cancelled on SIGINT/SIGTERM. Consume blocks on it and
	// returns when it is cancelled, draining in-flight deliveries cleanly (each
	// in-flight handler finishes its persist+ack/nack before Consume returns).
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

	b, err := broker.New(startCtx, cfg.RabbitURL, broker.WithLogger(log), broker.WithPrefetch(cfg.Prefetch))
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

	store := logstore.New(pool)
	tail := tailbus.New(rc, tailbus.WithLogger(log))
	svc := app.New(store, tail,
		app.WithLogger(log),
		app.WithRetry(cfg.MaxRetries, cfg.RetryBackoff),
	)

	// The consuming identity is a platform worker; the broker rebuilds a fresh
	// per-message TenantContext from each envelope's authoritative tenant_id and
	// passes THAT to the handler (kernel ports.go).
	consumerTC := kernel.TenantContext{Role: kernel.RolePlatformOperator}

	log.Info("processor consuming", "queue", b.Topology().Queue, "prefetch", cfg.Prefetch)
	err = b.Consume(consumerTC, ctx, svc.Handle)
	if errors.Is(err, context.Canceled) {
		log.Info("shutdown signal received; drained and exiting")
		return nil
	}
	return err
}
