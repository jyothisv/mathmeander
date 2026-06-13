// Session storage: opaque 256-bit tokens, only their sha256 hash persisted. The schema
// permits multiple active sessions; single-active-session lives in auth/policy.ts.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface SessionRow {
  id: string;
  user_id: string;
}

export function mintSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function insertSession(
  db: Queryable,
  session: { id: string; userId: string; tokenHash: string; expiresAt: Date },
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [session.id, session.userId, session.tokenHash, now, session.expiresAt],
  );
}

/** Resolve an ACTIVE session (not revoked, not expired) by token hash. */
export async function findActiveSession(
  db: Queryable,
  tokenHash: string,
  now: Date,
): Promise<SessionRow | null> {
  const result = await db.query<SessionRow>(
    `SELECT id, user_id FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash, now],
  );
  return result.rows[0] ?? null;
}

export async function revokeSession(db: Queryable, sessionId: string, now: Date): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [
    now,
    sessionId,
  ]);
}

export async function revokeOtherSessions(
  db: Queryable,
  userId: string,
  keepSessionId: string,
  now: Date,
): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = $1
     WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL`,
    [now, userId, keepSessionId],
  );
  return result.rowCount ?? 0;
}
