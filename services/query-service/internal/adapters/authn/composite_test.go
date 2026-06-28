package authn

import (
	"context"
	"errors"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// recordingAuth records the credential it was handed and returns a fixed result,
// so a test can assert WHICH authenticator the Composite routed to and with what
// normalized credential.
type recordingAuth struct {
	name   string
	gotRaw string
	called bool
	tc     kernel.TenantContext
	err    error
}

func (r *recordingAuth) Authenticate(_ context.Context, cred kernel.Credential) (kernel.TenantContext, error) {
	r.called = true
	// Capture whichever field carries the raw value for this branch.
	if cred.APIKey != "" {
		r.gotRaw = cred.APIKey
	} else {
		r.gotRaw = cred.BearerToken
	}
	return r.tc, r.err
}

func newComposite() (*Composite, *recordingAuth, *recordingAuth) {
	apiKey := &recordingAuth{name: "apikey", tc: kernel.TenantContext{TenantID: kernel.TenantID(testTenant), Scopes: []kernel.Scope{kernel.ScopeIngestWrite}}}
	jwtA := &recordingAuth{name: "jwt", tc: kernel.TenantContext{TenantID: kernel.TenantID(testTenant), Role: kernel.RoleMember}}
	return NewComposite(apiKey, jwtA), apiKey, jwtA
}

func TestComposite_RoutesLgkPrefixToAPIKey(t *testing.T) {
	c, apiKey, jwtA := newComposite()
	const raw = "lgk_acme_keyid_secret"

	// Edge middleware (httpkit.CredentialFromRequest) always stashes the raw value
	// in APIKey, regardless of bearer vs X-API-Key. Mirror that here.
	if _, err := c.Authenticate(context.Background(), kernel.Credential{APIKey: raw}); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if !apiKey.called {
		t.Fatal("an lgk_-prefixed credential must route to the API-key authenticator")
	}
	if jwtA.called {
		t.Fatal("the JWT authenticator must NOT be called for an lgk_ key")
	}
	if apiKey.gotRaw != raw {
		t.Fatalf("API-key authenticator got %q, want the raw key %q", apiKey.gotRaw, raw)
	}
}

func TestComposite_RoutesNonLgkToJWT(t *testing.T) {
	c, apiKey, jwtA := newComposite()
	const raw = "eyJhbGciOiJIUzI1NiJ9.payload.sig"

	if _, err := c.Authenticate(context.Background(), kernel.Credential{APIKey: raw}); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if !jwtA.called {
		t.Fatal("a non-lgk_ credential must route to the JWT authenticator")
	}
	if apiKey.called {
		t.Fatal("the API-key authenticator must NOT be called for a JWT")
	}
	// The Composite must normalize the raw value into BearerToken for the JWT path.
	if jwtA.gotRaw != raw {
		t.Fatalf("JWT authenticator got %q, want the raw token %q", jwtA.gotRaw, raw)
	}
}

func TestComposite_NormalizesBearerTokenFieldToo(t *testing.T) {
	c, _, jwtA := newComposite()
	const raw = "eyJhbGciOiJIUzI1NiJ9.payload.sig"
	// If a caller populated BearerToken instead of APIKey, routing still works.
	if _, err := c.Authenticate(context.Background(), kernel.Credential{BearerToken: raw}); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if !jwtA.called || jwtA.gotRaw != raw {
		t.Fatalf("BearerToken credential must route to JWT with raw=%q, got called=%v raw=%q", raw, jwtA.called, jwtA.gotRaw)
	}
}

func TestComposite_PropagatesUnderlyingError(t *testing.T) {
	apiKey := &recordingAuth{err: errors.New("auth: unknown api key")}
	jwtA := &recordingAuth{}
	c := NewComposite(apiKey, jwtA)

	if _, err := c.Authenticate(context.Background(), kernel.Credential{APIKey: "lgk_a_b_c"}); err == nil {
		t.Fatal("Composite must propagate the delegate's rejection")
	}
}

func TestComposite_EmptyCredentialRoutesToJWTAndRejects(t *testing.T) {
	// Defensive: AuthMiddleware returns 401 before calling Authenticate on a missing
	// credential, but if reached, an empty credential must not match lgk_ and must
	// be rejected by the JWT path (fail closed).
	apiKey := &recordingAuth{}
	jwtA := &recordingAuth{err: ErrInvalidToken}
	c := NewComposite(apiKey, jwtA)

	if _, err := c.Authenticate(context.Background(), kernel.Credential{}); err == nil {
		t.Fatal("an empty credential must be rejected")
	}
	if apiKey.called {
		t.Fatal("an empty credential must not route to the API-key authenticator")
	}
}
