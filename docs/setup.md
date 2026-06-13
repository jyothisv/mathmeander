# Setup guide & guard catalogue

## Fresh clone → running app

```sh
mise install        # node / pnpm / just from mise.toml; rustup reads rust-toolchain.toml
just bootstrap      # .env, pnpm install, compose up, migrations, builds, codegen check
just db-seed        # dev@mathmeander.local + welcome note (idempotent, fixed ids)
just dev            # dev-idp :8788 · server :8787 · web :5173
just verify         # everything CI runs, one command
```

Sign in at http://localhost:5173 as `dev@mathmeander.local` (any email works; the dev
issuer mints an identity for it — same email = same user across restarts).

## The guard catalogue (trap → mechanism → where it fires)

Convention: every guard has been **proven by breaking it once**. If a check below goes
red, it is doing its job — fix the cause, never the check.

| #   | Trap                                     | Mechanism                                                                                                                                                                                                                                                                                | Fires in                            |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | Hand-written TS copies of core types     | `packages/schema/src/generated/**` is generated-only; CI `codegen` job regenerates and requires a clean `git diff`; ESLint bans declaring any artifact type name outside `packages/schema` (from generated `banned-names.json`); the API client + FFI chokepoint zod-parse every payload | CI `codegen`, `pnpm lint`, runtime  |
| 2   | Core grows I/O / clock / FFI / entropy   | `cargo check -p mathmeander-core --target wasm32-unknown-unknown`; `scripts/check-core-deps.sh` (`cargo tree` vs denylist); `crates/core/clippy.toml` disallowed-methods; chrono built without `clock`, uuid without `v7` generation; napi isolated in `crates/core-node`                | CI `rust`, `just lint`              |
| 3   | JSONB dumping grounds (§6.1d)            | `scripts/lint-migrations.mjs` rejects any jsonb column not registered in `docs/jsonb-registry.md`                                                                                                                                                                                        | `just lint`, CI `node`              |
| 4   | Native PG enums on evolving kinds        | migration linter forbids `AS ENUM`; vocabularies live in the Rust core only (no CHECKs to drift)                                                                                                                                                                                         | `just lint`, CI `node`              |
| 5   | ORM creep                                | ESLint `no-restricted-imports` (prisma/drizzle/typeorm/knex/kysely/…)                                                                                                                                                                                                                    | `pnpm lint`                         |
| 6   | Migration harness skipped "until needed" | the harness walks `1..=CURRENT_SCHEMA_VERSION` and fails if any version lacks fixtures or a migration fn — the version bump itself is gated                                                                                                                                              | `cargo test`                        |
| 7   | Stale addon vs schema package            | addon embeds the artifact sha256 at compile time; the server **refuses to boot** unless it equals `@mathmeander/schema`'s `ARTIFACT_HASH`; same assertion in the addon test                                                                                                              | boot, `just test-node`              |
| 8   | Provenance made nullable "for now"       | NOT NULL + FK in DDL; one-transaction create (rollback proven in integration tests); migration linter flags `provenance_id DROP NOT NULL`                                                                                                                                                | DDL, tests, linter                  |
| 9   | `raw_source` not preserved verbatim      | byte-equality integration test over LaTeX/unicode/CRLF fixture + e2e asserts post-reload; no normalization function exists in the core                                                                                                                                                   | `just test-integration`, `just e2e` |
| 10  | Dev issuer becomes load-bearing          | one JWKS verification path, no bypass flag anywhere; dev-idp hard-fails under `NODE_ENV=production`; second-issuer swap proven in integration tests                                                                                                                                      | tests, boot                         |
| 11  | Single-session leaks into the data model | sessions schema permits multiple active rows; revocation lives only in `auth/policy.ts`                                                                                                                                                                                                  | code structure                      |
| 12  | Secrets in git                           | gitleaks in CI; `.env` gitignored; dev IdP keys are ephemeral (generated at boot — nothing to commit)                                                                                                                                                                                    | CI `gitleaks`                       |
| 13  | Chatty FFI                               | api functions take/return whole documents; addon exports are one-line delegations reviewed per addition                                                                                                                                                                                  | code structure                      |
| 14  | Core semantics duplicated in TS          | generated zod checks transport shape only; the ONE hand-written-zod exception is `config/env.ts` (infra config, not core data)                                                                                                                                                           | convention + guard 1                |
| 15  | serde/zod silent divergence              | the 57-case conformance corpus runs through BOTH serde (`cargo test --all-features`) and generated zod (`pnpm --filter @mathmeander/schema test`); identical verdicts required                                                                                                           | both test suites                    |

### Review-enforced principles (not mechanical guards)

Some boundaries are judgment, not decidable invariants — a mechanical check would be either
unsound or incomplete, so they are enforced in design review instead.

- **Don't conflate the math and presentation layers (§6).** The core models mathematics in
  mathematicians' vocabulary; editor/renderer concepts (ProseMirror, KaTeX) live only in the
  frontend adapters. A name may appear in both layers (a graph `node` vs an editor `node`) when
  each is independently well-motivated in its layer — what's forbidden is letting presentation
  concepts or shapes drive the core model (the editor-as-truth risk, §6.0a). This was previously a
  name denylist test; it was removed because a token scan is both unsound (it flags legitimate
  shared vocabulary) and incomplete (editor-shaped data with innocent field names sails through).
  When slice-1 `MathContent`/canonical operations land, enforce it with semantic property tests on
  the content model's shape/behaviour, not by re-adding a name scan.

### Checks that need committed state (run after your first commit)

`just codegen-check` diffs regenerated output against **git** — with everything
untracked it passes vacuously. After committing, prove it once: append anything to
`packages/schema/src/generated/schemas.ts`, run `just codegen-check` (must go red
because regeneration differs from the committed file), then restore. Similarly,
gitleaks and branch protection only act once the repo is pushed to GitHub.

## Two-tier migrations (who owns what)

- **SQL structure** — dbmate (`db/migrations/*.sql`, plain SQL, `just db-new <name>`),
  dumped to the committed `db/schema.sql`.
- **Object content** — the Rust core: bump `CURRENT_SCHEMA_VERSION`, register a total
  `v_n → v_{n+1}` function in `crates/core/src/migrate.rs`, freeze the prior version's
  fixtures under `crates/core/fixtures/v{n}/`. The harness enforces all three together.
  `parse_and_migrate_object` runs on every read, so old rows migrate on touch.

## Ports & services

| Thing            | Where                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| web (Vite)       | http://localhost:5173                                                 |
| server (Fastify) | http://localhost:8787 (`/healthz` shows core version + artifact hash) |
| dev-idp          | http://localhost:8788 (`/jwks.json`, `POST /token`)                   |
| Postgres 18      | localhost:5432 (`mathmeander_dev`, `mathmeander_test`)                |
| MinIO            | localhost:9000 (console :9001) — infra only until slice 3             |
