-- Dev seed — NOT a migration. golang-migrate ignores subdirectories, so this is
-- never applied automatically. Run it manually after `migrate up` to provision a
-- dev tenant + admin user + API key for the vertical slice:
--
--   psql "$DATABASE_URL" -f migrations/seeds/dev_tenant.sql
--
-- Dev credentials it creates (DEV ONLY — do not use anywhere real):
--   tenant.public_id : dev
--   tenant.id        : 00000000-0000-0000-0000-0000000000d1
--   admin login      : admin@dev.local / password: devpassword (hash is a stub;
--                       the control-plane should re-hash on first real login)
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
  'stub$devpassword',         -- replace with a real hash via control-plane
  'Dev Admin',
  false
) ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (tenant_id, user_id, role)
VALUES (
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-0000000000a1',
  'tenant_admin'
) ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- API key: store only the SHA-256 of the secret (pgcrypto digest()).
INSERT INTO api_keys (id, tenant_id, name, key_hash, scopes, created_by)
VALUES (
  'devkey001',
  '00000000-0000-0000-0000-0000000000d1',
  'dev slice key',
  digest('devsecret0123456789', 'sha256'),
  ARRAY['ingest:write'],
  '00000000-0000-0000-0000-0000000000a1'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO retention_policies (tenant_id, hot_days, cold_days, updated_by)
VALUES (
  '00000000-0000-0000-0000-0000000000d1',
  30, 365,
  '00000000-0000-0000-0000-0000000000a1'
) ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;

-- Sanity check (optional): with the dev context set, this returns the dev key.
-- SET app.tenant_id = '00000000-0000-0000-0000-0000000000d1';
-- SELECT id, tenant_id, scopes FROM api_keys;
-- With the context UNSET it must return ZERO rows (RLS fail-closed):
-- RESET app.tenant_id; SELECT count(*) FROM api_keys;  -- => 0
