# JSONB registry

Every `jsonb` column in the database must be registered here, mapped to the **named,
versioned tagged union in the core's schema artifact** that defines its shape (arch doc
§6.1d: locators and selectors are never open blobs; §6 principle 2: JSONB is the rare,
justified exception — documented variants and snapshots/logs only).

`scripts/lint-migrations.mjs` (run by `just lint` and CI) rejects any migration adding a
`jsonb` column whose name is not listed here. Registering a column means: the core type
exists, it is in the artifact, and generated zod validates it.

| Column                                                   | Core type (artifact `$defs` name) | Kind | Since |
| -------------------------------------------------------- | --------------------------------- | ---- | ----- |
| _none yet — the walking skeleton has zero JSONB columns_ |                                   |      |       |

Expected future entries (slice 1+, per arch doc §6): `content_units.content` →
`UnitContent`; `content_units.extracted_structure` → extracted-structure envelope;
`links.content_locator` → `ContentLocator`; `links.target_selector` → `TargetSelector`;
`annotation_targets.anchor` → `AnchorPayload`; `provenance.source_locator` →
`SourceLocator`; `trail_steps.detail` → per-kind detail unions; snapshot/log columns
(`object_versions.snapshot`, `ai_context_snapshots.*`, `search_documents` projections).
