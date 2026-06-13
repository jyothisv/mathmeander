-- migrate:up

-- Foundations: exactly the five tables the walking skeleton needs, in the arch doc's
-- §6 shapes. Vocabulary columns (type/status/origin) are TEXT validated ONLY by the
-- Rust core — no PG enums, no CHECKs — so slice 1 adds theorem/lemma/… with zero
-- migration churn (one vocabulary home; arch doc §6 enum-vs-text).
-- Ids have NO database defaults: they are client/core/glue-minted UUIDv7
-- (arch doc §4/§6.3 — the offline/multi-device reservation, exercised not documented).

-- IdP-scoped identity: the issuer swap (dev-idp → Clerk/WorkOS) is a DATA change.
CREATE TABLE users (
    id          uuid PRIMARY KEY,
    idp_issuer  text NOT NULL,
    idp_subject text NOT NULL,
    email       text,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,
    UNIQUE (idp_issuer, idp_subject)
);

-- Opaque server sessions. The schema deliberately PERMITS multiple active sessions:
-- single-active-session is glue-tier POLICY (arch doc §7/§12, "not an assumption in
-- the data model") — multi-device later is a policy change, not a migration.
CREATE TABLE sessions (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id),
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE INDEX sessions_active_by_user ON sessions (user_id) WHERE revoked_at IS NULL;

-- One space per user is POLICY too (no UNIQUE(owner_user_id)): multi-space is
-- reserved (arch doc §6 "one space/user for MVP; reserved multi-space").
CREATE TABLE spaces (
    id            uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL REFERENCES users (id),
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL
);

-- The typed trust spine (arch doc §6.1): always-valid columns only. The AI/import
-- columns (model, prompt_template, context_snapshot_id, review_item_id, source_id,
-- source_locator) FK into tables that don't exist yet; they land by ADD COLUMN
-- (nullable-by-origin, names fixed by §6) together with their target tables.
CREATE TABLE provenance (
    id          uuid PRIMARY KEY,
    origin      text NOT NULL,
    created_by  text,
    occurred_at timestamptz NOT NULL
);

-- The §6 objects table, verbatim — all eleven columns. Content lives in content_units
-- (slice 1); an object with zero units is valid, which is what makes that addition
-- purely structural. provenance_id is NOT NULL from day one: a skeleton without
-- provenance would be exactly the placeholder-schema churn the plan forbids.
CREATE TABLE objects (
    id             uuid PRIMARY KEY,
    type           text NOT NULL,
    title          text,
    raw_source     text,
    status         text NOT NULL,
    schema_version int NOT NULL,
    revision       int NOT NULL,
    provenance_id  uuid NOT NULL REFERENCES provenance (id),
    space_id       uuid NOT NULL REFERENCES spaces (id),
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL
);

CREATE INDEX objects_by_space_created ON objects (space_id, created_at DESC);

-- migrate:down

DROP TABLE objects;
DROP TABLE provenance;
DROP TABLE spaces;
DROP TABLE sessions;
DROP TABLE users;
