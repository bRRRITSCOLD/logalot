# web (reserved)

TanStack Start frontend + BFF: holds the user session and proxies to
`query-service` / `control-plane` with the session JWT (see
`docs/architecture/overview.md`).

**Status:** reserved path. Built in **issue #20**. When it lands it becomes a
pnpm workspace member here (its own `package.json`), automatically picked up by
the `apps/*` glob in `pnpm-workspace.yaml`.
