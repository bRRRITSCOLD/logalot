// Package httpx is the Gin transport adapter for ingest-service. It owns request
// parsing, validation, and authentication at the edge, then delegates the
// security-critical work (envelope construction + durable publish) to the app
// core. Nothing here trusts a tenant from the request body (ADR-0002): the
// TenantContext is established only from a verified credential.
package httpx

import (
	"log/slog"
	"net/http"

	"github.com/bRRRITSCOLD/logalot/pkg/httpkit"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/gin-gonic/gin"
)

// ginTenantKey is the gin.Context key the auth middleware stashes the verified
// TenantContext under, for handlers that prefer the gin accessor over the request
// context. The request context also carries it via kernel.WithTenant.
const ginTenantKey = "logalot.tenant"

// AuthMiddleware authenticates the presented credential into a TenantContext and
// attaches it to the request before any work happens. On a missing/invalid
// credential it aborts with 401 (opaque message — no malformed-vs-unknown oracle,
// matching the auth package's enumeration-defense contract). A valid key lacking
// the ingest:write scope is rejected 403.
//
// Defense-in-depth (#35-M3): tc.Valid() is called after Authenticate to ensure a
// malformed TenantID returned by the Authenticator is rejected as 401 here rather
// than surfacing as a 503 (broker error) deeper in the pipeline.
func AuthMiddleware(authr kernel.Authenticator, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		cred, ok := httpkit.CredentialFromRequest(c.Request)
		if !ok {
			abortUnauthorized(c)
			return
		}
		tc, err := authr.Authenticate(c.Request.Context(), cred)
		if err != nil {
			// Distinct auth errors exist for server logs only; the client gets one
			// opaque 401 (auth/errors.go contract).
			log.WarnContext(c.Request.Context(), "ingest auth rejected", "err", err)
			abortUnauthorized(c)
			return
		}
		// Defense-in-depth: a structurally invalid TenantContext returned by the
		// Authenticator (e.g., a malformed UUID in a stored row) must not leak to
		// the broker/publish path where it would surface as a misleading 503.
		if err := tc.Valid(); err != nil {
			log.WarnContext(c.Request.Context(), "ingest auth returned invalid tenant context", "err", err)
			abortUnauthorized(c)
			return
		}
		if !tc.HasScope(kernel.ScopeIngestWrite) {
			abortForbidden(c)
			return
		}
		// Propagate the scope explicitly down the call stack (overview.md §6).
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

func abortForbidden(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusForbidden, errorBody("forbidden", "credential lacks ingest:write scope"))
}

func errorBody(code, message string) gin.H {
	return gin.H{"error": gin.H{"code": code, "message": message}}
}
