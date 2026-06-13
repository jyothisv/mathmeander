// Plain SQL query layer (arch doc §4/§7 — no ORM). The glue persists EXACTLY what the
// core returned; rows read back are reassembled and routed through the core's
// parse-and-migrate read path by the caller (routes), so this module stays dumb.
import type pg from 'pg';
import type { CanonicalObject, Provenance } from '@mathmeander/schema';

type Queryable = pg.Pool | pg.PoolClient;

/** Insert the (object, provenance) pair the core constructed — ONE transaction. */
export async function insertObjectWithProvenance(
  client: pg.PoolClient,
  object: CanonicalObject,
  provenance: Provenance,
): Promise<void> {
  await client.query(
    `INSERT INTO provenance (id, origin, created_by, occurred_at)
     VALUES ($1, $2, $3, $4)`,
    [provenance.id, provenance.origin, provenance.created_by ?? null, provenance.occurred_at],
  );
  await client.query(
    `INSERT INTO objects (id, type, title, raw_source, status, schema_version, revision,
                          provenance_id, space_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      object.id,
      object.type,
      object.title ?? null,
      object.raw_source ?? null,
      object.status,
      object.schema_version,
      object.revision,
      object.provenance_id,
      object.space_id,
      object.created_at,
      object.updated_at,
    ],
  );
}

/** Row → the stored-object JSON shape the core's read path expects. */
export interface ObjectRow {
  id: string;
  type: string;
  title: string | null;
  raw_source: string | null;
  status: string;
  schema_version: number;
  revision: number;
  provenance_id: string;
  space_id: string;
  created_at: Date;
  updated_at: Date;
}

export function rowToStoredJson(row: ObjectRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    // tri-state: SQL NULL means unset — the column is omitted, not nulled (§6.3)
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.raw_source === null ? {} : { raw_source: row.raw_source }),
    status: row.status,
    schema_version: row.schema_version,
    revision: row.revision,
    provenance_id: row.provenance_id,
    space_id: row.space_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function findObjectInSpace(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<ObjectRow | null> {
  const result = await db.query<ObjectRow>(
    `SELECT id, type, title, raw_source, status, schema_version, revision,
            provenance_id, space_id, created_at, updated_at
     FROM objects WHERE id = $1 AND space_id = $2`,
    [objectId, spaceId],
  );
  return result.rows[0] ?? null;
}

export async function listObjectsInSpace(
  db: Queryable,
  spaceId: string,
  limit: number,
): Promise<ObjectRow[]> {
  const result = await db.query<ObjectRow>(
    `SELECT id, type, title, raw_source, status, schema_version, revision,
            provenance_id, space_id, created_at, updated_at
     FROM objects WHERE space_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [spaceId, limit],
  );
  return result.rows;
}

/**
 * The §6.4 conditional write: succeeds only if the revision is still what the client
 * read (DB-level check — never read-check-write). Returns false on conflict.
 */
export async function updateObjectIfRevision(
  db: Queryable,
  updated: CanonicalObject,
  expectedRevision: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE objects
     SET title = $1, revision = $2, updated_at = $3
     WHERE id = $4 AND space_id = $5 AND revision = $6`,
    [
      updated.title ?? null,
      updated.revision,
      updated.updated_at,
      updated.id,
      updated.space_id,
      expectedRevision,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function currentRevision(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<number | null> {
  const result = await db.query<{ revision: number }>(
    `SELECT revision FROM objects WHERE id = $1 AND space_id = $2`,
    [objectId, spaceId],
  );
  return result.rows[0]?.revision ?? null;
}
