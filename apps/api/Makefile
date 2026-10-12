# ghostmplay api
#
# The build target for Voroa is `make build` (or `go build -o bin/api ./cmd/api`),
# and sqlc runs first so the generated code is present. sqlc is a development
# dependency rather than a build-time one: `db/sqlc` is committed, so a deploy
# needs nothing but a Go toolchain.

BIN     := bin/api
PKG     := ./...
DATABASE_URL ?= $(shell sed -n 's/^DATABASE_URL=//p' ../../.env 2>/dev/null | head -1)

.DEFAULT_GOAL := build

.PHONY: build
build: ## Compile the API.
	go build -trimpath -o $(BIN) ./cmd/api

# The watch rules live in .air.toml, so what triggers a rebuild is reviewable in
# a diff rather than buried in a recipe here.
.PHONY: dev
dev: ## Run with live reload.
	@command -v air >/dev/null 2>&1 && { air; exit $$?; }; \
	echo "air is not installed; starting without live reload."; \
	echo "  go install github.com/air-verse/air@latest   # then make dev reloads"; \
	echo; \
	$(MAKE) --no-print-directory run-once

# A single build-and-run, with no watcher. The fallback for `make dev`, and
# usable on its own when you just want to start the thing.
.PHONY: run-once
run-once: ## Build and run once, without a file watcher.
	go run ./cmd/api

.PHONY: generate
generate: ## Regenerate db/sqlc from db/schema.sql and db/queries.
	sqlc generate

.PHONY: baseline
baseline: ## Regenerate the baseline migration from db/schema.sql + db/seeds.sql.
	@./scripts/gen-baseline.sh

.PHONY: check
check: ## Everything CI would run.
	go build ./...
	go vet ./...
	go test -race $(PKG)

.PHONY: lint
lint: ## Static analysis.
	golangci-lint run

.PHONY: fmt
fmt:
	gofmt -l -w .

.PHONY: tidy
tidy:
	go mod tidy

.PHONY: test
test:
	go test $(PKG)

# The migration CLI takes a postgres:// URL, while the app takes DATABASE_URL
# in whatever form it was configured with. Two adjustments:
#
#   - the scheme is normalised, so "postgres://host/db" and "postgresql://host/db"
#     both work;
#   - sslmode is defaulted to disable. The lib/pq driver the CLI uses asks for TLS
#     by default, which a local development database does not offer, so without
#     this every local migration fails with "SSL is not enabled". A URL that
#     already carries sslmode is left alone, which is how a managed host with a
#     proper certificate chain is reached.
MIGRATE_URL = postgres://$(subst postgresql://,postgres://,$(DATABASE_URL))
ifeq (,$(findstring sslmode=,$(DATABASE_URL)))
MIGRATE_URL := $(MIGRATE_URL)?sslmode=$(if $(DATABASE_SSL),require,disable)
endif

.PHONY: migrate-up
migrate-up: ## Run pending migrations against DATABASE_URL.
	migrate -path db/migrations -database "$(MIGRATE_URL)" up

.PHONY: migrate-down
migrate-down:
	migrate -path db/migrations -database "$(MIGRATE_URL)" down 1

# Adopting an existing database. `force` records the version WITHOUT running
# anything, which is how a database that already ran the previous TypeORM
# migrations is brought under the baseline without the baseline being executed
# on top of it.
#
#   make migrate-force VERSION=1
.PHONY: migrate-force
migrate-force: ## Adopt an existing TypeORM-migrated database. Usage: make migrate-force VERSION=1
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make migrate-force VERSION=1"; exit 1; }
	migrate -path db/migrations -database "$(MIGRATE_URL)" force $(VERSION)

.PHONY: migrate-version
migrate-version:
	migrate -path db/migrations -database "$(MIGRATE_URL)" version

.PHONY: clean
clean:
	rm -rf $(BIN)

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'