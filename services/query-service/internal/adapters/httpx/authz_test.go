package httpx

// authz_test.go covers the defense-in-depth role/scope gate added in #76.
//
// Test matrix:
//   - canReadLogs() — unit tests covering every (role/scope) × (allow/deny) case
//   - LogReadAuthzMiddleware — integration tests over the wired router confirming
//     403 vs 200 for every significant credential variant, across all three
//     log-content endpoints (/v1/search, /v1/tail, /v1/panel-data).
//
// The stubAuth type (defined in handler_test.go) is reused here. We inject
// tenantContexts directly so the tests exercise the authz layer independently of
// the authn layer — proving defense-in-depth rather than just authn coverage.

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
)

// ---------------------------------------------------------------------------
// canReadLogs unit tests
// ---------------------------------------------------------------------------

// TestCanReadLogs_JWTPath covers the role-based allow/deny matrix for JWT
// credentials (tc.Role set, tc.Scopes empty).
func TestCanReadLogs_JWTPath(t *testing.T) {
	cases := []struct {
		name  string
		role  kernel.Role
		allow bool
	}{
		// Allow-set: member and tenant_admin are the legitimate log readers.
		{"member allowed", kernel.RoleMember, true},
		{"tenant_admin allowed", kernel.RoleTenantAdmin, true},

		// Deny: platform_operator is structurally barred from tenant log
		// content (ADR-0007 / kernel NFR-5.4). Authn rejects it with 401;
		// authz also denies it for defense-in-depth.
		{"platform_operator denied", kernel.RolePlatformOperator, false},

		// Deny: an unrecognised role (e.g. future role added to the control-plane
		// before query-service is updated) must fail closed.
		{"unknown role denied", kernel.Role("super_admin"), false},

		// Deny: an empty role with no scopes is an uninitialized TenantContext
		// (should never reach authz but must fail closed).
		{"empty role denied", kernel.Role(""), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			principal := kernel.TenantContext{
				TenantID: kernel.TenantID(keyTenant),
				Role:     tc.role,
				// Scopes intentionally empty: this is the JWT path.
			}
			got := canReadLogs(principal)
			if got != tc.allow {
				t.Errorf("canReadLogs(role=%q) = %v, want %v", tc.role, got, tc.allow)
			}
		})
	}
}

