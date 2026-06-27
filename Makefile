# Logalot — local stack control.
# All targets drive the single docker-compose.yml against a single `.env`.

COMPOSE := docker compose --env-file .env

.DEFAULT_GOAL := help
.PHONY: help up down logs ps reset seed

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
