-- migrate:up

-- §6.2 — BRACE/EMBRACE ANNOTATIONS. An annotation BINDS to precise structural parts of content (a math
-- sub-term via a `StructuralPath`, an equation-row set, or a prose phrase) and is drawn as an in-flow brace
-- with a label. An annotation IS an object (`ObjectType::Annotation`, now producible via its own
-- `reconcile_annotations` op — never the plain create path): an `objects` row + an `annotation_detail` (HOW
-- it is drawn) + one or more `annotation_targets` (WHAT it binds). Orphaning reuses the edge lifecycle
-- (`status = 'stale'`), never a silent drop. A SEPARATE aggregate from `content_units` — the math model /
-- `save_content` are untouched; the editor re-derives these rows on persist (the 4th autosave axis).
--
-- Purely additive: two new types whose row count was zero, so CURRENT_SCHEMA_VERSION stays 1 (no stored
-- payload migration). The artifact HASH moves for the new core types (`AnnotationDetail`/`AnnotationTarget`/
-- `AnnotationPrimitive`/…) via `just codegen`, a distinct concept.
--
-- No PG enums (`role`/`status` are text validated by the core, §6.1a); no DB-minted ids (ids are
-- client/glue-minted UUIDv7); `provenance_id` NOT NULL (the trust spine); the two jsonb columns are
-- registered in docs/jsonb-registry.md.

CREATE TABLE annotation_detail (
    -- The annotation object's own id; the object's provenance is the trust spine, so NO provenance_id column
    -- (mirrors notebook_detail/journal_day_detail). §6.1a type-qualified (object_id is an `annotation`) is
    -- core-enforced. ON DELETE CASCADE: deleting the annotation object removes its detail (annotation objects
    -- are never delete-then-reinserted like content_units, so a cascade is safe here).
    object_id  uuid PRIMARY KEY REFERENCES objects (id) ON DELETE CASCADE,
    primitives jsonb NOT NULL                                  -- AnnotationPrimitive[] (jsonb-registry)
);

CREATE TABLE annotation_targets (
    id               uuid PRIMARY KEY,                          -- client/glue-minted, no DEFAULT
    annotation_id    uuid NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    role             text NOT NULL,                            -- AnnotationRole ('target' | 'member')
    "position"       integer NOT NULL,                         -- order among same-role targets
    target_unit_id   uuid NOT NULL,                            -- the bound unit in the HOST object
    target_object_id uuid NOT NULL,
    extent           jsonb NOT NULL,                           -- AnnotationExtent (jsonb-registry)
    status           text NOT NULL,                            -- LinkStatus ('active' | 'stale' | 'deprecated')
    provenance_id    uuid NOT NULL REFERENCES provenance (id),
    -- The composite FK into the HOST content MUST be DEFERRABLE (the 0003/0008 lesson): a host `save_content`
    -- delete-then-reinserts touched units under `SET CONSTRAINTS ALL DEFERRED`, so a target bound to a
    -- reordered unit would transiently dangle and 422. NO ACTION (default) — a real unit deletion is handled
    -- by the editor removing the annotation first, not a silent cascade that would nuke a brace on any reorder.
    FOREIGN KEY (target_unit_id, target_object_id) REFERENCES content_units (id, object_id)
        DEFERRABLE INITIALLY IMMEDIATE
);

-- Load an object's annotations host-first (all targets bound into it), and group an annotation's targets.
CREATE INDEX annotation_targets_target_object_id_idx ON annotation_targets (target_object_id);
CREATE INDEX annotation_targets_annotation_id_idx ON annotation_targets (annotation_id);

-- migrate:down

DROP TABLE annotation_targets;
DROP TABLE annotation_detail;
