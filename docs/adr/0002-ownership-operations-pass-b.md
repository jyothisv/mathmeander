# ADR 0002 — Ownership operations: re-homing vs origin-reference (slice 2a)

Date: 2026-06-18 · Status: accepted (implemented)

## Context

Slice 2 (the editor + the §9.y authoring workflow) hangs on one storage decision the arch doc
(§18.5/§9.y) mandates settling FIRST, with a prototype, before anything depends on it: **when a unit
declared inside a host writing surface materializes into a graph object, where does its content
physically live?** Two candidates:

- **Re-homing** — the declared subtree MOVES into the new object, which then owns its `content_units`
  _and_ its `object_versions`; the host keeps showing it through one `Embed{target: Object}` unit (the
  object's "appearance", §18.18).
- **Origin-reference** — the content stays in the host; the object is a by-reference pointer into it.

This was prototyped HEADLESS (no editor) at the core + glue + API layer, with the §9.y storage-contract
matrix exercised end-to-end through the real HTTP chokepoint, and origin-reference scored as a
harness-only side-by-side (never modeled). 2a is built in two passes: Pass A (the pure-core ops —
`rehome_subtree`/`dissolve_object`, ids preserved, reviewable-refusal gate, proptested) and Pass B
(the cross-object persist + endpoints + the matrix harness, recorded here).

## Decision: re-homing

Re-homing is the normalized storage form; origin-reference is rejected. The deciding criterion is
**one fact, one home (§18.10)**: origin-reference structurally SPLITS a fact's version history between
host and object (the doc's own named flaw — "muddies whose `object_versions` hold the content") and
requires a forbidden second "by-reference" content mode on `UnitContent`. Re-homing reuses primitives
the model already has (`EmbedTarget::Object`, embed-as-appearance, the per-day `journal_day` FFI bound)
and adds no content variant. The existing core already _implied_ re-homing.

### The §9.y matrix scorecard (the §18.5 evidence)

Every row's **re-homing** column is proven by a test in
`packages/server/tests/integration/ownership.test.ts` (real HTTP → core → Postgres). The
**origin-reference** column is the analyzed alternative (harness-only; never persisted).

| §9.y criterion                      | Re-homing (implemented, tested)                                                               | Origin-reference (analyzed)                                    | Verdict                |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------- |
| unit + expression id preservation   | preserved (the move never re-mints)                                                           | preserved (nothing moves)                                      | tie                    |
| host renders the material in place  | one `Embed{Object}` at the root's slot                                                        | the host still holds it                                        | tie                    |
| **object owns its version history** | **the object owns its `content_units` + `object_versions`**                                   | **split: the host holds content+history; the object is empty** | **re-homing (§18.10)** |
| cross-object revision independence  | editing the object bumps only its revision                                                    | edits land on the host → coupled                               | re-homing              |
| undo-the-materialization            | `rehome ∘ dissolve` restores the host exactly                                                 | restore by dropping the pointer                                | tie (both reversible)  |
| dissolution with references         | reviewable refusal (422) on external inbound links                                            | same gate possible                                             | tie                    |
| tag propagation                     | the unit's tag rides its preserved id, free                                                   | free (nothing moves)                                           | tie                    |
| backlinks                           | inbound edges resolve under the new owner                                                     | resolve via host indirection                                   | tie                    |
| one home (no unit in two objects)   | enforced (`validate_graph` + the move)                                                        | a by-reference mode blurs it                                   | re-homing              |
| export (echo round-trip)            | the object exports first-class; the host's pack carries it transitively, and re-imports clean | the object has no content of its own to export cleanly         | re-homing              |

The export row is an **echo round-trip** — import is validate+migrate+echo (the 1d decision); persist-on-import-and-reload is slice 2e, so the table claims only what the test exercises. Every other re-homing column is backed by a test in `ownership.test.ts`. The mechanisms are externally identical for reads/edits/undo/backlinks; they DIVERGE precisely on
_who owns the content and its history_ — which is the whole product question, and where re-homing
satisfies one-fact-one-home and origin-reference cannot. **Re-homing passes the gate; greedy capture
stands.**

## The cross-object atomic persist (Pass B)

`db/migrations/0002` declares the FKs IMMEDIATE with no `ON DELETE`. A cross-object unit move is then
impossible by statement ordering: flipping a unit's `object_id` transiently dangles every composite-FK
edge `(unit_id, object_id)` that points at it, and a delete-all of a layer dangles any
`taggings.tagged_unit_id` (simple FK on the id, no cascade). So **`0003` makes the four
`content_units`-referencing FKs (`links` source+target, `handles`, `taggings`) `DEFERRABLE INITIALLY
IMMEDIATE`** — default behavior unchanged everywhere; only re-home/dissolve `SET CONSTRAINTS ALL
DEFERRED`, so the move is validated for consistency at COMMIT. This is a DB-structure migration only
(no `CURRENT_SCHEMA_VERSION` bump, no data change) and the right Postgres tool for atomic multi-row
graph restructuring (also the foundation for §6.5 re-dating / merge later).

- **Re-home** (`persistRehome`): gate the HOST on `host_content.revision` (→ 409, no orphan), insert
  the new object, delete-all+reinsert both layers (host minus the subtree plus the embed; the object's
  moved units, ids preserved), re-point composite-FK edges (links source+target, handles unit- AND
  expression-anchored) to the new object. Taggings ride preserved ids — never re-pointed.
- **Dissolve** (`persistDissolve`): DUAL gate (host + the destroyed object) before any destructive
  write, fold the units back under the host, re-point edges back, then destroy the object child-FK
  first (`object_versions`/`aliases`/`definition_detail`/object-level `taggings`, then `objects`).
- The **reviewable-refusal gate** is glue-loaded (`SELECT id FROM links WHERE target_object_id = $d
AND source_object_id <> $d`) and passed to the core as bare ids; the core counts nothing.
- `loadObjectSubgraph` follows `Embed{Object}` transitively (visited-set guarded) so a host's
  `.mathpack` includes its embedded objects.

## Deferred (structurally additive)

- **Expression-anchored handle re-point** is handled (the `target_expression_id` clause), but deeper
  transitive embedded-object export beyond what the matrix needs is written generally yet only
  one-level-tested (Pass C exercises depth).
- The **reviewable-dissolution UI** (deprecate / keep / detach) is 2c; the core returns the refusal
  with the referencing ids today.
- The latent "delete-all dangles a tagged unit" in the _other_ single-object ops' persist is
  unreachable (no endpoint authors taggings yet) and now cheaply fixable via the same `SET CONSTRAINTS
DEFERRED` when tagging-authoring lands.

## Consequences

Cross-object version histories are tracked correctly (one fact, one home); the core stays pure (the
reference query lives in glue); the matrix proves re-homing passes the §18.5 gate end-to-end; and the
deferred-constraint move is the reusable foundation for every future cross-object content move.
`CURRENT_SCHEMA_VERSION` stays 1; no generated/artifact drift.
