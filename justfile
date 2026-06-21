# Cross-toolchain task conductor. `just --list` is the index; pnpm scripts stay intra-package.

set dotenv-load := true
set shell := ["bash", "-uc"]

default:
    @just --list

# ── Bootstrap ────────────────────────────────────────────────────────────────

# Fresh clone → running dev environment (idempotent).
bootstrap:
    @command -v docker >/dev/null || (echo "ERROR: docker is required (https://docs.docker.com/get-docker/)" && exit 1)
    @command -v rustup >/dev/null || (echo "ERROR: rustup is required (https://rustup.rs)" && exit 1)
    @test -f .env || (cp .env.example .env && echo "Created .env from .env.example")
    @command -v wasm-pack >/dev/null || cargo install wasm-pack
    pnpm install --frozen-lockfile
    just up
    just db-migrate
    cargo build --workspace
    just build-addon
    just build-math-wasm
    just codegen-check
    @echo "✓ bootstrap complete — run 'just dev' → http://localhost:5173"

# ── Dev infra ────────────────────────────────────────────────────────────────

up:
    docker compose up -d --wait
    docker compose run --rm minio-init

down:
    docker compose down

# Dev servers (infra + addon first, explicitly — no implicit ordering surprises).
dev: up build-addon build-math-wasm
    pnpm -r --parallel --stream dev

# ── Build ────────────────────────────────────────────────────────────────────

build-core:
    cargo build -p mathmeander-core

# Debug build is the dev loop (FFI calls are non-hot-path; release rot is caught by CI on main).
build-addon:
    pnpm --filter @mathmeander/core-node build

# The client math runtime: compile the (WASM-clean) surface crate to WASM via wasm-bindgen, emitting
# the ESM glue + .wasm into packages/web/src/wasm/ (gitignored), which the editor imports directly.
# Mirrors build-addon (the napi seam) for the browser. Needs wasm-pack (cargo install wasm-pack).
build-math-wasm:
    wasm-pack build crates/surface-wasm --target web --out-dir ../../packages/web/src/wasm --no-pack

build-addon-release:
    pnpm --filter @mathmeander/core-node build:release

# ── Codegen (the no-drift seam) ──────────────────────────────────────────────

# Core → schema artifact + conformance corpus + hash → generated zod/TS.
codegen:
    cargo run -p mathmeander-schema-gen -- --out packages/schema/artifact
    pnpm --filter @mathmeander/schema generate

# Drift gate: regeneration must be deterministic AND a no-op against committed output.
codegen-check: codegen
    just codegen
    git diff --exit-code -- packages/schema crates/core/fixtures

# ── Database ─────────────────────────────────────────────────────────────────

# dbmate runs inside the compose network: rewrite localhost → the postgres service.
db-migrate:
    docker compose run --rm dbmate --url "${DATABASE_URL/localhost/postgres}" up
    docker compose run --rm dbmate --url "${TEST_DATABASE_URL/localhost/postgres}" --no-dump-schema up

db-reset:
    docker compose run --rm dbmate --url "${DATABASE_URL/localhost/postgres}" drop
    docker compose run --rm dbmate --url "${TEST_DATABASE_URL/localhost/postgres}" --no-dump-schema drop
    just db-migrate

db-new name:
    docker compose run --rm dbmate new {{ name }}

db-seed:
    pnpm --filter @mathmeander/server seed

# ── Tests ────────────────────────────────────────────────────────────────────

test: test-rust test-node

test-rust:
    cargo test --workspace --all-features --locked

# build-math-wasm too: the web vitest/typecheck import the wasm glue, whose output is gitignored (the
# napi addon's .d.ts is committed, so build-addon needs no such gate; the wasm's is not).
test-node: build-addon build-math-wasm
    pnpm -r --no-bail --filter '!@mathmeander/e2e' test

test-integration: build-addon up
    pnpm --filter @mathmeander/server test:integration

e2e: build-addon build-math-wasm up
    pnpm --filter @mathmeander/e2e test

# ── Lint ─────────────────────────────────────────────────────────────────────

lint: lint-rust lint-ts check-core-purity lint-migrations

lint-rust:
    cargo fmt --check
    cargo clippy --workspace --all-targets -- -D warnings

# build-math-wasm first: `pnpm typecheck` checks packages/web, which imports the (gitignored) wasm glue.
lint-ts: build-math-wasm
    pnpm lint
    pnpm format
    pnpm typecheck

check-core-purity:
    cargo check -p mathmeander-core --target wasm32-unknown-unknown
    cargo check -p mathmeander-surface --target wasm32-unknown-unknown
    ./scripts/check-core-deps.sh

lint-migrations:
    node scripts/lint-migrations.mjs

# ── Auth helper ──────────────────────────────────────────────────────────────

# Mint a dev IdP token for curl/scripting (dev-idp must be running).
token email="dev@mathmeander.local":
    curl -s -X POST "http://localhost:${DEV_IDP_PORT:-8788}/token" \
        -H 'content-type: application/json' -d '{"email":"{{ email }}"}'

# ── The whole world, one command (what CI runs) ──────────────────────────────

verify: lint test codegen-check test-integration e2e
    @echo "✓ all gates green"
