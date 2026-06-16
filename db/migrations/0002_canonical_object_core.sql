-- migrate:up

-- Slice 1 — the canonical object core (arch doc §6.0–§6.3b). Nine net-new tables that
-- turn the walking skeleton's bare `objects` into the real model: flowing content units,
-- the edge graph, aliases/handles/tags, the derivation chain, definition detail, and
-- version checkpoints. Conventions inherited from 0001 and enforced by the guards:
--   • every vocabulary column is TEXT validated by the Rust core ONLY — no PG enums,
--     no CHECKs on evolving kinds (one vocabulary home, §6 enum-vs-text);
--   • no DB-minted ids — all UUIDv7 are client/core/glue-minted (§4/§6.3);
--   • provenance_id is NOT NULL on every provenanced entity (the §6 trust spine);
--   • polymorphic targets are FK-checkable columns (never target_kind + bare uuid), with
--     the exactly-one-target discipline as CHECKs; the core owns the rest (§6.1a);
--   • derived facts (content_kind, in_expression) are GENERATED columns — one fact, one
--     home — never independently written (§6.0b);
--   • every jsonb column is a registered, core-owned tagged union or snapshot
--     (docs/jsonb-registry.md, §6.1d).
-- Tables are created in FK order; the down migration drops them in reverse.

-- The provenance derivation chain (§6.1) — a typed, FK-checked join, not a uuid[].
CREATE TABLE provenance_derivations (
    provenance_id              uuid NOT NULL REFERENCES provenance (id),
    derived_from_provenance_id uuid NOT NULL REFERENCES provenance (id),
    PRIMARY KEY (provenance_id, derived_from_provenance_id),
    -- cheap guard against a self-derivation loop (a row deriving from itself)
    CONSTRAINT provenance_derivations_no_self
        CHECK (provenance_id <> derived_from_provenance_id)
);

-- Non-content metadata for definition objects (§6.1c): the definiendum is object identity.
-- The §6.1a type-qualified-reference invariant (object_id must be a `definition`) is core-
-- enforced — SQL can't cheaply express it.
CREATE TABLE definition_detail (
    object_id uuid PRIMARY KEY REFERENCES objects (id),
    term      text NOT NULL
);

-- CONTENT as flowing units (§6.0b). Identity/order/type/kind/status/declared_by/nesting
-- are explicit; the authored material is the core-owned `content` union. Nesting is by
-- ROWS (parent_unit_id), never an embedded tree.
CREATE TABLE content_units (
    id             uuid PRIMARY KEY,
    object_id      uuid NOT NULL REFERENCES objects (id),
    parent_unit_id uuid,                  -- THE nesting mechanism (composite FK below)
    position       int NOT NULL,          -- order among siblings
    slot           text,                  -- 'assumption' | 'justification' | NULL (core-validated)
    type           text,                  -- the one user-facing math-flow label; NULL = plain
    example_kind   text,                  -- for type=example; core-validated
    status         text NOT NULL,         -- per-unit crystallization (UnitStatus)
    declared_by    text NOT NULL,         -- user | deterministic | imported (never ai, §6.0)
    extracted_structure jsonb,            -- ExtractedStructureEnvelope — declared, unwritten (§6.0)
    content        jsonb NOT NULL,        -- UnitContent (one specified core format, §6.0)
    content_kind   text GENERATED ALWAYS AS (content ->> 'kind') STORED,
                                          -- DERIVED projection of the content tag (one fact, one home)
    provenance_id  uuid NOT NULL REFERENCES provenance (id),
    UNIQUE (id, object_id),               -- enables the composite FKs that follow
    FOREIGN KEY (parent_unit_id, object_id)
        REFERENCES content_units (id, object_id),  -- a parent belongs to the SAME object
    UNIQUE NULLS NOT DISTINCT (object_id, parent_unit_id, position)
                                          -- total sibling order; NULLS NOT DISTINCT so root
                                          --   siblings (parent_unit_id NULL) still collide.
                                          --   Its backing btree also serves sibling-ordered
                                          --   reads, so no separate index is needed.
);

