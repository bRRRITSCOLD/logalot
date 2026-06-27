package auth

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"testing"
)

func TestParseKey_Valid(t *testing.T) {
	// The exact dev seed key (migrations/seeds/dev_tenant.sql).
	const seedKey = "lgk_dev_devkey001_devsecret0123456789"
	pk, err := parseKey(seedKey)
	if err != nil {
		t.Fatalf("parseKey(%q) error = %v", seedKey, err)
	}
	if pk.PublicID != "dev" {
		t.Errorf("PublicID = %q, want dev", pk.PublicID)
	}
	if pk.KeyID != "devkey001" {
		t.Errorf("KeyID = %q, want devkey001", pk.KeyID)
	}
	if pk.Secret != "devsecret0123456789" {
		t.Errorf("Secret = %q, want devsecret0123456789", pk.Secret)
	}
}

func TestParseKey_SecretMayContainSeparator(t *testing.T) {
	// The secret is the un-split remainder, so embedded underscores survive.
	pk, err := parseKey("lgk_acme_key123_sec_ret_with_unders")
	if err != nil {
		t.Fatalf("parseKey error = %v", err)
	}
	if pk.PublicID != "acme" || pk.KeyID != "key123" {
		t.Fatalf("slug/keyid parse wrong: %+v", pk)
	}
	if pk.Secret != "sec_ret_with_unders" {
		t.Errorf("Secret = %q, want sec_ret_with_unders", pk.Secret)
	}
}

func TestParseKey_Malformed(t *testing.T) {
	cases := map[string]string{
		"empty":          "",
		"wrong prefix":   "key_dev_devkey001_secret",
		"too few parts":  "lgk_dev_devkey001",
		"empty publicId": "lgk__devkey001_secret",
		"empty keyId":    "lgk_dev__secret",
		"empty secret":   "lgk_dev_devkey001_",
		"only prefix":    "lgk",
		"prefix only_":   "lgk_",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseKey(raw); !errors.Is(err, ErrMalformedKey) {
				t.Fatalf("parseKey(%q) err = %v, want ErrMalformedKey", raw, err)
			}
		})
	}
}

func TestSecretHash_MatchesSHA256(t *testing.T) {
	pk, err := parseKey("lgk_dev_devkey001_devsecret0123456789")
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte("devsecret0123456789"))
	if !bytes.Equal(pk.SecretHash(), want[:]) {
		t.Fatalf("SecretHash mismatch")
	}
	// hashSecret (issuance side) must agree with SecretHash (verify side).
	if !bytes.Equal(hashSecret("devsecret0123456789"), want[:]) {
		t.Fatalf("hashSecret diverges from SecretHash")
	}
}

func TestConstantTimeEqual(t *testing.T) {
	a := sha256.Sum256([]byte("same"))
	b := sha256.Sum256([]byte("same"))
	c := sha256.Sum256([]byte("different"))
	if !constantTimeEqual(a[:], b[:]) {
		t.Errorf("equal hashes reported unequal")
	}
	if constantTimeEqual(a[:], c[:]) {
		t.Errorf("different hashes reported equal")
	}
	// Length mismatch must be a safe non-match, not a panic.
	if constantTimeEqual(a[:], a[:16]) {
		t.Errorf("length mismatch reported equal")
	}
}
