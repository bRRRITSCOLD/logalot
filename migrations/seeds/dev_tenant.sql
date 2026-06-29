-- Dev seed — NOT a migration. golang-migrate ignores subdirectories, so this is
-- never applied automatically. Run it manually after `migrate up` to provision a
-- dev tenant + admin user + API key for the vertical slice:
--
--   psql "$DATABASE_URL" -f migrations/seeds/dev_tenant.sql
--
-- Dev credentials it creates (DEV ONLY — do not use anywhere real):
--   tenant.public_id : dev
--   tenant.id        : 00000000-0000-0000-0000-0000000000d1
--   admin login      : admin@dev.local / password: devpassword (real bcrypt hash
--                       below — verifies against the control-plane login directly)
--   API key (plaintext, shown once): lgk_dev_devkey001_devsecret0123456789
--       parsed as -> tenantPublicId=dev  key_id=devkey001  secret=devsecret0123456789
--       stored as  -> api_keys.id='devkey001', key_hash=sha256(secret)
--
-- The insert order matters because of RLS: tenant-owned tables require the tenant
-- context GUC to be set first (otherwise the WITH CHECK policy rejects the rows).

BEGIN;

-- tenants has no RLS (registry table); insert directly.
INSERT INTO tenants (id, public_id, name, status)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'dev', 'Dev Tenant', 'active')
ON CONFLICT (id) DO NOTHING;

-- Arm the tenant context so RLS WITH CHECK passes for every tenant-owned insert.
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-0000000000d1';

INSERT INTO users (id, tenant_id, email, password_hash, display_name, is_platform_operator)
VALUES (
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000d1',
  'admin@dev.local',
  '$2b$10$KIToUQi.7nqTONS/NKo1OOq8YfCnXOAtZMej7.aTsGsu.XOZ/yLly', -- bcrypt('devpassword', cost 10) — DEV ONLY
  'Dev Admin',
  false
)
-- DO UPDATE (not DO NOTHING) so an existing dev DB seeded with the prior stub
-- hash self-heals to the real bcrypt hash on re-`make seed` (no `make reset` needed).
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

INSERT INTO memberships (tenant_id, user_id, role)
VALUES (
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-0000000000a1',
  'tenant_admin'
) ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- API key: store only the SHA-256 of the secret (pgcrypto digest()).
-- devkey001 is used by slice-e2e and the local dev loop for BOTH ingest
-- (POST /v1/ingest requires ingest:write) AND log reads (GET /v1/search,
-- /v1/tail, /v1/panel-data require logs:read since #82). It therefore carries
-- both scopes. Pure read-only consumers should be issued ['logs:read'] only.
INSERT INTO api_keys (id, tenant_id, name, key_hash, scopes, created_by)
VALUES (
  'devkey001',
  '00000000-0000-0000-0000-0000000000d1',
  'dev slice key',
  digest('devsecret0123456789', 'sha256'),
  ARRAY['ingest:write', 'logs:read'],
  '00000000-0000-0000-0000-0000000000a1'
) ON CONFLICT (id) DO UPDATE SET scopes = EXCLUDED.scopes;

INSERT INTO retention_policies (tenant_id, hot_days, cold_days, updated_by)
VALUES (
  '00000000-0000-0000-0000-0000000000d1',
  30, 365,
  '00000000-0000-0000-0000-0000000000a1'
) ON CONFLICT (tenant_id) DO NOTHING;

-- DEV-ONLY oauth_identities row: links the dev admin user to a stub Google
-- identity so OAuth login flows can be exercised locally without a real Google
-- token. provider_sub is a fixed fake value — never used in production.
-- RLS is already armed (SET LOCAL app.tenant_id above), so the WITH CHECK policy
-- passes. ON CONFLICT DO NOTHING makes this idempotent across repeated `make seed`
-- runs (R2/R3 structural storage; D5-Q4).
INSERT INTO oauth_identities (tenant_id, user_id, provider, provider_sub, email)
VALUES (
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-0000000000a1',
  'google',
  'google-sub-dev-admin',   -- DEV ONLY — fake, stable sub for local dev
  'admin@dev.local'         -- must match the normalized email on the users row
) ON CONFLICT DO NOTHING;

COMMIT;

-- Sanity check (optional): with the dev context set, this returns the dev key.
-- SET app.tenant_id = '00000000-0000-0000-0000-0000000000d1';
-- SELECT id, tenant_id, scopes FROM api_keys;
-- With the context UNSET it must return ZERO rows (RLS fail-closed):
-- RESET app.tenant_id; SELECT count(*) FROM api_keys;  -- => 0