// TestCanReadLogs_APIKeyPath covers the scope-based allow/deny matrix for
// API-key credentials (tc.Role empty, tc.Scopes set).
//
// As of #82 the back-compat grant is retired: ingest:write no longer satisfies
// the log-read gate. Read consumers must carry logs:read explicitly.
func TestCanReadLogs_APIKeyPath(t *testing.T) {
	cases := []struct {
		name   string
		scopes []kernel.Scope
		allow  bool
	}{
		// DENY (#82): ingest:write is a WRITE scope only. Existing ingest-only
		// keys lose log-read access; they must be re-issued with logs:read.
		{"ingest:write alone denied", []kernel.Scope{kernel.ScopeIngestWrite}, false},

		// Allow: logs:read is the explicit read scope required since #82.
		{"logs:read allowed", []kernel.Scope{kernel.ScopeLogsRead}, true},

		// Allow: a key that carries both (e.g. an ingest+read combo key).
		{"ingest:write + logs:read allowed", []kernel.Scope{kernel.ScopeIngestWrite, kernel.ScopeLogsRead}, true},

		// Deny: no scopes at all — there is nothing to authorise against.
		{"empty scopes denied", []kernel.Scope{}, false},
		{"nil scopes denied", nil, false},

		// Deny: a scope that confers no log-read right.
		{"unknown scope denied", []kernel.Scope{kernel.Scope("metrics:read")}, false},

		// Deny (#82): a non-empty set of non-read scopes (ingest:write plus another
		// non-read scope) still denies — only logs:read opens the gate, distinct
		// from the empty-scopes case above.
		{"non-read scopes only denied", []kernel.Scope{kernel.ScopeIngestWrite, kernel.Scope("metrics:read")}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			principal := kernel.TenantContext{
				TenantID: kernel.TenantID(keyTenant),
				// Role intentionally empty: this is the API-key path.
				Scopes: tc.scopes,
			}
			got := canReadLogs(principal)
			if got != tc.allow {
				t.Errorf("canReadLogs(scopes=%v) = %v, want %v", tc.scopes, got, tc.allow)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Helpers for endpoint authz tests
// ---------------------------------------------------------------------------

// tcJWT builds a TenantContext as the JWT authenticator produces it: Role set,
// Scopes empty.
func tcJWT(role kernel.Role) kernel.TenantContext {
	return kernel.TenantContext{
		TenantID:    keyTenant,
		PrincipalID: kernel.PrincipalID("55555555-5555-5555-5555-555555555555"),
		Role:        role,
	}
}

// tcAPIKey builds a TenantContext as the API-key authenticator produces it:
// Role empty, Scopes set.
func tcAPIKey(scopes ...kernel.Scope) kernel.TenantContext {
	return kernel.TenantContext{
		TenantID:    keyTenant,
		PrincipalID: kernel.PrincipalID("apikey-principal"),
		Scopes:      scopes,
	}
}

// newAuthzSearchServer builds a router wired with a fakeSearcher behind the
// given authenticator. The search adapter returns an empty page (enough to
// produce 200 when authz passes).
func newAuthzSearchServer(t *testing.T, authr kernel.Authenticator) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fake := &fakeSearcher{page: kernel.SearchPage{}}
	h := NewHandler(nil, fake, nil, nil, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

// newAuthzPanelServer builds a router wired with a fakePaneler behind the
// given authenticator. The panel adapter returns a non-nil PanelData so
// the handler yields 200 when authz passes.
func newAuthzPanelServer(t *testing.T, authr kernel.Authenticator) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fake := &fakePaneler{data: &app.PanelData{}}
	h := NewHandler(nil, nil, fake, nil, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

// newAuthzTailServer builds a router wired with a recordingBus behind the
// given authenticator.
func newAuthzTailServer(t *testing.T, authr kernel.Authenticator) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := newRecordingBus()
	svc := app.New(bus)
	h := NewHandler(svc, nil, nil, nil, log)
	srv := httptest.NewServer(NewRouter(h, authr, log))
	t.Cleanup(srv.Close)
	return srv
}

// getStatus is a minimal GET helper that returns only the HTTP status code.
func getStatus(t *testing.T, url string) int {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	// Send a dummy Authorization header so AuthMiddleware does not 401 before
	// we reach LogReadAuthzMiddleware. stubAuth ignores the credential value.
	req.Header.Set("Authorization", "Bearer dummy")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// tailStatus sends GET /v1/tail with Accept: text/event-stream and returns the
// status code, immediately cancelling the request (so the SSE stream is torn
// down). It always sends a Bearer header so AuthMiddleware passes.
func tailStatus(t *testing.T, srvURL string) int {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srvURL+"/v1/tail", nil)
	if err != nil {
		t.Fatalf("build tail request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer dummy")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do tail request: %v", err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// searchURL returns a minimal /v1/search URL (no required params other than
// auth, which is handled by getStatus via the Authorization header).
func searchURL(srvURL string) string { return srvURL + "/v1/search?q=test" }

// panelURL returns a /v1/panel-data URL with a required savedQueryId param.
func panelURL(srvURL string) string {
	q := url.Values{}
	q.Set("savedQueryId", validUUID) // validUUID is declared in panel_test.go
	return srvURL + "/v1/panel-data?" + q.Encode()
}

// ---------------------------------------------------------------------------
// LogReadAuthzMiddleware — endpoint × role/scope matrix
// ---------------------------------------------------------------------------
//
// Each case drives the full stack (AuthMiddleware + LogReadAuthzMiddleware +
// handler) via a stubAuth that injects the desired TenantContext. This
// validates the middleware independently of the authenticator implementations.

// TestAuthz_Search covers the /v1/search role/scope matrix.
func TestAuthz_Search(t *testing.T) {
	cases := authzMatrix(t)
	for _, tc := range cases {
		t.Run("search/"+tc.name, func(t *testing.T) {
			srv := newAuthzSearchServer(t, stubAuth{tc: tc.principal})
			got := getStatus(t, searchURL(srv.URL))
			if got != tc.wantStatus {
				t.Errorf("GET /v1/search status=%d, want %d (role=%q scopes=%v)",
					got, tc.wantStatus, tc.principal.Role, tc.principal.Scopes)
			}
		})
	}
}

// TestAuthz_Tail covers the /v1/tail role/scope matrix.
func TestAuthz_Tail(t *testing.T) {
	cases := authzMatrix(t)
	for _, tc := range cases {
		t.Run("tail/"+tc.name, func(t *testing.T) {
			srv := newAuthzTailServer(t, stubAuth{tc: tc.principal})
			got := tailStatus(t, srv.URL)
			if got != tc.wantStatus {
				t.Errorf("GET /v1/tail status=%d, want %d (role=%q scopes=%v)",
					got, tc.wantStatus, tc.principal.Role, tc.principal.Scopes)
			}
		})
	}
}

// TestAuthz_PanelData covers the /v1/panel-data role/scope matrix.
func TestAuthz_PanelData(t *testing.T) {
	cases := authzMatrix(t)
	for _, tc := range cases {
		t.Run("panel-data/"+tc.name, func(t *testing.T) {
			srv := newAuthzPanelServer(t, stubAuth{tc: tc.principal})
			got := getStatus(t, panelURL(srv.URL))
			if got != tc.wantStatus {
				t.Errorf("GET /v1/panel-data status=%d, want %d (role=%q scopes=%v)",
					got, tc.wantStatus, tc.principal.Role, tc.principal.Scopes)
			}
		})
	}
}

// authzCase is a single row of the authz matrix.
type authzCase struct {
	name       string
	principal  kernel.TenantContext
	wantStatus int
}

// authzMatrix returns the shared set of (principal, want) pairs. All three
// endpoint tests iterate it so the coverage is identical across endpoints.
//
// Allow cases expect 200 (or 200 for SSE); deny cases expect 403.
// No 401 cases are included here — those belong to authn tests (handler_test.go,
// search_test.go, panel_test.go). The stubAuth always returns a TenantContext
// without an error, so AuthMiddleware passes; only LogReadAuthzMiddleware decides
// allow vs deny.
func authzMatrix(_ *testing.T) []authzCase {
	return []authzCase{
		// --- JWT path (role set, scopes empty) --------------------------------

		// ALLOW: member is the primary log reader.
		{
			name:       "jwt/member→allow",
			principal:  tcJWT(kernel.RoleMember),
			wantStatus: http.StatusOK,
		},
		// ALLOW: tenant_admin manages the tenant and also reads logs.
		{
			name:       "jwt/tenant_admin→allow",
			principal:  tcJWT(kernel.RoleTenantAdmin),
			wantStatus: http.StatusOK,
		},
		// DENY: platform_operator is barred from tenant log content (ADR-0007
		// NFR-5.4). This 403 is the defense-in-depth layer; authn already
		// rejects platform_operator tokens with 401 in production, but the
		// authz layer must also deny it should an operator tc ever reach here.
		{
			name:       "jwt/platform_operator→deny",
			principal:  tcJWT(kernel.RolePlatformOperator),
			wantStatus: http.StatusForbidden,
		},
		// DENY: an unknown/future role that query-service does not recognise
		// must fail closed rather than accidentally allowing access.
		{
			name:       "jwt/unknown_role→deny",
			principal:  tcJWT(kernel.Role("super_admin")),
			wantStatus: http.StatusForbidden,
		},

		// --- API-key path (scopes set, role empty) ----------------------------

		// DENY (#82): ingest:write is a WRITE scope only. The back-compat grant
		// from #76 has been retired. Existing ingest-only keys lose log-read
		// access; read consumers must be re-issued with logs:read.
		{
			name:       "apikey/ingest:write_alone→deny",
			principal:  tcAPIKey(kernel.ScopeIngestWrite),
			wantStatus: http.StatusForbidden,
		},
		// ALLOW: logs:read is the required explicit read scope since #82.
		{
			name:       "apikey/logs:read→allow",
			principal:  tcAPIKey(kernel.ScopeLogsRead),
			wantStatus: http.StatusOK,
		},
		// ALLOW: a key carrying both ingest:write and logs:read gets read access.
		{
			name:       "apikey/ingest:write+logs:read→allow",
			principal:  tcAPIKey(kernel.ScopeIngestWrite, kernel.ScopeLogsRead),
			wantStatus: http.StatusOK,
		},
		// DENY: empty scopes — no capability to read.
		{
			name:       "apikey/no_scopes→deny",
			principal:  tcAPIKey(),
			wantStatus: http.StatusForbidden,
		},
		// DENY: an unrecognised scope confers no log-read capability.
		{
			name:       "apikey/unknown_scope→deny",
			principal:  tcAPIKey(kernel.Scope("metrics:read")),
			wantStatus: http.StatusForbidden,
		},
		// DENY (#82): a non-empty set of non-read scopes (ingest:write plus
		// another non-read scope) still denies — only logs:read opens the gate,
		// and no combination of other scopes substitutes for it.
		{
			name:       "apikey/non_read_scopes_only→deny",
			principal:  tcAPIKey(kernel.ScopeIngestWrite, kernel.Scope("metrics:read")),
			wantStatus: http.StatusForbidden,
		},

		// --- Neither role nor scopes (degenerate / future credential type) ----

		// DENY: a TenantContext with neither role nor scopes (should never arise
		// from a real credential but must fail closed for defense-in-depth).
		{
			name:       "empty/no_role_no_scopes→deny",
			principal:  kernel.TenantContext{TenantID: keyTenant},
			wantStatus: http.StatusForbidden,
		},
	}
}

// ---------------------------------------------------------------------------
// Regression: existing authn-level rejections still yield 401, not 403
// ---------------------------------------------------------------------------

// TestAuthz_AuthnRejectionsStillYield401 confirms that the authn-level
// rejections (missing credential, bad credential) still produce 401 rather
// than being consumed by the authz layer. The authz middleware runs AFTER
// authn, so a 401 abort by AuthMiddleware must not be overridden.
func TestAuthz_AuthnRejectionsStillYield401(t *testing.T) {
	// stubAuth that always rejects (simulates a bad credential).
	rejectAuthr := stubAuth{err: errors.New("authn: invalid token")}

	t.Run("search rejects on bad authn", func(t *testing.T) {
		srv := newAuthzSearchServer(t, rejectAuthr)
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, searchURL(srv.URL), nil)
		req.Header.Set("Authorization", "Bearer bad_token")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("status=%d, want 401 (authn rejection must not be overridden by authz)", resp.StatusCode)
		}
	})

	t.Run("panel-data rejects on bad authn", func(t *testing.T) {
		srv := newAuthzPanelServer(t, rejectAuthr)
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, panelURL(srv.URL), nil)
		req.Header.Set("Authorization", "Bearer bad_token")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("status=%d, want 401 (authn rejection must not be overridden by authz)", resp.StatusCode)
		}
	})
}
