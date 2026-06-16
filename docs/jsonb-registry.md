# JSONB registry

Every `jsonb` column in the database must be registered here, mapped to the **named,
versioned tagged union in the core's schema artifact** that defines its shape (arch doc
§6.1d: locators and selectors are never open blobs; §6 principle 2: JSONB is the rare,
justified exception — documented variants and snapshots/logs only).

`scripts/lint-migrations.mjs` (run by `just lint` and CI) rejects any migration adding a
`jsonb` column whose name is not listed here. Registering a column means: the core type
exists, it is in the artifact, and generated zod validates it.

| Column                              | Core type (artifact `$defs` name) | Kind         | Since   |
| ----------------------------------- | --------------------------------- | ------------ | ------- |
| `content_units.content`             | `UnitContent`                     | tagged union | slice 1 |
| `content_units.extracted_structure` | `ExtractedStructureEnvelope`      | envelope     | slice 1 |
| `links.content_locator`             | `ContentLocator`                  | tagged union | slice 1 |
| `links.target_selector`             | `TargetSelector`                  | tagged union | slice 1 |
| `object_versions.snapshot`          | (serialized `CanonicalObject`)    | snapshot/log | slice 1 |

`object_versions.snapshot` is the §6.1d snapshot/log exception (a serialized canonical
object carried opaquely), not a tagged union — registered so the linter knows it is
deliberate.

Expected future entries (later slices, per arch doc §6): `annotation_targets.anchor` →
`AnchorPayload`; `annotation_detail.primitives` → `AnnotationPrimitive[]`;
`provenance.source_locator` → `SourceLocator`; `trail_steps.detail` → per-kind detail
unions; the `review_items.candidate` sub-parts; snapshot/log columns
(`ai_context_snapshots.*`, `search_documents` projections).
