# Logalot — local stack control.
# All targets drive the single docker-compose.yml against a single `.env`.

COMPOSE := docker compose --env-file .env

# Slice overlay (issue #9): infra stack + the three slice services. Used by the
# `slice-*` targets only; the bare `up`/`down` targets stay infra-only.
COMPOSE_SLICE := docker compose --env-file .env -f docker-compose.yml -f docker-compose.slice.yml

# The slice services that COMPOSE_SLICE adds on top of the infra stack.
# alert-evaluator joins so UI alert rules actually evaluate (OK<->firing) in the
# local loop — it's a background worker (no HTTP port), not part of the #9 demo path.
SLICE_SERVICES := ingest-service processor query-service alert-evaluator

# Host-published ports for the slice services (mirror .env.example defaults so the
# help text/echo is correct even before these are added to .env).
INGEST_PORT ?= 8080
QUERY_PORT  ?= 8081
CONTROL_PLANE_PORT ?= 8082
MAILHOG_UI_PORT ?= 8025

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

# ----------------------------------------------------------------------------
# Multi-arch image publishing (docker buildx).
# Prerequisites: `docker buildx create --use` and `docker login ghcr.io`.
# REGISTRY / OWNER can be overridden at the call site.
# ----------------------------------------------------------------------------
REGISTRY ?= ghcr.io
# Derive OWNER from the remote URL so any contributor pushes to the correct namespace.
# This matches github.repository_owner used in CI (safer than git config user.name).
OWNER    ?= $(shell git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+)/[^/.]+(\.git)?$$|\1|' | tr '[:upper:]' '[:lower:]')
IMAGE_PREFIX := $(REGISTRY)/$(OWNER)/logalot
PLATFORMS    := linux/amd64,linux/arm64

# Go services that share the parameterised Dockerfile via SERVICE=
GO_SERVICES := ingest-service processor query-service alert-evaluator retention-worker

.DEFAULT_GOAL := help
.PHONY: help up down logs ps reset seed \
	migrate-up migrate-down migrate-version migrate-create \
	slice-up slice-down slice-logs slice-demo slice-test mimic-logs mimic-logs-stream \
	dev dev-up dev-down dev-logs \
	cold-tier-spike cold-tier-spike-athena cold-smoke-aws \
	go-sync go-build go-test go-fmt go-lint \
	node-install node-test node-test-integration node-lint node-typecheck \
	infra-test security-r-inv-gate \
	test lint \
	buildx-go buildx-control-plane buildx-web buildx-all

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
# Vertical slice (issue #9): the running ingest -> store -> live tail demo.
# slice-up reuses the existing migrate-up + seed targets (DRY) and brings up the
# three services from docker-compose.slice.yml on top of the infra stack.
#
# NOTE: only postgres/redis/rabbitmq are started (the slice does not need
# mongodb/floci), and `--wait` blocks until their healthchecks pass so migrate
# and the services never race a cold dependency. If host ports 5672/6379/27017
# are taken (e.g. a `burrow` stack), override *_PORT in .env — see docs/demo.md.
# ----------------------------------------------------------------------------

## slice-up: bring up the full slice (infra + migrate + seed + the 3 services)
slice-up: .env
	$(COMPOSE) up -d --wait postgres redis rabbitmq mailhog
	$(MAKE) migrate-up
	$(MAKE) seed
	$(COMPOSE_SLICE) up -d --build $(SLICE_SERVICES)
	@echo ""
	@echo "slice up. ingest -> http://localhost:$(INGEST_PORT) | query -> http://localhost:$(QUERY_PORT)"
	@echo "dev API key: lgk_dev_devkey001_devsecret0123456789  (see docs/demo.md)"
	@echo "mailhog UI -> http://localhost:$(MAILHOG_UI_PORT)  (invite emails, EMAIL_PROVIDER=smtp)"

## slice-down: stop the slice services AND the infra (keeps volumes)
slice-down:
	$(COMPOSE_SLICE) down

## slice-logs: follow logs from the three slice services
slice-logs:
	$(COMPOSE_SLICE) logs -f $(SLICE_SERVICES)

## slice-demo: POST a log with the dev key, then live-tail it (proves <2s)
slice-demo:
	@bash scripts/slice-demo.sh

## mimic-logs: stream realistic app logs into the platform (env: RATE=, COUNT=)
mimic-logs:
	@bash scripts/mimic-app-logs.sh

