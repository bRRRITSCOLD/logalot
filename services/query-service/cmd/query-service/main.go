// Command query-service serves the tenant-scoped read surface. For the wave-1
// slice that is live tail (ADR-0006): an authenticated SSE client on GET /v1/tail
// receives its tenant's new log events, sourced from Redis pub/sub `tail:{tenant}`.
// Search (#10) lands beside it over the LogStore port.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	athenaaws "github.com/aws/aws-sdk-go-v2/service/athena"
	glueaws "github.com/aws/aws-sdk-go-v2/service/glue"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/auth"
	"github.com/bRRRITSCOLD/logalot/pkg/coldstore"
	"github.com/bRRRITSCOLD/logalot/pkg/logstore"
	"github.com/bRRRITSCOLD/logalot/pkg/platform"
	"github.com/bRRRITSCOLD/logalot/pkg/tailbus"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/adapters/authn"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/adapters/httpx"
	pgadapter "github.com/bRRRITSCOLD/logalot/services/query-service/internal/adapters/postgres"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/config"
	"github.com/redis/go-redis/v9"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(log); err != nil {
		log.Error("query-service exited with error", "err", err)
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

	// Authenticator is the swappable port. The UI calls query-service with the
	// user's control-plane session JWT, while ingest/dev tooling presents an
	// `lgk_` API key — so the edge accepts BOTH via a composite that routes by
	// credential shape (issue #74): an lgk_ key -> the RLS-backed API-key
	// authenticator; anything else -> the HS256 JWT verifier. Both fail closed.
	apiKeyAuthr := auth.New(pool, rc, auth.WithLogger(log))
	jwtAuthr, err := authn.NewJWT(cfg.JWTSecret)
	if err != nil {
		return err
	}
	authr := authn.NewComposite(apiKeyAuthr, jwtAuthr)
	bus := tailbus.New(rc, tailbus.WithLogger(log))
	svc := app.New(bus, app.WithLogger(log))

	// Hot log store: RLS-governed logalot_app pool.
	hotStore := logstore.New(pool)

	// Cold-read routing (AC#2 / ADR-0003 / cold-tier.md §5.2).
	// Gated on COLD_SEARCH_ENABLED (default FALSE, AC#3 deferred).
	// When false, TieredSearcher routes ALL traffic to hot — no-op in production.
	var coldArchive *coldstore.Store
	if cfg.ColdSearchEnabled {
		log.Info("query-service: COLD_SEARCH_ENABLED=true — wiring cold-read path",
			"hot_days", cfg.HotDays, "cold_bucket", cfg.ColdS3Bucket)

		awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return fmt.Errorf("cold-read: load AWS config: %w", err)
		}
		s3c := awss3.NewFromConfig(awsCfg, func(o *awss3.Options) {
			if cfg.AWSEndpoint != "" {
				o.BaseEndpoint = &cfg.AWSEndpoint
				o.UsePathStyle = true // required for floci path-style addressing
			}
		})
		gluec := glueaws.NewFromConfig(awsCfg, func(o *glueaws.Options) {
			if cfg.AWSEndpoint != "" {
				o.BaseEndpoint = &cfg.AWSEndpoint
			}
		})
		athenac := athenaaws.NewFromConfig(awsCfg, func(o *athenaaws.Options) {
			if cfg.AWSEndpoint != "" {
				o.BaseEndpoint = &cfg.AWSEndpoint
			}
		})
		coldArchive = coldstore.New(
			s3c, gluec, athenac,
			cfg.ColdS3Bucket, cfg.ColdGlueDB, cfg.ColdAthenaResultBucket,
			coldstore.WithSearchEnabled(true), // inner flag: enabled because outer flag is true
			coldstore.WithLogger(log),
		)
	}

	// TieredSearcher: routes hot/cold/both based on the query window.
	// When coldArchive=nil (flag off), TieredSearcher is a thin pass-through to hot.
	searcher := app.NewTieredSearcher(hotStore, coldArchive, cfg.HotDays, cfg.ColdSearchEnabled,
		app.WithTieredLogger(log),
	)

	// Panel-data: saved_query resolution + log aggregation, same RLS-governed pool.
	panelStore := pgadapter.NewPanelStore(pool)
	panelSvc := app.NewPanelService(panelStore)
	handler := httpx.NewHandler(svc, searcher, panelSvc, readiness(rc), log)
	router := httpx.NewRouter(handler, authr, log)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		// Tie every request context to the lifecycle ctx so SIGTERM cancels
		// in-flight SSE streams; handlers then return and Shutdown drains
		// promptly instead of blocking the full grace on long-lived tails.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("query-service listening", "addr", cfg.Addr)
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

// readiness reports whether Redis (the tail bus + key cache) is reachable. It is
// the /readyz body.
func readiness(rc *redis.Client) func(context.Context) error {
	return func(ctx context.Context) error {
		return rc.Ping(ctx).Err()
	}
}
