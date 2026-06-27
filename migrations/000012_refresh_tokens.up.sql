-- 000012 — refresh_tokens (UI session refresh, Identity & Access context, ADR-0007).
--
-- The control-plane issues a short-lived access JWT (~15m) plus a long-lived
-- refresh token (~7d). Refresh tokens ROTATE: each use mints a successor and
-- consumes the predecessor. A "family" (family_id) chains a login's successive
-- refresh tokens so REUSE of an already-rotated token (a stolen-token signal)
-- can revoke the whole family at once.
--
-- Only a SHA-256 of the refresh secret is stored (token_hash bytea, 32 bytes) —
-- never the plaintext. The refresh secret is high-entropy random (like an API
-- key secret), so SHA-256 is the correct, fast hash here; bcrypt/argon2 are only
-- for low-entropy human passwords.
--
-- RLS: tenant-owned like users/api_keys, so a tenant can only ever see/rotate its
-- own refresh tokens. The presented refresh token carries its tenant id so the
-- control-plane can SET LOCAL app.tenant_id before the scoped lookup (same
-- chicken-and-egg resolution as API keys, model.md §4.5).

CREATE TABLE refresh_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL,
  family_id  uuid        NOT NULL,
  token_hash bytea       NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- When this token was used to mint a successor (consumed). A second presentation
  -- of a rotated token is reuse -> revoke the family.
  rotated_at timestamptz,
  -- When the token was invalidated (logout or family revocation on reuse).
  revoked_at timestamptz,
  -- Same-tenant integrity: the token's tenant must equal the user's home tenant.
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT refresh_tokens_hash_len CHECK (octet_length(token_hash) = 32)
);

CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (tenant_id, family_id);
CREATE INDEX idx_refresh_tokens_user   ON refresh_tokens (tenant_id, user_id);

-- No updated_at trigger: rows are append-then-mark (rotated_at/revoked_at) and
-- never otherwise mutated, so the generic app.set_updated_at() trigger (which
-- expects an updated_at column) is intentionally not attached.

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
