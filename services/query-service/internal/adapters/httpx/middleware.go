// Package httpx is the Gin transport adapter for query-service. It owns request
// parsing, authentication, and SSE framing at the edge, then delegates the
// streaming logic to the app core. Nothing here derives tenancy from user input
// (ADR-0002): the TenantContext is established only from a verified credential,
// and the tail channel is derived from THAT inside the TailBus adapter.
//
// Credential parsing uses pkg/httpkit.CredentialFromRequest — a shared, Gin-free
// pure function that is the single source of truth for Bearer/X-API-Key extraction
// across all logalot HTTP services (issue #39-M3).
package httpx

import (
	"log/slog"
	"net/http"

	"github.com/bRRRITSCOLD/logalot/pkg/httpkit"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/gin-gonic/gin"
)

// ginTenantKey is the gin.Context key the auth middleware stashes the verified
// TenantContext under. The request context also carries it via kernel.WithTenant.
const ginTenantKey = "logalot.tenant"

// AuthMiddleware authenticates the presented credential into a TenantContext and
// attaches it to the request BEFORE any handler (and therefore before any
// Subscribe) runs. On a missing/invalid credential it aborts 401 with an opaque
// message — so no subscribe ever happens on a bad credential (load-bearing:
// auth-before-subscribe). The Authenticator port is the only auth dependency, so
// swapping API-key auth for JWT is a constructor change, not an edge change.
func AuthMiddleware(authr kernel.Authenticator, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		cred, ok := httpkit.CredentialFromRequest(c.Request)
		if !ok {
			abortUnauthorized(c)
			return
		}
		tc, err := authr.Authenticate(c.Request.Context(), cred)
		if err != nil {
			// Distinct auth errors are for server logs only; the client gets one
			// opaque 401 (no malformed-vs-unknown oracle).
			log.WarnContext(c.Request.Context(), "query auth rejected", "err", err)
			abortUnauthorized(c)
			return
		}
		// Propagate the verified scope explicitly down the call stack (§6).
		c.Request = c.Request.WithContext(kernel.WithTenant(c.Request.Context(), tc))
		c.Set(ginTenantKey, tc)
		c.Next()
	}
}

// tenantFromGin recovers the verified TenantContext attached by AuthMiddleware.
func tenantFromGin(c *gin.Context) (kernel.TenantContext, bool) {
	if v, ok := c.Get(ginTenantKey); ok {
		if tc, ok := v.(kernel.TenantContext); ok {
			return tc, true
		}
	}
	return kernel.FromContext(c.Request.Context())
}

func abortUnauthorized(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, errorBody("unauthorized", "invalid credentials"))
}

func errorBody(code, message string) gin.H {
	return gin.H{"error": gin.H{"code": code, "message": message}}
}
