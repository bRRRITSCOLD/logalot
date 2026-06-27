# Logalot — local stack control.
# All targets drive the single docker-compose.yml against a single `.env`.

COMPOSE := docker compose --env-file .env

.DEFAULT_GOAL := help
.PHONY: help up down logs ps reset seed \
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

## seed: placeholder — migrate + seed runner is wired up in issue #3
seed:
	@echo "seed is not implemented here. The migration + seed runner"
	@echo "(NOSUPERUSER logalot_app role, golang-migrate, dev seed) lands in issue #3."
	@echo "See docs/data/migration-plan.md once #3 is merged."

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
