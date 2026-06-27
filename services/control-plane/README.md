# control-plane (reserved)

Node + Fastify service for tenants, users, API keys, RBAC, dashboards, alert
rules, and retention policy (Identity & Access + Workspace bounded contexts —
see `docs/architecture/overview.md`).

**Status:** reserved path. Built in **issue #11**. When it lands it becomes a
pnpm workspace member here (its own `package.json`), automatically picked up by
the `services/*` glob in `pnpm-workspace.yaml`.
