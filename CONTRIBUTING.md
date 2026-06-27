# Contributing to Logalot

Logalot is a polyglot monorepo: Go services share a Go workspace (`go.work`),
and Node services + the frontend share a pnpm workspace (`pnpm-workspace.yaml`).
This guide covers the repo layout, where new code goes, and our commit/merge
conventions. Architecture and decisions live in
[`docs/architecture/overview.md`](docs/architecture/overview.md) and
[`docs/adr/`](docs/adr/).

## Prerequisites

- Go (workspace pinned to `go 1.26` in `go.work`)
- Node `>=22` and pnpm (`packageManager` in `package.json`, currently `pnpm@10.33.2`)
- `make` (the `Makefile` wraps every common command)
- For the local data plane: Docker + Compose (see the README)

## Repository layout

```
.
├── go.work                 # Go workspace; lists every Go module under `use`
├── pnpm-workspace.yaml      # pnpm workspace globs: services/*, apps/*, tools/*
├── package.json             # repo-root Node tooling (biome) + scripts
├── biome.json               # Node/TS lint + format config (one source of truth)
├── .golangci.yml            # Go lint config (golangci-lint v2)
├── .editorconfig            # editor defaults across languages
├── pkg/
│   └── kernel/              # shared Go module: TenantContext + ports (issue #4)
├── services/                # backend services (Go AND Node live here)
│   ├── ingest-service/      # Go + Gin    (issue #6)
│   ├── processor/           # Go worker   (issue #7)
│   ├── query-service/       # Go + SSE    (issue #8)
│   └── control-plane/       # Node + Fastify (issue #11)
├── apps/
│   └── web/                 # TanStack Start frontend + BFF (issue #20)
├── tools/                   # repo tooling + scaffold packages (pnpm members)
├── docs/                    # architecture, ADRs, data model, roadmap
└── migrations/              # SQL migrations
```

## Where does new code go?

| You are building...        | Put it in...                         | Wire it up by...                                                                 |
|----------------------------|--------------------------------------|---------------------------------------------------------------------------------|
| **A new Go service**       | `services/<name>/`                   | `cd services/<name> && go mod init github.com/bRRRITSCOLD/logalot/services/<name>`, then add `./services/<name>` to the `use` block in `go.work` and run `go work sync`. |
| **Shared Go code (ports, domain kernel)** | `pkg/<name>/` (e.g. `pkg/kernel`) | Same as above: it is a module in `go.work`. Keep it dependency-light; it is imported by many services. |
| **A new Node service**     | `services/<name>/`                   | Add a `package.json`; the `services/*` glob in `pnpm-workspace.yaml` picks it up automatically. Give it `test` (and ideally `lint`) scripts. |
| **A frontend app**         | `apps/<name>/`                       | Add a `package.json`; the `apps/*` glob picks it up automatically.              |
| **Repo tooling / scripts** | `tools/<name>/`                      | Add a `package.json` (Node) — the `tools/*` glob picks it up.                    |

> Go and Node services both live under `services/`. The language is determined by
> whether the directory has a `go.mod` (Go module in `go.work`) or a
> `package.json` (pnpm workspace member). Reserved service/app dirs that contain
> only a `README.md` are intentionally **not** workspace members yet.

Every new service must keep the multi-tenancy invariant: `TenantContext` is
mandatory at every port and storage boundary — tenant identity comes from the
credential, never the request body (see ADR-0002).

## Build, test, lint

CI (`.github/workflows/ci.yml`) runs these exact `make` targets, so running them
locally reproduces CI:

```sh
make go-build     # build every Go module in the workspace
make go-test      # test every Go module
make go-fmt       # fail if any Go file is not gofmt-clean
make go-lint      # golangci-lint across every Go module
make node-install # pnpm install (frozen lockfile)
make node-test    # pnpm -r test
make node-lint    # biome check

make test         # all Go + Node tests
make lint         # all Go + Node lint/format checks
```

### Test-first (TDD)

Every behavior starts with a failing test (red), then the minimal code to pass
(green), then refactor. Go uses table-driven tests; Node uses `node:test`. Commit
at green.

## Commits: Conventional Commits

Commit messages and **PR titles** follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `infra`,
`perf`, `build`, `ci`. Scopes are usually the service/area, e.g.
`feat(ingest): ...`, `fix(processor): ...`, `infra: monorepo scaffolding`.

Breaking changes: add `!` after the type/scope (`feat(api)!: ...`) and a
`BREAKING CHANGE:` footer.

## Merging: squash-merge

We **squash-merge** every PR. Because the merge keeps a single commit, the **PR
title is the commit subject** and must be a valid Conventional Commit. Keep PRs
small and revertible — one issue per PR. Reference the issue in the body with
`Closes #<n>`.

> **Integration-branch note.** Until the platform foundation is merged, PRs target
> the integration branch `feat/logging-platform` (not `main`). Promotion to `main`
> is human-gated. Open PRs with `--base feat/logging-platform`.
