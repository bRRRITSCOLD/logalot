# Logalot — local stack control.
# All targets drive the single docker-compose.yml against a single `.env`.

COMPOSE := docker compose --env-file .env

# Load .env (when present) so the migrate runner can build DATABASE_URL from the
# same Postgres creds compose uses. `-include` is silent before the first `make up`
# creates .env from the template.
-include .env

# ----------------------------------------------------------------------------
# Migrations (golang-migrate via docker — no host install needed; see
# docs/data/migration-plan.md §2). The runner joins the compose `logalot` network
# and reaches Postgres by service hostname.
#
#   MIGRATE_DATABASE_URL = the ADMIN/migrate role (POSTGRES_USER). It OWNS the
#   schema and runs DDL. Services must NOT use it — they connect as the
#   NOSUPERUSER `logalot_app` role (see .env.example LOGALOT_APP_DATABASE_URL),
#   provisioned by migration 000011.
# ----------------------------------------------------------------------------
MIGRATE_IMAGE        := migrate/migrate:v4.18.1
MIGRATE_DATABASE_URL := postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)?sslmode=disable
MIGRATE_RUN          := docker run --rm --network logalot -v $(CURDIR)/migrations:/m $(MIGRATE_IMAGE) \
	-path=/m -database "$(MIGRATE_DATABASE_URL)"

.DEFAULT_GOAL := help
.PHONY: help up down logs ps reset seed \
	migrate-up migrate-down migrate-version migrate-create \
	go-sync go-build go-test go-fmt go-lint \
	node-install node-test node-lint \
	test lint

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -e 's/## //' | awk -F': ' '{printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

# Create .env from the template on first run so `make up` works out of the box.
.env:
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")

## up: start the full stack in the background
up: .env
	$(COMPOSE) up -d

## down: stop and remove containers (keeps volumes)
down:
	$(COMPOSE) down

## logs: tail logs from all services
logs:
	$(COMPOSE) logs -f

## ps: show service status and health
ps:
	$(COMPOSE) ps

## reset: stop everything and wipe all named volumes (destructive)
reset:
	$(COMPOSE) down -v

## migrate-up: apply all pending migrations (admin role)
migrate-up:
	$(MIGRATE_RUN) up

## migrate-down: roll back exactly one migration (use again to step further)
migrate-down:
	$(MIGRATE_RUN) down 1

## migrate-version: print the current schema version
migrate-version:
	$(MIGRATE_RUN) version

## migrate-create: scaffold a new pair, e.g. `make migrate-create name=add_widgets`
migrate-create:
	@test -n "$(name)" || (echo "usage: make migrate-create name=<description>" && exit 1)
	docker run --rm -v $(CURDIR)/migrations:/m $(MIGRATE_IMAGE) \
		create -ext sql -dir /m -seq $(name)

## seed: load the DEV tenant + admin + API key (migrations/seeds/dev_tenant.sql)
# Runs against the running compose postgres as the admin role. Idempotent: every
# insert is ON CONFLICT DO NOTHING, so re-running is safe (the API-key secret is
# only printed by this seed file's header — it is shown once, here, by design).
seed:
	docker exec -i logalot-postgres \
		psql "postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@localhost:5432/$(POSTGRES_DB)?sslmode=disable" \
		-v ON_ERROR_STOP=1 -f - < migrations/seeds/dev_tenant.sql

# ----------------------------------------------------------------------------
# Monorepo CI helpers. CI (.github/workflows/ci.yml) calls these same targets,
# so `make` locally reproduces CI exactly (DRY). The Go workspace has no single
# root module, so we iterate every module dir reported by the workspace.
# ----------------------------------------------------------------------------

GO_MODULE_DIRS = $(shell go list -m -f '{{.Dir}}')

## go-sync: sync the Go workspace (go.work)
go-sync:
	go work sync

## go-build: build every Go module in the workspace
go-build: go-sync
	@for d in $(GO_MODULE_DIRS); do echo ">> go build $$d"; (cd $$d && go build ./...) || exit 1; done

## go-test: test every Go module in the workspace
go-test: go-sync
	@for d in $(GO_MODULE_DIRS); do echo ">> go test $$d"; (cd $$d && go test ./...) || exit 1; done

## go-fmt: fail if any Go file is not gofmt-clean
go-fmt:
	@out=$$(gofmt -l .); if [ -n "$$out" ]; then echo "gofmt needed on:"; echo "$$out"; exit 1; fi; echo "gofmt clean"

## go-lint: run golangci-lint in every Go module (requires golangci-lint v2)
go-lint:
	@for d in $(GO_MODULE_DIRS); do echo ">> golangci-lint $$d"; (cd $$d && golangci-lint run ./...) || exit 1; done

## node-install: install pnpm workspace deps (frozen lockfile)
node-install:
	pnpm install --frozen-lockfile

## node-test: run tests across the pnpm workspace
node-test:
	pnpm -r test

## node-lint: run biome across the repo
node-lint:
	pnpm lint

## test: run all Go + Node tests
test: go-test node-test

## lint: run all Go + Node lint/format checks
lint: go-fmt go-lint node-lint
