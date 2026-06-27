-- 000002 — shared enumerated types.
--
-- Enums are used instead of free-text + CHECK because the value sets are small,
-- closed, and load-bearing for both the domain and the query planner.

-- Log severity. Ordered low->high; the query layer can range-filter
-- (e.g. level >= 'warn') by mapping to the enum's declared order.
CREATE TYPE log_level AS ENUM ('trace', 'debug', 'info', 'warn', 'error', 'fatal');

-- Per-tenant RBAC grant (ADR-0007). platform_operator is deliberately NOT here:
-- it is a cross-tenant, platform-scope role modeled as users.is_platform_operator,
-- because it must never be expressed as a tenant membership (it is structurally
-- barred from tenant log content, NFR-5.4).
CREATE TYPE membership_role AS ENUM ('tenant_admin', 'member');

-- Tenant lifecycle.
CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'deleted');

-- Alerting (ADR-0001 Alerting context).
CREATE TYPE alert_state      AS ENUM ('ok', 'firing', 'no_data');
CREATE TYPE alert_comparator AS ENUM ('gt', 'gte', 'lt', 'lte', 'eq');
