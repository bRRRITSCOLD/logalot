// Command retention-worker enforces the two-tier retention policy (cold-tier.md §5.2):
//
//  1. Hot horizon: calls app.drop_log_events_partitions_older_than(hot_days) once
//     per cycle — O(1) partition DROP, default 30 days (ADR-0003 §5.2).
//
//  2. Cold horizon: for every tenant in retention_policies, deletes expired
//     S3 prefixes (tenant_id=<id>/dt=<date>/) whose dt is older than the
//     tenant's cold_days setting, default 365 days (ADR-0005).
//
// Flags stay OFF by default (COLD_ENABLED / COLD_SEARCH_ENABLED are AC#3 —
// deferred to the real-AWS smoke-test gate). This worker is independently
// deployable; it does not gate on the cold-search flag.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	pgadapter "github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/adapters/postgres"
	s3adapter "github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/adapters/s3"
	"github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/retention-worker/internal/config"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(log); err != nil {
		log.Error("retention-worker: fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Postgres pool as logalot_retention (BYPASSRLS — migration 000016).
	pool, err := platform.NewPool(ctx, cfg.RetentionDatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// S3 client — floci endpoint when AWS_ENDPOINT_URL is set (memory note:
	// this project uses floci, NOT localstack, endpoint :4566).
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return err
	}
	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.AWSEndpoint != "" {
			o.BaseEndpoint = &cfg.AWSEndpoint
			o.UsePathStyle = true // required for floci S3 path-style addressing
		}
	})

	// Wire adapters → ports.
	retStore := pgadapter.New(pool)    // PolicyStore + HotDropper
	purger := s3adapter.New(s3Client, cfg.ColdBucket)

	worker := app.New(retStore, retStore, purger,
		app.WithEnabled(cfg.Enabled), // kill-switch — default OFF (no-op cycles)
		app.WithDryRun(cfg.DryRun),
		app.WithHotDays(cfg.HotDays),
		app.WithInterval(cfg.Interval),
		app.WithLogger(log),
	)

	log.Info("retention-worker: starting",
		"enabled", cfg.Enabled,
		"dry_run", cfg.DryRun,
		"hot_days", cfg.HotDays,
		"cold_bucket", cfg.ColdBucket,
		"interval", cfg.Interval.String())

	if err := worker.Run(ctx); err != nil && ctx.Err() == nil {
		return err
	}
	log.Info("retention-worker: stopped")
	return nil
}
