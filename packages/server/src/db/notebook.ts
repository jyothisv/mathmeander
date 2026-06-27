// Plain SQL for the notebook surface (§6.5 / §B): a `notebook` is a content-bearing object authored
// into directly with B `group` sections; its per-space `slug` is identity. No ORM. Get-or-create is
// RACE-SAFE via the `notebook_detail` UNIQUE(space_id, slug) + `ON CONFLICT DO NOTHING`: a lost race
// throws to roll the whole tx back (no orphan object/provenance) and re-selects the winner. The slug is
// identity, set at create (re-slugging is a future surface op, never a column edit here). Mirrors
// `db/journal.ts` with `slug` in place of `date`.
import type pg from 'pg';
import type { CanonicalObject, NotebookDetail, Provenance, Unit } from '@mathmeander/schema';
import { withTransaction } from './pool.js';
import { insertObjectWithProvenance, type ObjectRow } from './objects.js';
import { insertContentUnit } from './graph.js';

type Queryable = pg.Pool | pg.PoolClient;

/**
 * Thrown INSIDE the get-or-create transaction to force `withTransaction` to ROLL BACK the orphan
 * object+provenance when we lose the (space_id, slug) race. Caught immediately outside; never escapes.
 */
class NotebookRaced extends Error {}

const OBJECT_COLUMNS = `o.id, o.type, o.title, o.raw_source, o.status, o.schema_version,
  o.revision, o.provenance_id, o.space_id, o.created_at, o.updated_at`;

/** A notebook = its (migratable) object row + the slug it carries. */
export interface Notebook {
  row: ObjectRow;
  slug: string;
}

export async function findNotebookBySlug(
  db: Queryable,
  spaceId: string,
  slug: string,
): Promise<{ object_id: string; slug: string } | null> {
  const r = await db.query<{ object_id: string; slug: string }>(
    `SELECT object_id, slug FROM notebook_detail WHERE space_id = $1 AND slug = $2`,
    [spaceId, slug],
  );
  return r.rows[0] ?? null;
}

/**
 * Idempotent get-or-create. Mints the (object, provenance, detail) in ONE transaction; the
 * `UNIQUE(space_id, slug)` makes one-slug-per-space a creation-time guard. On a lost race the whole tx
 * rolls back (the object PK never collides, and `notebook_detail` is the only row keyed on (space_id,
 * slug), so nothing leaks) and we return the winner. READ COMMITTED: the loser's `DO NOTHING` unblocks
 * AFTER the winner commits, so the re-SELECT always finds it.
 */
export async function getOrCreateNotebook(
  db: pg.Pool,
  object: CanonicalObject,
  provenance: Provenance,
  detail: NotebookDetail,
  spaceId: string,
  units: Unit[],
): Promise<{ created: boolean; objectId: string; slug: string }> {
  try {
    return await withTransaction(db, async (client) => {
      await insertObjectWithProvenance(client, object, provenance);
      const won = await client.query<{ object_id: string; slug: string }>(
        `INSERT INTO notebook_detail (object_id, space_id, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (space_id, slug) DO NOTHING
         RETURNING object_id, slug`,
        [detail.object_id, spaceId, detail.slug],
      );
      const row = won.rows[0];
      if (!row) throw new NotebookRaced(); // lost → roll back the orphan object+provenance
      // Pre-created scaffold units (the notation home) — persisted in the SAME tx, ONLY on a winning create.
      // They reference the object + provenance just inserted; top-level, so no parent ordering needed.
      for (const u of units) await insertContentUnit(client, u);
      return { created: true, objectId: row.object_id, slug: row.slug };
    });
  } catch (err) {
    if (err instanceof NotebookRaced) {
      const existing = await findNotebookBySlug(db, spaceId, detail.slug);
      if (!existing) throw err; // unreachable (slug immutable here, no delete) — honesty guard
      return { created: false, objectId: existing.object_id, slug: existing.slug };
    }
    throw err;
  }
}

/** Every notebook in the space, by slug. ONE query (object columns folded into the JOIN), zero N+1;
 *  hits the `notebook_detail_by_space` index. */
export async function listNotebooks(db: Queryable, spaceId: string): Promise<Notebook[]> {
  const r = await db.query<ObjectRow & { slug: string }>(
    `SELECT ${OBJECT_COLUMNS}, d.slug
     FROM notebook_detail d
     JOIN objects o ON o.id = d.object_id
     WHERE d.space_id = $1
     ORDER BY d.slug ASC`,
    [spaceId],
  );
  return r.rows.map(({ slug, ...row }) => ({ row, slug }));
}
