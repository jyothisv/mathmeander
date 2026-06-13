// THE single-active-session policy hook (arch doc §7/§12) — single-session is a POLICY
// in this tier, deliberately absent from the data model. Multi-device later = changing
// THIS module, no migration. Keep every "how many sessions may live" decision here.
import type pg from 'pg';
import { revokeOtherSessions } from '../db/sessions.js';

/** Called after a new session is created: enforce one active session per user. */
export async function onSessionCreate(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  newSessionId: string,
  now: Date,
): Promise<{ revoked: number }> {
  const revoked = await revokeOtherSessions(db, userId, newSessionId, now);
  return { revoked };
}
