// Command alert-evaluator is the Alerting context's evaluation worker (ADR-0001).
// On a schedule it finds due alert rules across all tenants (via the BYPASSRLS
// logalot_evaluator role — metadata only), counts each rule's matching log_events
// over its window UNDER the rule's per-tenant RLS context (via logalot_app),
// transitions state, and dispatches exactly one notification per transition.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/adapters/notify"
	pgadapter "github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/adapters/postgres"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/config"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(log); err != nil {
		log.Error("alert-evaluator: fatal", "err", err)
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

	// Two pools, two roles — the tenant-isolation boundary (model.md §4.5).
	metaPool, err := platform.NewPool(ctx, cfg.EvaluatorDatabaseURL)
	if err != nil {
		return err
	}
	defer metaPool.Close()

	appPool, err := platform.NewPool(ctx, cfg.AppDatabaseURL)
	if err != nil {
		return err
	}
	defer appPool.Close()

	rules := pgadapter.NewRuleStore(metaPool, pgadapter.WithLogger(log))
	counter := pgadapter.NewLogCounter(appPool)

	notifier, err := buildNotifier(ctx, cfg, log)
	if err != nil {
		return err
	}

	ev := app.New(rules, counter, notifier,
		app.WithLogger(log),
		app.WithInterval(cfg.Interval),
		app.WithBatchSize(cfg.BatchSize),
	)

	log.Info("alert-evaluator: starting", "interval", cfg.Interval.String(),
		"batch_size", cfg.BatchSize, "notifier", cfg.Notifier)

	if err := ev.Run(ctx); err != nil && ctx.Err() == nil {
		return err
	}
	log.Info("alert-evaluator: stopped")
	return nil
}

// buildNotifier selects the Notifier adapter from config. logsink is the default
// (auditable, no external dependency); sns dispatches via floci/AWS SNS.
func buildNotifier(ctx context.Context, cfg config.Config, log *slog.Logger) (app.Notifier, error) {
	if cfg.Notifier == "sns" {
		opts := []func(*awsconfig.LoadOptions) error{}
		awsCfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
		if err != nil {
			return nil, err
		}
		client := sns.NewFromConfig(awsCfg, func(o *sns.Options) {
			if cfg.AWSEndpoint != "" {
				o.BaseEndpoint = &cfg.AWSEndpoint // point at floci
			}
		})
		return notify.NewSNS(client, cfg.SNSTopicARN, log), nil
	}
	return notify.NewLogSink(log), nil
}
