-- migrate:up

-- Slice 2b — the `journal_day` writing-surface (arch doc §6.5 surfaces). A `journal_day` is a
-- content-bearing object that owns ONE calendar day's flow (`content_units`); the *journal* is the
-- view over these objects ORDER BY date, and an object's appearance on a day is an
-- `Embed{target: Object}` unit. This detail table mirrors `definition_detail` (0002): non-content
-- metadata keyed by the object's own id, NO provenance_id column (the object's provenance is the
-- spine), no PG enum, no jsonb, no DB-minted id. The §6.1a type-qualified invariant (object_id must
-- be a `journal_day`) is core-enforced — SQL can't cheaply express it.
--
-- `space_id` is denormalized (it always equals objects.space_id) PURELY so one-day-per-space is a
-- SQL-enforceable UNIQUE — the race-safe get-or-create key (glue: INSERT … ON CONFLICT DO NOTHING).
-- The `date` is object identity, never patched in place: re-dating is a deliberate §6.5 content-move
-- op, not a column edit. The FK to content_units is absent (a journal_day is a HOST, never a re-homed
-- unit), so this table needs none of 0003's DEFERRABLE treatment.
--
-- Purely additive: a new type whose row count was zero (journal_day was non-producible before now),
-- so CURRENT_SCHEMA_VERSION stays 1 (no stored-payload migration). The artifact HASH moves for the
-- new core types (JournalDayDetail / CreatedJournalDay) via `just codegen`, a distinct concept.

CREATE TABLE journal_day_detail (
    object_id uuid PRIMARY KEY REFERENCES objects (id),
    space_id  uuid NOT NULL REFERENCES spaces (id),
    date      date NOT NULL,
    UNIQUE (space_id, date)
);

CREATE INDEX journal_day_detail_by_space_date ON journal_day_detail (space_id, date DESC);

-- migrate:down

DROP TABLE journal_day_detail;
