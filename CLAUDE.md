# MathMeander — guidance for AI-assisted development

This is a **model-driven codebase**. Before changing anything substantive, read the
relevant sections of `docs/mvp_architecture.md` —
it is authoritative. Quick index: §5 integrity core · §6 data model + schema (§6.0
MathContent, §6.1 provenance, §6.3 tri-state/ids/migration, §6.4 concurrency) ·
§7 glue/type-sharing · §9.y authoring workflow · §13a build slices · §18 current
assumptions. `docs/adr/0001-initial-setup.md` records setup-phase decisions;
`docs/setup.md` catalogues every structural guard.

## Hard rules (each one is mechanically enforced — expect red builds, not review nits)

- **Never commit or push.** The repo owner manages git history exclusively.
- **The Rust core stays pure**: no I/O, no clock, no env, no FFI, no entropy. Time and
  ids are passed in. (wasm32 check + `cargo tree` denylist + clippy disallowed-methods.)
- **Never hand-write or edit anything in `packages/schema/src/generated/` or
  `packages/schema/artifact/`** — change core types, then `just codegen`. Never declare
  a type whose name exists in the artifact (ESLint bans it).
- **`@mathmeander/core-node` is imported ONLY in `packages/server/src/core/`** (the FFI
  chokepoint; ESLint-enforced). FFI calls are coarse: whole document in/out.
- **No ORMs** — plain SQL in `packages/server/src/db/` (dep-check + ESLint enforced).
- **No native PG enums, no DB-minted ids, no unregistered JSONB columns,
  provenance_id never nullable** (`scripts/lint-migrations.mjs`).
- **Bumping `CURRENT_SCHEMA_VERSION` requires** a registered migration fn + frozen
  fixtures for the prior version (the harness gates the bump itself).
- **Tri-state discipline (§6.3)**: unset ≠ explicitly-empty ≠ value. `Patch<T>` in
  Rust, absent/null/value on the wire, `exactOptionalPropertyTypes` in TS. Never
  collapse them; migrations never backfill.
- **AI/system output never silently becomes user content** (§2.5/§3.9) — when AI
  features land, they propose into review_items; acceptance is explicit.

## Design principles (honored in review — not mechanically enforced)

- **Don't conflate the math and presentation layers (§6).** The core uses mathematicians'
  vocabulary; editor/renderer concepts (ProseMirror, KaTeX) stay in the frontend adapters. A
  name may legitimately appear in both layers (a graph `node` vs an editor `node`) when each is
  independently well-motivated — what's forbidden is letting presentation concepts or _shapes_
  drive the core model (the editor-as-truth risk, §6.0a). No mechanical name check enforces this
  (a token scan is both unsound and incomplete); it is a design-review concern, with semantic
  property tests on `MathContent` planned for slice 1.

## Workflow

- `just --list` is the task index; `just verify` = everything CI runs.
- Adding a core type/field: edit `crates/core`, add conformance cases in
  `schema_artifact.rs`, `just codegen`, then `cargo test -p mathmeander-core
--all-features` AND `pnpm --filter @mathmeander/schema test` (both sides must agree).
- Tests: `just test` (unit) · `just test-integration` (needs `just up db-migrate`) ·
  `just e2e` (browser, whole stack).
- The walking skeleton accepts only `type: "note"`. The formal family
  (theorem/lemma/…), `content_units`/MathContent, links, canonical operations, and
  `.mathpack` are **slice 1** (arch doc §13a) — don't partially introduce them.
