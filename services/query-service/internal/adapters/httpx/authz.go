package httpx

import (
	"net/http"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/gin-gonic/gin"
)

// LogReadAuthzMiddleware is the defense-in-depth role/scope gate for the three
// log-content read endpoints (/v1/search, /v1/tail, /v1/panel-data). It runs
// AFTER AuthMiddleware has verified the credential and stashed a TenantContext,
// and BEFORE any handler that touches log data.
//
// Denial is 403 Forbidden (authenticated but not authorized), never 401.
//
// Two credential paths, coherently handled:
//
//   - JWT (control-plane session): tc.Role is set; tc.Scopes is empty.
//     Explicit allow-set: member and tenant_admin may read logs.
//     All other roles (including platform_operator) → 403.
//     Note: platform_operator is ALSO structurally rejected at the authn
//     boundary (JWTAuthenticator) with 401; this 403 is defense-in-depth.
//
//   - API key (lgk_): tc.Role is empty; tc.Scopes is set.
//     Allow: ingest:write (backward-compatible: all existing keys have this)
//     and logs:read (the forward-compatible explicit read scope, #76).
//     Any other combination of scopes → 403.
//
// A tc with neither Role nor Scopes (can only arise in tests or future
// credential types) is denied (fail-closed).
func LogReadAuthzMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		tc, ok := tenantFromGin(c)
		if !ok {
			// AuthMiddleware guarantees a tenant context before this runs; if
			// absent we must fail closed (never open).
			abortForbidden(c)
			return
		}
		if !canReadLogs(tc) {
			abortForbidden(c)
			return
		}
		c.Next()
	}
}

// canReadLogs reports whether tc is authorised to read tenant log content.
// It is pure and total: an unknown role or empty scopes yields false (fail
// closed). See LogReadAuthzMiddleware for the two-path credential model.
func canReadLogs(tc kernel.TenantContext) bool {
	if tc.Role != "" {
		// JWT path — role-based gate. Explicit allow-set; anything not in the
		// set is denied, including platform_operator (defense-in-depth over the
		// authn-level structural bar that already rejects it with 401).
		return tc.Role == kernel.RoleMember || tc.Role == kernel.RoleTenantAdmin
	}
	// API-key path — scope-based gate. ingest:write preserves the existing
	// semantic (all historically-issued keys carry this and can already read
	// logs). logs:read is the forward-compatible explicit read scope (#76).
	return tc.HasScope(kernel.ScopeIngestWrite) || tc.HasScope(kernel.ScopeLogsRead)
}

func abortForbidden(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusForbidden, errorBody("forbidden", "insufficient permissions to read log content"))
}
