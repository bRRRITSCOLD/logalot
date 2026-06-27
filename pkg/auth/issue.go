package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// keyIDBytes / secretBytes size the random components. The key id is a short
// lookup handle; the secret carries the entropy SHA-256 relies on (ADR-0007). 16
// random bytes = 128 bits for the id, 32 bytes = 256 bits for the secret.
const (
	keyIDBytes  = 16
	secretBytes = 32
)

// IssueParams describes a key to mint. Scopes default to [ingest:write] and Name
// defaults to a placeholder when empty; ExpiresAt and CreatedBy are optional.
type IssueParams struct {
	TenantID  kernel.TenantID
	PublicID  string // tenant slug, embedded in the plaintext key
	Name      string
	Scopes    []kernel.Scope
	ExpiresAt *time.Time
	CreatedBy *string // users.id (uuid); nil inserts NULL
}

// Minted is the result of issuing a key: the one-time plaintext (shown to the
// admin once, NEVER persisted) plus the stored record (which holds only the hash).
type Minted struct {
	Plaintext string
	APIKey    kernel.APIKey
}

// IssueKey mints a new ingest API key for a tenant and inserts the hashed record,
// arming RLS first so the WITH CHECK policy admits the row. This is the minimal
// programmatic issuance path for the vertical slice and tests; full admin CRUD is
// wave 2 (do NOT build it here). The plaintext is returned exactly once — only
// SHA-256(secret) is stored.
func IssueKey(ctx context.Context, pool *pgxpool.Pool, p IssueParams) (Minted, error) {
	if strings.TrimSpace(p.PublicID) == "" {
		return Minted{}, fmt.Errorf("auth: IssueKey requires a tenant PublicID")
	}
	tc := kernel.TenantContext{TenantID: p.TenantID}
	if err := tc.Valid(); err != nil {
		return Minted{}, fmt.Errorf("auth: IssueKey invalid tenant: %w", err)
	}

	keyID, err := randomHex(keyIDBytes)
	if err != nil {
		return Minted{}, err
	}
	secret, err := randomHex(secretBytes)
	if err != nil {
		return Minted{}, err
	}

	scopes := p.Scopes
	if len(scopes) == 0 {
		scopes = []kernel.Scope{kernel.ScopeIngestWrite}
	}
	name := p.Name
	if name == "" {
		name = "ingest key"
	}

	hash := hashSecret(secret)
	plaintext := strings.Join([]string{keyPrefix, p.PublicID, keyID, secret}, keySeparator)

	store := &pgStore{pool: pool}
	err = store.inTx(ctx, func(tx pgx.Tx) error {
		return kernel.WithTenantScope(tc, ctx, execOf(tx), func() error {
			_, eerr := tx.Exec(ctx,
				`INSERT INTO api_keys (id, tenant_id, name, key_hash, scopes, created_by, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				keyID, string(p.TenantID), name, hash, scopeStrings(scopes), p.CreatedBy, p.ExpiresAt,
			)
			return eerr
		})
	})
	if err != nil {
		return Minted{}, err
	}

	return Minted{
		Plaintext: plaintext,
		APIKey: kernel.APIKey{
			ID:       keyID,
			TenantID: p.TenantID,
			Scopes:   scopes,
			Hash:     hash,
		},
	}, nil
}

// scopeStrings renders kernel.Scope values for the text[] column.
func scopeStrings(scopes []kernel.Scope) []string {
	out := make([]string, len(scopes))
	for i, s := range scopes {
		out[i] = string(s)
	}
	return out
}

// randomHex returns n cryptographically random bytes hex-encoded (so the result
// contains no '_' and is safe inside the underscore-delimited key format).
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("auth: read random: %w", err)
	}
	return hex.EncodeToString(b), nil
}