## mimic-logs-stream: same, but at random/jittered gaps (env: MIN=, MAX=, COUNT=)
mimic-logs-stream:
	@bash scripts/mimic-app-logs-stream.sh

## slice-test: run the hermetic e2e isolation test (testcontainers; needs Docker)
slice-test:
	cd tests/e2e && go test -tags=e2e -run TestSliceE2E -v -timeout 300s ./...

# ----------------------------------------------------------------------------
# Full local app loop (the UI's backends). slice-up gives infra + ingest/
# processor/query-service; the control-plane is NOT containerized (it's the Node
# auth/admin service the web login/admin/alerts pages call), so dev-up also boots
# it via scripts/dev-control-plane.sh. Run the web UI separately with
# `pnpm --filter @logalot/web dev` (it defaults CONTROL_PLANE_URL=:8082,
# QUERY_SERVICE_URL=:8081, so no extra config).
#
# Dev login (from `make seed`): workspace `dev` / admin@dev.local / devpassword.
# ----------------------------------------------------------------------------

## dev: start the whole app — backend (dev-up) + web UI in the foreground
dev: dev-up
	@echo ""
	@echo "starting web UI -> http://localhost:3000"
	@echo "(Ctrl-C stops the web UI; the backend keeps running — 'make dev-down' stops it)"
	pnpm --filter @logalot/web dev

## dev-up: full app backend — slice (infra+ingest+processor+query) + control-plane
dev-up: slice-up
	@bash scripts/dev-control-plane.sh start
	@echo ""
	@echo "app backend up:"
	@echo "  control-plane -> http://localhost:$(CONTROL_PLANE_PORT)   (login/admin/alerts)"
	@echo "  query-service -> http://localhost:$(QUERY_PORT)   (search + live tail)"
	@echo "  ingest        -> http://localhost:$(INGEST_PORT)"
	@echo "next: pnpm --filter @logalot/web dev   then open http://localhost:3000"
	@echo "login: workspace 'dev' / admin@dev.local / devpassword"

## dev-down: stop the control-plane and the slice + infra
dev-down:
	@bash scripts/dev-control-plane.sh stop
	$(MAKE) slice-down

## dev-logs: follow the control-plane log
dev-logs:
	@bash scripts/dev-control-plane.sh logs

## cold-tier-spike: run the cold-tier Firehose+Glue fidelity spike against compose floci (issue #13)
# Requires: make up (floci must be healthy at FLOCI_ENDPOINT / localhost:4566).
# Expected result: GlueCatalogFidelity/DirectS3WriteKeyLayout/GlueExplicitPartitionRegistration PASS;
# FirehoseDeliveryFidelity FAIL (raw NDJSON, not Parquet; placeholders not substituted — see docs/data/spikes/013-).
cold-tier-spike: .env
	go test -tags=floci_spike -run TestColdTierFidelity -v -timeout 300s ./tests/cold-tier-spike/...

## cold-tier-spike-athena: run the Athena query template + injected-projection fidelity spike (issue #14)
# Requires: make up (floci must be healthy at FLOCI_ENDPOINT / localhost:4566).
# Expected result: ParquetSeedAndDirectRead/EngineIdentity/DuckDBEquivalents/CrossTenantGlobLeak PASS;
# PrestoFunction_*/GlueBridge_*/InjectedProjectionEnforcement FAIL — floci Athena = DuckDB v1.5.2,
# no Glue catalog bridge, no Presto functions, no injected-projection enforcement. See docs/data/spikes/014-.
cold-tier-spike-athena: .env
	go test -tags=floci_spike -run TestAthenaProjectionFidelity -v -timeout 300s ./tests/cold-tier-spike/...

## cold-smoke-aws: run the real-AWS cold-tier smoke canary (decision 016 §7, issue #107)
# Requires: real AWS credentials + resources provisioned by infra/aws (terraform apply).
# Required env vars: COLD_BUCKET, COLD_GLUE_DB, COLD_ATHENA_RESULT_BUCKET.
# Optional: COLD_ATHENA_WORKGROUP (default: primary), AWS_REGION (default: us-east-1).
# The test skips cleanly when these vars are absent so normal local runs are unaffected.
cold-smoke-aws:
	go test -tags=cold_smoke_aws -run TestColdTierSmoke_AWS -v -timeout 10m ./tests/cold-tier-smoke/...

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

