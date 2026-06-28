// Command processor is the Log Processing worker (ADR-0001): it consumes ingest
// envelopes from RabbitMQ, normalizes each to a LogEvent, persists it to the hot
// store under the tenant's RLS context, fans it out to the live-tail bus on
// tail:{tenant_id} (overview.md §5.2, ADR-0006), and tees each event to the
// cold-tier S3 Parquet archive when COLD_ENABLED=true (ADR-0005, decision 016).
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awscreds "github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/athena"
	"github.com/aws/aws-sdk-go-v2/service/glue"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/broker"
	"github.com/bRRRITSCOLD/logalot/pkg/coldstore"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/pkg/logstore"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/pkg/tailbus"
	"github.com/bRRRITSCOLD/logalot/services/processor/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/processor/internal/config"

	aws "github.com/aws/aws-sdk-go-v2/aws"
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

	// One lifecycle context cancelled on SIGINT/SIGTERM. The broker's Consume loop
	// exits when ctx is cancelled; the single in-flight handleDelivery call (if
	// any) runs to completion before Consume returns, because handleDelivery is
	// synchronous inside the select. The processor persist uses context.WithoutCancel
	// so the in-flight DB write is not aborted by the cancellation signal — a
	// shutdown is never misrouted to the DLQ as a poison message (issue #37).
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

	svcOpts := []app.Option{
		app.WithLogger(log),
		app.WithRetry(cfg.MaxRetries, cfg.RetryBackoff),
		app.WithDrainTimeout(cfg.DrainTimeout),
	}

	// Wire the cold-tier tee when COLD_ENABLED=true (decision 016 §6: feature-
	// flagged OFF by default until the real-AWS smoke test passes).
	if cfg.ColdEnabled {
		coldArchive, err := buildColdStore(startCtx, cfg, log)
		if err != nil {
			return err
		}
		svcOpts = append(svcOpts, app.WithColdArchive(coldArchive))
		log.Info("cold-tier tee enabled",
			"bucket", cfg.ColdBucket, "glue_db", cfg.ColdGlueDB)
	} else {
		log.Info("cold-tier tee disabled (COLD_ENABLED not set)")
	}

	svc := app.New(store, tail, svcOpts...)

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

// buildColdStore constructs the coldstore.Store with AWS clients. When
// FLOCI_ENDPOINT is set (local dev against floci), the clients are pointed at
// that endpoint with static credentials; otherwise they use the default AWS
// credential chain (IAM role in production).
func buildColdStore(ctx context.Context, cfg config.Config, log *slog.Logger) (*coldstore.Store, error) {
	var loadOpts []func(*awsconfig.LoadOptions) error
	loadOpts = append(loadOpts, awsconfig.WithRegion(cfg.AWSRegion))

	if cfg.FlociEndpoint != "" {
		log.Info("cold-tier using floci endpoint", "endpoint", cfg.FlociEndpoint)
		loadOpts = append(loadOpts,
			awsconfig.WithCredentialsProvider(awscreds.NewStaticCredentialsProvider("test", "test", "")),
			awsconfig.WithEndpointResolver( //nolint:staticcheck
				aws.EndpointResolverFunc( //nolint:staticcheck
					func(_, _ string) (aws.Endpoint, error) { //nolint:staticcheck
						return aws.Endpoint{ //nolint:staticcheck
							URL:               cfg.FlociEndpoint,
							SigningRegion:     cfg.AWSRegion,
							HostnameImmutable: true,
						}, nil
					}),
			),
		)
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, err
	}

	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.FlociEndpoint != "" {
			o.UsePathStyle = true // required for floci path-style S3
		}
	})
	glueClient := glue.NewFromConfig(awsCfg)
	athenaClient := athena.NewFromConfig(awsCfg)

	cs := coldstore.New(
		s3Client,
		glueClient,
		athenaClient,
		cfg.ColdBucket,
		cfg.ColdGlueDB,
		cfg.ColdAthenaResultBucket,
		coldstore.WithLogger(log),
		coldstore.WithWorkgroup(cfg.ColdAthenaWorkgroup),
		// Cold search stays OFF (feature-flagged). The processor only calls
		// Archive; Search is gated separately in the query-service (decision 016 §6).
	)
	return cs, nil
}
