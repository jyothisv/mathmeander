-- migrate:up

-- Backfill the notation home (§Design-model: one notation `config` block per notebook) into notebooks that
-- were created BEFORE pre-creation landed (`create_notebook` now mints the home for new notebooks). One empty
-- `config`/notation unit per notebook that lacks one. Idempotent: the `NOT EXISTS` skips notebooks that
-- already have a config home (so re-running, or running after some notebooks already got one, is safe).
--
-- Placement: appended at the END of the notebook's top level (`max(position)+1`, or 0 for an empty notebook —
-- the common case for a fresh test notebook, so it lands at the top there). It is NOT inserted at position 0
-- for non-empty notebooks because the `(object_id, parent_unit_id, position)` UNIQUE is NOT deferrable, so a
-- `position+1` shift of the existing top-level units would transiently collide. The editor renumbers to a
-- gap-free order on the next save regardless.
--
-- Discipline: the id is `uuidv7()` (Postgres 18) for this ONE-TIME data backfill of existing rows — the
-- create path mints ids client-side; this is not a column DEFAULT (the no-DB-minted-id rule targets
-- defaults). The home shares the notebook's provenance (one origin row, already present). `content` is the
-- registered MathContent/UnitContent jsonb; `content_kind` is GENERATED (never written). Purely additive
-- data — no CURRENT_SCHEMA_VERSION bump, no schema change.

INSERT INTO content_units (id, object_id, parent_unit_id, position, status, declared_by, content, provenance_id)
SELECT
  uuidv7(),
  o.id,
  NULL,
  COALESCE(
    (SELECT max(u2.position) + 1 FROM content_units u2 WHERE u2.object_id = o.id AND u2.parent_unit_id IS NULL),
    0
  ),
  'rough',
  'user',
  '{"kind":"config","family":"notation","source":""}'::jsonb,
  o.provenance_id
FROM objects o
WHERE o.type = 'notebook'
  AND NOT EXISTS (
    SELECT 1 FROM content_units u WHERE u.object_id = o.id AND u.content_kind = 'config'
  );

-- migrate:down

-- Remove the notation homes (the `config` arm is new this slice, top-level only).
DELETE FROM content_units WHERE content_kind = 'config' AND parent_unit_id IS NULL;
