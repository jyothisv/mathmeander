-- migrate:up

-- Slice 2-A — the math-row model (arch doc / `docs/structured-math.md` §F2). A `Unit` gains an
-- optional `row_relation`: the typed relation a row asserts toward its prior sibling (a `Derivation`
-- step's connective, or an `Equations` row's leading relation). Like `slot`/`example_kind` it is a
-- per-unit COLUMN (the `Unit` struct's fields map to columns; only `content` is jsonb), text-backed —
-- the vocabulary lives in the core `RowRelation` enum (kept ⊆ the surface grammar's relations by a
-- mechanical test), NEVER a PG enum (§6 enum-vs-text). No jsonb registry, no DB-minted id, provenance
-- untouched. The FK story is unchanged (a plain scalar column, no 0003 DEFERRABLE treatment).
--
-- Purely additive: a new NULLABLE column with no default and no backfill — every existing row reads
-- NULL → `None`. So CURRENT_SCHEMA_VERSION stays 1 (no stored-payload migration). The artifact HASH
-- moves for the new core types (RowRelation / Equations / Insert{Equations,Row}Input) via
-- `just codegen`, a distinct concept.

ALTER TABLE content_units ADD COLUMN row_relation text;

-- migrate:down

ALTER TABLE content_units DROP COLUMN row_relation;
