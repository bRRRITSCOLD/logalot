// Package httpx is the Gin transport adapter for query-service. It owns request
// parsing, authentication, and SSE framing at the edge, then delegates the
// streaming logic to the app core. Nothing here derives tenancy from user input
// (ADR-0002): the TenantContext is established only from a verified credential,
// and the tail channel is derived from THAT inside the TailBus adapter.
//
// The auth middleware mirrors ingest-service's by intent (DRY-with-copy): it is a
// few lines over the shared kernel.Authenticator port, so duplicating it keeps
// each service's edge self-contained rather than introducing a shared
// transport-coupling package for almost no code. The Authenticator port stays
// swappable, so the wave-2 JWT session authenticator slots in with no edge change.
package httpx

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/gin-gonic/gin"
)

// ginTenantKey is the gin.Context key the auth middleware stashes the verified
// TenantContext under. The request context also carries it via kernel.WithTenant.
const ginTenantKey = "logalot.tenant"

const bearerPrefix = "Bearer "

// credentialFromRequest extracts a credential from either
// `Authorization: Bearer <key>` or `X-API-Key: <key>`. For the slice this is an
// ingest API key; a wave-2 JWT authenticator would read the same Bearer header.
// ok is false when neither is present so the caller fails closed with 401.
func credentialFromRequest(r *http.Request) (kernel.Credential, bool) {
	if h := r.Header.Get("Authorization"); h != "" {
		if len(h) > len(bearerPrefix) && strings.EqualFold(h[:len(bearerPrefix)], bearerPrefix) {
			if key := strings.TrimSpace(h[len(bearerPrefix):]); key != "" {
				return kernel.Credential{APIKey: key}, true
			}
		}
	}
	if k := strings.TrimSpace(r.Header.Get("X-API-Key")); k != "" {
		return kernel.Credential{APIKey: k}, true
	}
	return kernel.Credential{}, false
}

// AuthMiddleware authenticates the presented credential into a TenantContext and
// attaches it to the request BEFORE any handler (and therefore before any
// Subscribe) runs. On a missing/invalid credential it aborts 401 with an opaque
// message — so no subscribe ever happens on a bad credential (load-bearing:
// auth-before-subscribe). The Authenticator port is the only auth dependency, so
// swapping API-key auth for JWT is a constructor change, not an edge change.
func AuthMiddleware(authr kernel.Authenticator, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		cred, ok := credentialFromRequest(c.Request)
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