-- The EDGE table (§6.1b): typed relationships AND content-derived references/occurrences.
-- Slice 1 ships the TWO target arms whose FK targets exist — object and unresolved_text;
-- notation/source arms widen in slices 2/3. target_unit_id / target_selector are
-- REFINEMENTS of the object target, never alternatives.
CREATE TABLE links (
    id               uuid PRIMARY KEY,
    source_object_id uuid NOT NULL REFERENCES objects (id),  -- the edge's source end
    target_object_id uuid REFERENCES objects (id),           -- target arm 1
    target_unit_id   uuid,                                   -- refinement of target_object_id
    unresolved_text  text,                                   -- target arm 2 (the resolution queue)
    target_selector  jsonb,                                  -- TargetSelector union (§6.1d)
    type             text NOT NULL,                          -- LinkType (core-validated)
    status           text NOT NULL DEFAULT 'active',         -- LinkStatus
    from_content     boolean NOT NULL,                       -- true = Reference/Occurrence-derived
    source_unit_id   uuid,                                   -- which unit it sits in
    content_locator  jsonb,                                  -- ContentLocator union (§6.1d)
    in_expression    boolean GENERATED ALWAYS AS
                        (content_locator ->> 'kind' = 'expression_span') STORED,
                                                             -- DERIVED from the locator kind
    provenance_id    uuid NOT NULL REFERENCES provenance (id),
    created_at       timestamptz NOT NULL,
    FOREIGN KEY (target_unit_id, target_object_id)
        REFERENCES content_units (id, object_id),
    FOREIGN KEY (source_unit_id, source_object_id)
        REFERENCES content_units (id, object_id),
    -- Slice-1 exactly-one-target: object arm XOR unresolved arm (§6.1a/§6.1b).
    CONSTRAINT links_exactly_one_target CHECK (
        (target_object_id IS NOT NULL)::int + (unresolved_text IS NOT NULL)::int = 1
    ),
    -- No off-graph deliberate edges: a non-content edge must carry an object target.
    CONSTRAINT links_deliberate_needs_object CHECK (
        from_content OR target_object_id IS NOT NULL
    ),
    -- Refinements require the object target.
    CONSTRAINT links_unit_needs_object CHECK (
        target_unit_id IS NULL OR target_object_id IS NOT NULL
    )
);

CREATE INDEX links_backlinks ON links (target_object_id) WHERE target_object_id IS NOT NULL;
CREATE INDEX links_by_source ON links (source_object_id);

-- An alias names an EXISTING object (§6.3b). scope ↔ scope_ref consistency is core-enforced.
CREATE TABLE aliases (
    id        uuid PRIMARY KEY,
    object_id uuid NOT NULL REFERENCES objects (id),
    name      text NOT NULL,
    kind      text NOT NULL,            -- AliasKind (text + core enum, dec. E — never a PG enum)
    scope     text NOT NULL,            -- AliasScope (text + core enum)
    scope_ref uuid                      -- the scoping entity (polymorphic; core-validated)
);

CREATE INDEX aliases_by_object ON aliases (object_id);

-- A user handle (§6.3b): an optional human name for an intra-object element. Bound to the
-- owning object, refined by exactly one of {unit, expression}. (Objects use aliases.)
CREATE TABLE handles (
    id                   uuid PRIMARY KEY,
    space_id             uuid NOT NULL REFERENCES spaces (id),
    name                 text NOT NULL,
    target_object_id     uuid NOT NULL REFERENCES objects (id),
    target_unit_id       uuid,           -- composite FK below
    target_expression_id uuid,           -- a MathExpression id (resolved via the expr→unit index)
    status               text NOT NULL DEFAULT 'active',  -- HandleStatus
    scope                text NOT NULL,                   -- HandleScope (object | space)
    provenance_id        uuid NOT NULL REFERENCES provenance (id),
    FOREIGN KEY (target_unit_id, target_object_id)
        REFERENCES content_units (id, object_id),
    CONSTRAINT handles_exactly_one_refinement CHECK (
        (target_unit_id IS NOT NULL)::int + (target_expression_id IS NOT NULL)::int = 1
    )
);

-- User tags (§6.0b): free-form personal organization, a facet apart from type and edges.
CREATE TABLE tags (
    id       uuid PRIMARY KEY,
    space_id uuid NOT NULL REFERENCES spaces (id),
    name     text NOT NULL,
    UNIQUE (space_id, name)
);

-- A tag applied to exactly one target (object XOR unit), §6.0b.
CREATE TABLE taggings (
    id               uuid PRIMARY KEY,
    tag_id           uuid NOT NULL REFERENCES tags (id),
    tagged_object_id uuid REFERENCES objects (id),
    tagged_unit_id   uuid REFERENCES content_units (id),
    created_at       timestamptz NOT NULL,
    CONSTRAINT taggings_exactly_one_target CHECK (
        (tagged_object_id IS NOT NULL)::int + (tagged_unit_id IS NOT NULL)::int = 1
    )
);

-- Duplicate-tagging prevented via partial unique indexes per target column.
CREATE UNIQUE INDEX taggings_unique_object
    ON taggings (tag_id, tagged_object_id) WHERE tagged_object_id IS NOT NULL;
CREATE UNIQUE INDEX taggings_unique_unit
    ON taggings (tag_id, tagged_unit_id) WHERE tagged_unit_id IS NOT NULL;

-- Lightweight, append-only history (§6.4). snapshot = a serialized canonical object
-- (the §6.1d snapshot/log JSONB exception), carried opaquely by the core.
CREATE TABLE object_versions (
    id            uuid PRIMARY KEY,
    object_id     uuid NOT NULL REFERENCES objects (id),
    version_no    int NOT NULL,
    snapshot      jsonb NOT NULL,
    provenance_id uuid NOT NULL REFERENCES provenance (id),
    created_at    timestamptz NOT NULL,
    UNIQUE (object_id, version_no)
);

-- migrate:down

DROP TABLE object_versions;
DROP TABLE taggings;
DROP TABLE tags;
DROP TABLE handles;
DROP TABLE aliases;
DROP TABLE links;
DROP TABLE content_units;
DROP TABLE definition_detail;
DROP TABLE provenance_derivations;