## node-test-integration: Docker-backed integration suite (testcontainers Postgres/Redis).
# Kept separate from node-test because it requires a container runtime.
# Discharges the Critical/High R-INV invariants that only an atomic-transaction
# / RLS-armed Postgres can prove (R-INV-3, R-INV-15, R-INV-17, migration
# CHECK/UNIQUE constraints) — see issue #161.
node-test-integration:
	pnpm --filter @logalot/control-plane test:integration

## node-lint: run biome across the repo
node-lint:
	pnpm lint

## node-typecheck: run tsc --noEmit across the typed TS packages (control-plane, contracts, web)
# apps/web's `typecheck` script runs `pnpm build` first: its tsc needs the
# gitignored TanStack route-tree (src/routeTree.gen.ts) + design tokens
# (src/styles/tokens.css), both regenerated by the vite build (issue #131).
node-typecheck:
	pnpm --filter @logalot/control-plane exec tsc --noEmit
	pnpm --filter @logalot/contracts exec tsc --noEmit
	pnpm --filter @logalot/web run typecheck

## infra-test: log-capture integration test for the Caddy access-log hygiene
# fix (issue #158, R-INV-12) — runs the real infra/aws/Caddyfile in Docker and
# asserts the invite-accept token never lands in the access log.
infra-test:
	./infra/aws/caddyfile-log-hygiene.integration.sh

## security-r-inv-gate: assert every Critical/High R-INV requirement (issue #161)
# still has a live, named discharging test. Cheap/no-Docker drift guard —
# the invariants themselves are proven by node-test + node-test-integration.
security-r-inv-gate:
	./scripts/r-inv-gate-assert.sh

## test: run all Go + Node tests
test: go-test node-test

## lint: run all Go + Node lint/format checks
lint: go-fmt go-lint node-lint

# ----------------------------------------------------------------------------
# Multi-arch buildx targets (local load or registry push).
# Usage:
#   make buildx-go SERVICE=ingest-service          # build for local daemon (native arch)
#   make buildx-go SERVICE=ingest-service PUSH=--push  # push multi-arch to registry
#   make buildx-control-plane PUSH=--push
#   make buildx-web PUSH=--push
#   make buildx-all PUSH=--push                    # all 7 images, pushed to registry
# ----------------------------------------------------------------------------
PUSH ?= --load

# docker buildx --load uses the docker exporter which cannot produce a multi-platform
# manifest list ("docker exporter does not currently support exporting manifest lists").
# Restrict to the native arch when loading; use all target platforms when pushing.
ifeq ($(PUSH),--load)
BUILD_PLATFORMS := linux/$(shell go env GOARCH)
else
BUILD_PLATFORMS := $(PLATFORMS)
endif

## buildx-go: build a single Go service image for linux/amd64+arm64 (SERVICE= required)
buildx-go:
	@test -n "$(SERVICE)" || (echo "usage: make buildx-go SERVICE=<name>" && exit 1)
	docker buildx build \
		--platform $(BUILD_PLATFORMS) \
		--build-arg SERVICE=$(SERVICE) \
		-t $(IMAGE_PREFIX)-$(SERVICE):dev \
		$(PUSH) \
		-f Dockerfile .

## buildx-control-plane: build the control-plane image for linux/amd64+arm64
buildx-control-plane:
	docker buildx build \
		--platform $(BUILD_PLATFORMS) \
		-t $(IMAGE_PREFIX)-control-plane:dev \
		$(PUSH) \
		-f Dockerfile.control-plane .

## buildx-web: build the web image for linux/amd64+arm64
buildx-web:
	docker buildx build \
		--platform $(BUILD_PLATFORMS) \
		-t $(IMAGE_PREFIX)-web:dev \
		$(PUSH) \
		-f Dockerfile.web .

## buildx-all: build all 7 multi-arch images (set PUSH=--push to publish)
buildx-all:
	@for svc in $(GO_SERVICES); do \
		echo ">> buildx $$svc"; \
		$(MAKE) buildx-go SERVICE=$$svc PUSH=$(PUSH) || exit 1; \
	done
	$(MAKE) buildx-control-plane PUSH=$(PUSH)
	$(MAKE) buildx-web PUSH=$(PUSH)
