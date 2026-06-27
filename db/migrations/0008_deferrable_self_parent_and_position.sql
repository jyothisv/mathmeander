-- migrate:up

-- Slice 2c fix — make the content_units SELF-PARENT FK and the per-parent POSITION UNIQUE DEFERRABLE
-- so `persistContentDelta` (packages/server/src/db/graph.ts) can partial-DELETE a position-shifted
-- parent and reinsert it within ONE transaction without tripping a non-deferrable check on a transient
-- mid-statement state.
--
-- 0003 made the four OTHER content_units-referencing FKs deferrable but DELIBERATELY left these two
-- IMMEDIATE, on the assumption "parents move with their subtree; layers are delete-all-then-reinsert".
-- That assumption is false for the editor's COARSE save_content delta: reordering top-level units (e.g.
-- moving the notation `config` block to position 0) shifts sibling HEADINGS' positions, so the delta
-- carries the headings (touched → deleted+reinserted) but NOT their body children (positions WITHIN the
-- heading unchanged → not in the delta → not touched). The partial DELETE then removes a heading row
-- while its untouched child still references it via the self-parent FK (23503), and a `position+1`
-- cascade can transiently collide on the position UNIQUE (23505) — both surface as ContentConstraintError
-- → 422 `content_save_invalid` ("couldn't save"). (0007's header independently noted the position UNIQUE
-- non-deferrability, working around it by refusing to place the notation home at position 0.)
--
-- INITIALLY IMMEDIATE keeps behaviour identical for EVERY existing path (still checked per-statement);
-- only persistContentDelta opts in via the `SET CONSTRAINTS ALL DEFERRED` already present in its
-- transaction, so the deferred checks run at COMMIT against the (core-validated) final state. DB-structure
-- change only — no data, no column, no CURRENT_SCHEMA_VERSION bump (that constant versions stored shape,
-- which is unchanged). The position UNIQUE is never an ON CONFLICT arbiter (the only arbiters are
-- (space_id,slug), (space_id,date), (idp_issuer,idp_subject), (id)), so deferral changes no upsert
-- semantics. Postgres has no in-place ALTER to deferrable → DROP + re-ADD (same as 0003).

ALTER TABLE content_units DROP CONSTRAINT content_units_parent_unit_id_object_id_fkey;
ALTER TABLE content_units ADD CONSTRAINT content_units_parent_unit_id_object_id_fkey
    FOREIGN KEY (parent_unit_id, object_id) REFERENCES content_units (id, object_id)
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE content_units DROP CONSTRAINT content_units_object_id_parent_unit_id_position_key;
ALTER TABLE content_units ADD CONSTRAINT content_units_object_id_parent_unit_id_position_key
    UNIQUE NULLS NOT DISTINCT (object_id, parent_unit_id, "position")
    DEFERRABLE INITIALLY IMMEDIATE;

-- migrate:down

ALTER TABLE content_units DROP CONSTRAINT content_units_object_id_parent_unit_id_position_key;
ALTER TABLE content_units ADD CONSTRAINT content_units_object_id_parent_unit_id_position_key
    UNIQUE NULLS NOT DISTINCT (object_id, parent_unit_id, "position");

ALTER TABLE content_units DROP CONSTRAINT content_units_parent_unit_id_object_id_fkey;
ALTER TABLE content_units ADD CONSTRAINT content_units_parent_unit_id_object_id_fkey
    FOREIGN KEY (parent_unit_id, object_id) REFERENCES content_units (id, object_id);
