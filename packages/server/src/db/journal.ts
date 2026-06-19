// Plain SQL for the journal surface (§6.5): a `journal_day` owns one day's content; the *journal* is
// the date-ordered view over journal_day objects. No ORM. Get-or-create is RACE-SAFE via the
// `journal_day_detail` UNIQUE(space_id, date) + `ON CONFLICT DO NOTHING`: a lost race throws to roll
// the whole tx back (no orphan object/provenance) and re-selects the winner. The date is identity —
// immutable in slice 2b (re-dating is a future §6.5 content-move op, never a column edit).
import type pg from 'pg';
import type { CanonicalObject, JournalDayDetail, Provenance } from '@mathmeander/schema';
import { withTransaction } from './pool.js';
import { insertObjectWithProvenance, type ObjectRow } from './objects.js';

type Queryable = pg.Pool | pg.PoolClient;

/**
 * Thrown INSIDE the get-or-create transaction to force `withTransaction` to ROLL BACK the orphan
 * object+provenance when we lose the (space_id, date) race (mirrors `persistObjectGraph`'s
 * RevisionConflict/DissolutionRaced sentinels). Caught immediately outside; never escapes the module.
 */
class JournalDayRaced extends Error {}

const OBJECT_COLUMNS = `o.id, o.type, o.title, o.raw_source, o.status, o.schema_version,
  o.revision, o.provenance_id, o.space_id, o.created_at, o.updated_at`;

/** A journal day = its (migratable) object row + the date it carries. */
export interface JournalDay {
  row: ObjectRow;
  date: string; // ISO YYYY-MM-DD
}

export async function findJournalDayByDate(
  db: Queryable,
  spaceId: string,
  date: string,
): Promise<{ object_id: string; date: string } | null> {
  const r = await db.query<{ object_id: string; date: string }>(
    `SELECT object_id, to_char(date, 'YYYY-MM-DD') AS date
     FROM journal_day_detail WHERE space_id = $1 AND date = $2`,
    [spaceId, date],
  );
  return r.rows[0] ?? null;
}

/**
 * Idempotent get-or-create. Mints the (object, provenance, detail) in ONE transaction; the
 * `UNIQUE(space_id, date)` makes one-day-per-space a creation-time guard. On a lost race the whole
 * tx rolls back (the object PK never collides, and `journal_day_detail` is the only row keyed on
 * (space_id, date), so nothing leaks) and we return the winner. READ COMMITTED only: the loser's
 * `DO NOTHING` unblocks AFTER the winner commits, so the re-SELECT always finds it.
 */
export async function getOrCreateJournalDay(
  db: pg.Pool,
  object: CanonicalObject,
  provenance: Provenance,
  detail: JournalDayDetail,
  spaceId: string,
): Promise<{ created: boolean; objectId: string; date: string }> {
  try {
    return await withTransaction(db, async (client) => {
      await insertObjectWithProvenance(client, object, provenance);
      const won = await client.query<{ object_id: string; date: string }>(
        `INSERT INTO journal_day_detail (object_id, space_id, date)
         VALUES ($1, $2, $3)
         ON CONFLICT (space_id, date) DO NOTHING
         RETURNING object_id, to_char(date, 'YYYY-MM-DD') AS date`,
        [detail.object_id, spaceId, detail.date],
      );
      const row = won.rows[0];
      if (!row) throw new JournalDayRaced(); // lost → roll back the orphan object+provenance
      return { created: true, objectId: row.object_id, date: row.date };
    });
  } catch (err) {
    if (err instanceof JournalDayRaced) {
      const existing = await findJournalDayByDate(db, spaceId, detail.date);
      if (!existing) throw err; // unreachable in 2b (date immutable, no delete) — honesty guard
      return { created: false, objectId: existing.object_id, date: existing.date };
    }
    throw err;
  }
}

/** The journal view: every journal_day in the space, newest day first. ONE query (object columns
 *  folded into the JOIN), zero N+1; hits the `journal_day_detail_by_space_date` index. */
export async function listJournalDays(db: Queryable, spaceId: string): Promise<JournalDay[]> {
  const r = await db.query<ObjectRow & { date: string }>(
    `SELECT ${OBJECT_COLUMNS}, to_char(d.date, 'YYYY-MM-DD') AS date
     FROM journal_day_detail d
     JOIN objects o ON o.id = d.object_id
     WHERE d.space_id = $1
     ORDER BY d.date DESC`,
    [spaceId],
  );
  return r.rows.map(({ date, ...row }) => ({ row, date }));
}
