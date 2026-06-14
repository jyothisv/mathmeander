# MathMeander

A personal mathematical knowledge workspace for serious learners of higher mathematics —
definitions, theorems, proofs, examples, sources, trails, and (eventually) computational
explorations as first-class interconnected objects, with AI as a careful assistant rather
than an authority.

**Authoritative design documents** (read these first; the code conforms to them):
[docs/mvp_direction.md](docs/mvp_direction.md) (product) and
[docs/mvp_architecture.md](docs/mvp_architecture.md) (architecture).
Setup-phase decisions are recorded in [docs/adr/0001-initial-setup.md](docs/adr/0001-initial-setup.md);
the guard catalogue lives in [docs/setup.md](docs/setup.md).

## Architecture in one paragraph

A pure **Rust integrity core** (`crates/core`) owns the canonical model: types,
validation, schema migration, serialization. A **TypeScript glue tier**
(`packages/server`, Fastify) reaches it in-process via a **napi-rs addon**
(`crates/core-node`) and owns HTTP, auth/sessions, and a plain-SQL Postgres layer.
The core emits a **versioned JSON Schema artifact** from which all TS types and zod
validators are **generated** (`packages/schema`) — drift between Rust and TS is a build
error, enforced three ways (CI regeneration diff, a 57-case serde↔zod conformance
corpus, and a compile-time artifact-hash handshake the server checks at boot).
The **React frontend** (`packages/web`) talks through one typed fetch chokepoint that
zod-parses every response. Auth is a hosted-IdP-shaped seam: a local dev issuer
(`packages/dev-idp`) signs RS256 JWTs verified via remote JWKS — swapping in a real IdP
is an env-var change.

## Quickstart

Prerequisites: [Docker](https://docs.docker.com/get-docker/), [rustup](https://rustup.rs),
and [mise](https://mise.jdx.dev) (or manually matching the versions in `mise.toml`).

```sh
mise install      # node, pnpm, just (Rust is pinned by rust-toolchain.toml)
just bootstrap    # .env, deps, dev infra, migrations, addon build, codegen check
just db-seed      # dev user (dev@mathmeander.local) + welcome note
just dev          # → http://localhost:5173 (sign in as dev@mathmeander.local)
```

`just --list` shows every task. `just verify` runs everything CI runs.

## Repository map

| Path                | What                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `crates/core`       | The integrity core (pure Rust — no I/O, no clock, no FFI; guarded by CI) |
| `crates/core-node`  | napi-rs bindings — one-line delegations, the ONLY napi crate             |
| `crates/schema-gen` | Writes the core-emitted schema artifact + conformance corpus             |
| `packages/schema`   | Generated zod + TS types from the artifact (never hand-edited)           |
| `packages/server`   | Fastify glue: auth, sessions, plain-SQL layer, object API                |
| `packages/dev-idp`  | Local OIDC-shaped dev issuer (ephemeral keys; dev only)                  |
| `packages/web`      | React + Vite + TanStack Router/Query + Zustand                           |
| `e2e`               | Playwright walking-skeleton specs (whole stack)                          |
| `db`                | dbmate migrations + committed `schema.sql` dump                          |
| `docs`              | Design docs, ADRs, jsonb registry, setup/guards guide                    |

## License

MathMeander is free software, licensed under the **GNU Affero General Public License, version
3 or (at your option) any later version** (`AGPL-3.0-or-later`). The full text is in
[LICENSE](LICENSE).

The AGPL's §13 matters here: if you run a modified MathMeander as a network service, you must
offer its users the corresponding source.

Copyright © 2026 Jyothis Vasudevan.
