-- 000005 — ApiKey aggregate (Identity & Access context, ADR-0007).
--
-- Only {key_id, tenant_id, scopes, hash} are stored — NEVER the plaintext key.
-- The presented credential is `lgk_<tenantPublicId>_<key_id>_<secret>`:
--   1. ingest parses tenantPublicId, resolves tenants.public_id -> tenants.id,
--   2. SET LOCAL app.tenant_id = '<that id>'  (arms RLS, even for auth),
--   3. SELECT ... WHERE id = '<key_id>'        (O(1) PK lookup, tenant-scoped),
--   4. constant-time compare key_hash = digest(secret,'sha256').
-- Validated keys are cached in Redis (60s TTL) so the hot path skips Postgres.
--
-- id IS the key_id (natural key embedded in the credential). key_hash is bytea
-- (32 bytes of SHA-256), not text, so comparisons are byte-exact.

CREATE TABLE api_keys (
  id           text        PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  key_hash     bytea       NOT NULL,
  scopes       text[]      NOT NULL DEFAULT ARRAY['ingest:write'],
  created_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT api_keys_hash_len CHECK (octet_length(key_hash) = 32)
);

CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);
-- Partial index over live keys for admin listings (revoked/expired excluded).
CREATE INDEX idx_api_keys_live ON api_keys (tenant_id)
  WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
