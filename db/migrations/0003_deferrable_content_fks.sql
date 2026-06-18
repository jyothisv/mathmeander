-- migrate:up

-- Slice 2a Pass B — make the four FKs that REFERENCE content_units DEFERRABLE so a single
-- transaction can MOVE a unit between objects (re-homing / dissolution, §9.y) and only be checked
-- for consistency at COMMIT. 0002 created these IMMEDIATE (the default), which makes a cross-object
-- move impossible by statement ordering: flipping a unit's object_id transiently dangles every
-- composite-FK edge that points at it, and a delete-all of a layer dangles any tagging on a deleted
-- row (taggings FK is on tagged_unit_id alone, no cascade). Postgres has no in-place ALTER to
-- deferrable, so each is DROP + re-ADD.
--
-- INITIALLY IMMEDIATE keeps behavior identical for EVERY existing op (still checked per-statement);
-- only re-home/dissolve opt in via `SET CONSTRAINTS ALL DEFERRED` inside their transaction. This is
-- a DB-structure change only — no data, no column, no CURRENT_SCHEMA_VERSION bump. The other FKs
-- (object/provenance targets, the content_units self-parent, the position UNIQUE) stay immediate:
-- they are never crossed by a cross-object move (parents move with their subtree; layers are
-- delete-all-then-reinsert, so positions never transiently collide).

ALTER TABLE links DROP CONSTRAINT links_source_unit_id_source_object_id_fkey;
ALTER TABLE links ADD CONSTRAINT links_source_unit_id_source_object_id_fkey
    FOREIGN KEY (source_unit_id, source_object_id) REFERENCES content_units (id, object_id)
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE links DROP CONSTRAINT links_target_unit_id_target_object_id_fkey;
ALTER TABLE links ADD CONSTRAINT links_target_unit_id_target_object_id_fkey
    FOREIGN KEY (target_unit_id, target_object_id) REFERENCES content_units (id, object_id)
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE handles DROP CONSTRAINT handles_target_unit_id_target_object_id_fkey;
ALTER TABLE handles ADD CONSTRAINT handles_target_unit_id_target_object_id_fkey
    FOREIGN KEY (target_unit_id, target_object_id) REFERENCES content_units (id, object_id)
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE taggings DROP CONSTRAINT taggings_tagged_unit_id_fkey;
ALTER TABLE taggings ADD CONSTRAINT taggings_tagged_unit_id_fkey
    FOREIGN KEY (tagged_unit_id) REFERENCES content_units (id)
    DEFERRABLE INITIALLY IMMEDIATE;

-- migrate:down

ALTER TABLE taggings DROP CONSTRAINT taggings_tagged_unit_id_fkey;
ALTER TABLE taggings ADD CONSTRAINT taggings_tagged_unit_id_fkey
    FOREIGN KEY (tagged_unit_id) REFERENCES content_units (id);

ALTER TABLE handles DROP CONSTRAINT handles_target_unit_id_target_object_id_fkey;
ALTER TABLE handles ADD CONSTRAINT handles_target_unit_id_target_object_id_fkey
    FOREIGN KEY (target_unit_id, target_object_id) REFERENCES content_units (id, object_id);

ALTER TABLE links DROP CONSTRAINT links_target_unit_id_target_object_id_fkey;
ALTER TABLE links ADD CONSTRAINT links_target_unit_id_target_object_id_fkey
    FOREIGN KEY (target_unit_id, target_object_id) REFERENCES content_units (id, object_id);

ALTER TABLE links DROP CONSTRAINT links_source_unit_id_source_object_id_fkey;
ALTER TABLE links ADD CONSTRAINT links_source_unit_id_source_object_id_fkey
    FOREIGN KEY (source_unit_id, source_object_id) REFERENCES content_units (id, object_id);
