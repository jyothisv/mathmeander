// users / spaces query layer. These are GLUE-OWNED entities (auth/tenancy is not among
// the core's §5 contents) — their row types live here, which is why hand-writing them
// does not violate the no-duplicate-core-types rule.
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface UserRow {
  id: string;
  idp_issuer: string;
  idp_subject: string;
  email: string | null;
}

export interface SpaceRow {
  id: string;
  owner_user_id: string;
}

/** Upsert by (issuer, subject) — the issuer swap is a data change (arch doc §7). */
export async function upsertUser(
  db: Queryable,
  user: { id: string; idpIssuer: string; idpSubject: string; email: string | null },
  now: Date,
): Promise<UserRow> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (id, idp_issuer, idp_subject, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (idp_issuer, idp_subject)
     DO UPDATE SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at
     RETURNING id, idp_issuer, idp_subject, email`,
    [user.id, user.idpIssuer, user.idpSubject, user.email, now],
  );
  const row = result.rows[0];
  if (!row) throw new Error('upsertUser returned no row');
  return row;
}

export async function findPersonalSpace(
  db: Queryable,
  ownerUserId: string,
): Promise<SpaceRow | null> {
  const result = await db.query<SpaceRow>(
    `SELECT id, owner_user_id FROM spaces WHERE owner_user_id = $1 ORDER BY created_at LIMIT 1`,
    [ownerUserId],
  );
  return result.rows[0] ?? null;
}

/** The user's personal space, created on first login (one-space-per-user is POLICY). */
export async function ensurePersonalSpace(
  db: Queryable,
  ownerUserId: string,
  newSpaceId: string,
  now: Date,
): Promise<SpaceRow> {
  const existing = await db.query<SpaceRow>(
    `SELECT id, owner_user_id FROM spaces WHERE owner_user_id = $1 ORDER BY created_at LIMIT 1`,
    [ownerUserId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await db.query<SpaceRow>(
    `INSERT INTO spaces (id, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     RETURNING id, owner_user_id`,
    [newSpaceId, ownerUserId, now],
  );
  const row = created.rows[0];
  if (!row) throw new Error('ensurePersonalSpace returned no row');
  return row;
}
