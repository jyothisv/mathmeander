-- migrate:up

-- Slice 2 — the `notebook` writing-surface (arch doc §6.5 surfaces / §B), the non-date sibling of
-- `journal_day`. A notebook is a content-bearing object authored into directly with B `group` sections;
-- its per-space `slug` is identity. This detail table mirrors `journal_day_detail` (0004): non-content
-- metadata keyed by the object's own id, NO provenance_id column (the object's provenance is the spine),
-- no PG enum, no jsonb, no DB-minted id. The §6.1a type-qualified invariant (object_id must be a
-- `notebook`) is core-enforced — SQL can't cheaply express it.
--
-- `space_id` is denormalized (it always equals objects.space_id) PURELY so one-slug-per-space is a
-- SQL-enforceable UNIQUE — the race-safe get-or-create key (glue: INSERT … ON CONFLICT DO NOTHING).
-- The `slug` is identity (derived from the title at create, normalized in the core), not patched in
-- place. No content_units FK (a notebook is a HOST, never a re-homed unit), so no 0003 DEFERRABLE.
--
-- Purely additive: a new type whose row count was zero (notebook was non-producible before now), so
-- CURRENT_SCHEMA_VERSION stays 1 (no stored-payload migration). The artifact HASH moves for the new
-- core types (NotebookDetail / CreatedNotebook / ReparentUnitInput) via `just codegen`, a distinct concept.

CREATE TABLE notebook_detail (
    object_id uuid PRIMARY KEY REFERENCES objects (id),
    space_id  uuid NOT NULL REFERENCES spaces (id),
    slug      text NOT NULL,
    -- The per-space slug is identity AND the listing/lookup key; its UNIQUE index serves both the
    -- get-or-create guard and `listNotebooks`/`findNotebookBySlug` (no separate index needed — unlike
    -- journal_day, whose listing wants date DESC).
    UNIQUE (space_id, slug)
);

-- migrate:down

DROP TABLE notebook_detail;
