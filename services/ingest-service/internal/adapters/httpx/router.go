package httpx

import (
	"log/slog"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/gin-gonic/gin"
)

// NewRouter wires the ingest HTTP surface: unauthenticated liveness/readiness
// probes, and an authenticated /v1/ingest behind the API-key middleware.
func NewRouter(h *Handler, authr kernel.Authenticator, log *slog.Logger) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(requestLogger(log))

	r.GET("/healthz", h.Healthz)
	r.GET("/readyz", h.Readyz)

	v1 := r.Group("/v1")
	v1.Use(AuthMiddleware(authr, log))
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
