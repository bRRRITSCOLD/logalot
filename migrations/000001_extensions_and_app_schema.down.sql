-- 000001 down
DROP FUNCTION IF EXISTS app.set_updated_at();
DROP FUNCTION IF EXISTS app.current_tenant_id();
DROP SCHEMA IF EXISTS app;
-- pgcrypto is intentionally left installed; other objects/migrations may use it.
