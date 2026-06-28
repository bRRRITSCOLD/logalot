// Package authn is the query-service authentication edge adapter. It holds the
// kernel.Authenticator implementations the HTTP edge depends on: a JWT verifier
// for control-plane UI session tokens and a Composite that routes a presented
// credential to either the JWT verifier or the shared API-key authenticator by
// credential shape. Nothing here imports Gin/HTTP — these are pure adapters
// behind the kernel.Authenticator port, established at the edge from a verified
// credential (ADR-0002, ADR-0007).
package authn

import (
	"context"
	"errors"
	"fmt"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/golang-jwt/jwt/v5"
)

// The control-plane access-token contract (authoritative in
// services/control-plane/src/adapters/crypto/jose-token-service.ts). These MUST
// stay in lockstep with the issuer; verification fails closed on any mismatch.
const (
	// tokenIssuer is the `iss` every control-plane access token carries.
	tokenIssuer = "logalot-control-plane"
	// tokenAudience is the `aud` every control-plane access token carries.
	tokenAudience = "logalot"
	// signingAlg is the ONLY accepted signature algorithm. HS256 matches the
	// control-plane signer; pinning it is the alg-confusion guard (a token
	// presenting alg=none or any non-HS256 alg is rejected before key use).
	signingAlg = "HS256"
)

// ErrInvalidToken is the single opaque rejection every verification failure
// collapses to. As with the API-key authenticator's sentinels, the distinction
// between an expired, foreign-signed, malformed or wrong-audience token is for
// server-side logs only — the middleware maps any non-nil error to one 401, so
// a client gets no oracle to distinguish failure modes.
var ErrInvalidToken = errors.New("authn: invalid session token")

// sessionClaims is the access-token claim set query-service consumes. The
// registered claims (iss/aud/sub/exp/iat) are validated by the parser; the
// custom claims (tenant_id, role) are validated here after parse.
type sessionClaims struct {
	TenantID string `json:"tenant_id"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

// JWTAuthenticator verifies a control-plane HS256 access token and yields the
// TenantContext that drives downstream isolation. It is a kernel.Authenticator,
// so swapping/adding it is a constructor change at the edge, not an edge change
// (the AuthMiddleware only knows the port).
type JWTAuthenticator struct {
	secret []byte
	parser *jwt.Parser
}

// compile-time proof the adapter satisfies the kernel port.
var _ kernel.Authenticator = (*JWTAuthenticator)(nil)

// NewJWT builds a verifier over the shared HS256 secret (JWT_SECRET — the same
// value control-plane signs with). The secret must be non-empty: a verifier with
// no key cannot fail closed. Length/strength policy lives in config (mirroring
// control-plane's min-length validation), enforced at service startup.
//
// The parser is configured once and reused: it accepts ONLY HS256
// (WithValidMethods, the alg-confusion guard), requires a matching iss and aud,
// and requires a present, unexpired exp (WithExpirationRequired). Every one of
// these fails the parse closed.
func NewJWT(secret string) (*JWTAuthenticator, error) {
	if secret == "" {
		return nil, errors.New("authn: JWT secret must not be empty")
	}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{signingAlg}),
		jwt.WithIssuer(tokenIssuer),
		jwt.WithAudience(tokenAudience),
		jwt.WithExpirationRequired(),
	)
	return &JWTAuthenticator{secret: []byte(secret), parser: parser}, nil
}

// Authenticate verifies the presented bearer token and maps it to a
// TenantContext. It has no tc parameter ON PURPOSE — it is the boundary that
// establishes tenancy (kernel ports.go, fitness allow-list).
//
// Order is security-relevant: the parser verifies signature + alg + iss + aud +
// exp FIRST (so no claim is trusted from an unverified token), then the tenant
// is derived SOLELY from the tenant_id claim — never from sub or any other
// field. A blank/non-UUID tenant_id, unknown role, or empty subject is rejected.
func (a *JWTAuthenticator) Authenticate(_ context.Context, cred kernel.Credential) (kernel.TenantContext, error) {
	raw := cred.BearerToken
	if raw == "" {
		// Defensive: httpkit.CredentialFromRequest stashes the raw bearer value in
		// APIKey; the Composite normalizes it into BearerToken, but accept either so
		// a direct wiring still works.
		raw = cred.APIKey
	}
	if raw == "" {
		return kernel.TenantContext{}, ErrInvalidToken
	}

	var claims sessionClaims
	if _, err := a.parser.ParseWithClaims(raw, &claims, a.keyfunc); err != nil {
		// Wrap for server-side logs (the middleware logs err) while keeping the
		// client-facing error opaque via errors.Is(ErrInvalidToken).
		return kernel.TenantContext{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}

	role := kernel.Role(claims.Role)
	if !role.Valid() {
		return kernel.TenantContext{}, fmt.Errorf("%w: unknown role", ErrInvalidToken)
	}
	if claims.Subject == "" {
		return kernel.TenantContext{}, fmt.Errorf("%w: empty subject", ErrInvalidToken)
	}

	tc := kernel.TenantContext{
		TenantID:    kernel.TenantID(claims.TenantID),
		PrincipalID: kernel.PrincipalID(claims.Subject),
		Role:        role,
	}
	// Fail closed on a blank/non-UUID tenant_id — the same check the RLS `::uuid`
	// cast would enforce, surfaced here before any tenant-scoped work.
	if err := tc.Valid(); err != nil {
		return kernel.TenantContext{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	return tc, nil
}

// keyfunc returns the HMAC verification key. The parser's WithValidMethods
// already rejects any non-HS256 alg before this runs; the explicit HMAC type
// assertion here is defense-in-depth so the secret is never handed to a verifier
// for a key type it was not minted for (alg-confusion).
func (a *JWTAuthenticator) keyfunc(t *jwt.Token) (any, error) {
	if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
		return nil, fmt.Errorf("unexpected signing method %q", t.Method.Alg())
	}
	return a.secret, nil
}
