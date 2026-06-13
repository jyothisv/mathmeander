# ADR 0001 — Initial setup: foundations + walking skeleton

Date: 2026-06-12 · Status: accepted (implemented)

## Context

Greenfield build of the platform specified by `docs/mvp_architecture v17.md`. This phase
delivered repository foundations plus a walking skeleton proving every architectural
seam end-to-end (web → HTTP → glue → napi → Rust core → Postgres → back, typed
throughout), deliberately **not** §13a slice 1 (the full canonical object core), which
builds next on these proven rails.

Locked with the owner: local Docker dev infra (hosted Neon/R2/Fly at first deploy);
auth = real JWKS seam with a local dev issuer (hosted IdP later = env swap); latest
stable versions of everything, pinned exactly; no shortcuts — every deferral must be
structurally additive.

## Decisions (and the two flagged deviations from the arch doc's examples)

1. **Type sharing: `schemars` → versioned JSON Schema artifact → `json-schema-to-zod`**
   (deviation in tool from the doc's ts-rs/specta example, §4/§7/§17; approved in plan
   review). The doc's normative requirement — artifact emitted by the core, generated
   TS **+ zod**, drift = build error — is met more literally this way: ts-rs emits TS
   source only (zod would be hand-written, which the doc forbids). A `oneOf → anyOf`
   transform in the generator mirrors serde's try-in-order union semantics and yields
   properly typed `z.union`s. Probed before dependence: a 57-case conformance corpus
   (tagged unions, uuid/datetime formats, offset timestamps, Option/null/absent,
   flattened unions, untagged envelopes) must produce identical serde and zod verdicts.
   Fallback if the generator ever falls short (e.g. recursive MathContent unions): a
   bespoke artifact→zod emitter behind the SAME artifact contract.
2. **SQL migrations: dbmate** (deviation from the doc's node-pg-migrate example, §6.3;
   approved). Plain SQL is first-class (the later schema needs `GENERATED ALWAYS AS`,
   composite FKs, partial unique indexes, `NULLS NOT DISTINCT`); the committed
   `db/schema.sql` dump serves the §6 transparency principle; one static binary suits a
   two-toolchain repo. Object-content migration remains the Rust core's job — two
   independent tiers (see `docs/setup.md`).
3. **No CHECK constraints on evolving kind columns** (`type`/`status`/`origin` are text
   validated only by the core). The doc makes CHECKs optional; one vocabulary home
   means slice 1 adds `theorem`/`lemma`/… with zero migration churn.
4. **The core mints nothing**: uuid built without generation features, chrono without
   `clock` — entropy and clocks are structurally absent, not just forbidden. Ids are
   client-minted (objects) or glue-minted (provenance/sessions); the core validates
   UUIDv7 version bits at create time with typed errors.
5. **Unknown-field preservation** (§2.2): `CanonicalObject` carries a flattened `extra`
   map; foreign fields survive parse → edit → store round trips; fixtures assert it.
6. **Artifact-hash lockstep**: `crates/core-node/build.rs` embeds the sha256 of the
   artifact derived from the exact core it compiles against; the server refuses to boot
   on mismatch with `@mathmeander/schema`. Catches the stale-addon case the codegen diff
   cannot.
7. **Auth shape**: IdP JWT (RS256, remote JWKS) is exchanged ONCE for an opaque server
   session token (sha256 hash stored); single-active-session enforced in one policy
   module; the sessions schema deliberately permits multiple active rows (§7/§12 —
   policy, not data model). The dev issuer (`packages/dev-idp`) uses ephemeral keys
   and stable uuidv5 subjects; it hard-fails in production.
8. **Result envelopes over the FFI**: `{ok:true,value}|{ok:false,error}` with typed
   `CoreError`/`ValidationError` unions in the artifact — domain failures are values;
   the HTTP error envelope's `code` IS the serde tag (no glue interpretation).
9. **TS module strategy**: `moduleResolution: bundler` + tsx at runtime across packages
   (cross-package TS-source imports without extension ceremony); `exactOptionalPropertyTypes`
   everywhere (load-bearing for §6.3 tri-state).
10. **ESLint 9 + Prettier over Biome**: the debt guards need `no-restricted-imports` /
    `no-restricted-syntax` (FFI chokepoint, ORM ban, artifact-name ban).
11. **Pinned stack** (latest stable, 2026-06-12): Rust 1.96.0 · napi-rs 3.9.1 ·
    schemars 1.2.1 · Node 24.4.1 · pnpm 10.24.0 · TS 6.0.3 · zod 4.4.3 · Fastify 5.8.5 ·
    React 19.2.7 · Vite 8.0.16 · TanStack Router 1.170 / Query 5.101 · Playwright 1.60 ·
    postgres:18.4-alpine · dbmate 2.33 · MinIO 2025-09-07. Bumps are deliberate PRs.

## Deferred (each structurally additive — nothing built now changes shape)

| Deferred                                                                                                                                | Lands                    | Why additive                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `content_units`/MathContent, links/aliases/tags, detail tables, canonical unit ops, `.mathpack`, `object_versions`, formal-family types | Slice 1                  | New tables FK-ing `objects`; new core types + artifact bump; an object with zero units is valid     |
| Provenance AI/import columns, `provenance_derivations`, review/inbox/snapshot tables                                                    | AI/review slices         | `ADD COLUMN` nullable-by-origin (names fixed by §6); `Origin` enum already complete                 |
| ProseMirror/KaTeX/PDF.js; `sources` + storage client (MinIO already runs)                                                               | Slices 2–3               | Frontend adapters behind existing routes/mutations; storage adapter arrives with its first consumer |
| Search projection + pg_trgm/tsvector, pg-boss, SSE, rate limiting, Sentry                                                               | First consumer           | Derived projection / new module / middleware on the existing chain                                  |
| Hosted IdP, Neon/R2/Fly configs, napi prebuilds, turborepo, renovate                                                                    | First deploy / CI pain   | Env swap; 12-factor config in place; CI already builds the Linux release addon on main              |
| WASM core build (shipping)                                                                                                              | Offline/native (§12/§14) | The wasm32 _check_ already gates purity on every commit                                             |

## Consequences

Slice 1 lands inside operating machinery: the artifact pipeline, migration harness,
purity guards, concurrency convention, and test harnesses all exist and are exercised.
The §13a slice-2 ownership prototype remains the gate before heavy AI/PDF work.
