package httpx

import (
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/bRRRITSCOLD/logalot/services/ingest-service/internal/ratelimit"
	"github.com/gin-gonic/gin"
)

// RateLimitMiddleware enforces the per-tenant ingest limit on the accept path. It
// MUST be registered AFTER AuthMiddleware and BEFORE the publish handler
// (auth → rate-limit → validate/publish): it reads the tenant from the verified
// TenantContext that auth attached — NEVER from the request body — so the bucket
// is always keyed by the authenticated tenant (ADR-0002, ADR-0004).
//
// On over-limit it aborts 429 with a Retry-After header and a clear JSON error.
// Under the limit it calls Next() and the request proceeds to publish.
//
// failOpen selects the behaviour when the limiter backend (Redis) errors:
//   - failOpen=true (recommended default for ingest): admit the request and log a
//     warning. Availability of the ingest hot path is preferred over enforcing a
//     limit while the limiter store is down — a brief outage should not drop
//     otherwise-valid telemetry.
//   - failOpen=false: reject with 503 (the limiter dependency is unavailable; this
//     is NOT a 429, which would falsely imply the tenant exceeded its quota).
func RateLimitMiddleware(limiter ratelimit.Limiter, failOpen bool, log *slog.Logger) gin.HandlerFunc {
	if log == nil {
		log = slog.Default()
	}
	return func(c *gin.Context) {
		tc, ok := tenantFromGin(c)
		if !ok {
			// Defensive: auth runs first and guarantees a tenant. If it is missing
			// the middleware is mis-ordered; fail closed rather than admit unscoped.
			abortUnauthorized(c)
			return
		}

		d, err := limiter.Allow(tc, c.Request.Context())
		if err != nil {
			if failOpen {
				log.WarnContext(c.Request.Context(), "rate limiter unavailable; failing open",
					"tenant_id", string(tc.TenantID), "err", err)
				c.Next()
				return
			}
			log.ErrorContext(c.Request.Context(), "rate limiter unavailable; failing closed",
				"tenant_id", string(tc.TenantID), "err", err)
			c.AbortWithStatusJSON(http.StatusServiceUnavailable,
				errorBody("rate_limiter_unavailable", "rate limiter temporarily unavailable"))
			return
		}

		if !d.Allowed {
			c.Header("Retry-After", retryAfterSeconds(d))
			c.AbortWithStatusJSON(http.StatusTooManyRequests,
				errorBody("rate_limited", "per-tenant ingest rate limit exceeded; retry after the indicated delay"))
			return
		}

		c.Next()
	}
}

// retryAfterSeconds renders the Decision's RetryAfter as an HTTP Retry-After
// header value (whole seconds, RFC 7231), rounded up and never below 1 so a
// throttled client always backs off at least a second.
func retryAfterSeconds(d ratelimit.Decision) string {
	secs := int(math.Ceil(d.RetryAfter.Seconds()))
	if secs < 1 {
		secs = 1
	}
	return strconv.Itoa(secs)
}
