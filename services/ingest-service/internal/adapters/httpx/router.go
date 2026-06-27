package httpx

import (
	"log/slog"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/ratelimit"
	"github.com/gin-gonic/gin"
)

// RateLimit bundles the per-tenant rate-limiter and its outage policy for the
// router. A nil Limiter disables rate limiting entirely (the middleware is not
// registered) — used by tests and by deployments that opt out via config.
type RateLimit struct {
	Limiter  ratelimit.Limiter
	FailOpen bool
}

// NewRouter wires the ingest HTTP surface: unauthenticated liveness/readiness
// probes, and an authenticated /v1/ingest behind the API-key middleware. The
// authenticated chain is ordered auth → rate-limit → publish: the tenant is
// established first, the per-tenant limit is enforced on the verified tenant, and
// only admitted requests reach the publish handler.
func NewRouter(h *Handler, authr kernel.Authenticator, rl RateLimit, log *slog.Logger) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(requestLogger(log))

	r.GET("/healthz", h.Healthz)
	r.GET("/readyz", h.Readyz)

	v1 := r.Group("/v1")
	v1.Use(AuthMiddleware(authr, log))
	if rl.Limiter != nil {
		v1.Use(RateLimitMiddleware(rl.Limiter, rl.FailOpen, log))
	}
	v1.POST("/ingest", h.Ingest)

	return r
}

// requestLogger emits one structured line per request. It logs method, path,
// status and latency only — never headers or bodies — so no credential or payload
// is ever written to logs (overview.md §logging, ADR-0007).
func requestLogger(log *slog.Logger) gin.HandlerFunc {
	if log == nil {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.InfoContext(c.Request.Context(), "http request",
			"method", c.Request.Method,
			"path", c.FullPath(),
			"status", c.Writer.Status(),
			"latency_ms", time.Since(start).Milliseconds(),
		)
	}
}
