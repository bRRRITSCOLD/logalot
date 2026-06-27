package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

// keyPrefix is the fixed scheme marker every ingest API key carries.
const keyPrefix = "lgk"

// keySeparator splits the four logical fields of a key. The tenant slug
// (tenants.public_id) and the key id are constrained to NOT contain it: slugs
// match ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ (migration 000003, no underscores) and
// minted key ids are hex (issue.go), so a fixed 4-way split is unambiguous and
// the secret — the only field that could legitimately contain a separator — is
// always the final, un-split remainder.
const keySeparator = "_"

// parsedKey is the deconstructed presented credential. None of these fields is a
// secret on its own except Secret, which is never logged or stored — only its
// SHA-256 (see SecretHash) ever leaves this package.
type parsedKey struct {
	// PublicID is the tenant slug used to resolve tenants.public_id -> tenant_id
	// and arm RLS BEFORE the key is looked up (model.md §4.5). It is a routing
	// hint, not the security boundary — the keyID+secret pair is.
	PublicID string
	// KeyID is api_keys.id, the O(1) primary-key lookup target.
	KeyID string
	// Secret is the high-entropy plaintext. It is hashed immediately and never
	// retained.
	Secret string
}

// parseKey deconstructs a presented `lgk_<publicId>_<keyId>_<secret>` credential.
// It validates shape only (prefix, field count, non-empty fields); it does NOT
// touch the database. A malformed key returns ErrMalformedKey so the caller can
// reject without any tenant resolution or DB round-trip.
func parseKey(raw string) (parsedKey, error) {
	// SplitN with n=4: ["lgk", publicId, keyId, secret]. The secret keeps any
	// further separators intact as the remainder.
	parts := strings.SplitN(raw, keySeparator, 4)
	if len(parts) != 4 {
		return parsedKey{}, ErrMalformedKey
	}
	if parts[0] != keyPrefix {
		return parsedKey{}, ErrMalformedKey
	}
	pk := parsedKey{PublicID: parts[1], KeyID: parts[2], Secret: parts[3]}
	if pk.PublicID == "" || pk.KeyID == "" || pk.Secret == "" {
		return parsedKey{}, ErrMalformedKey
	}
	return pk, nil
}

// SecretHash returns the SHA-256 of the parsed secret — the only representation
// of the secret this package ever compares or stores. SHA-256 (not a slow KDF)
// is correct here because the secret is high-entropy random (ADR-0007).
func (p parsedKey) SecretHash() []byte {
	sum := sha256.Sum256([]byte(p.Secret))
	return sum[:]
}

// hashSecret is the package-internal helper used by issuance to derive the stored
// key_hash from a freshly minted secret. Same algorithm as SecretHash so mint and
// verify can never diverge (DRY, single source of truth for the hash).
func hashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// constantTimeEqual reports whether two hashes match, in constant time relative
// to their contents. subtle.ConstantTimeCompare returns 1 only when the lengths
// are equal AND the bytes match, so a length mismatch is a safe (non-panicking)
// non-match.
func constantTimeEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}
