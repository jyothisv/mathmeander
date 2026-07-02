// Plain SQL for §6.2 brace/embrace annotations (no ORM). Load an object's annotations (detail + target
// rows) for the editor, and persist a `reconcile_annotations` outcome in one transaction. Annotations are a
// SEPARATE aggregate from content_units — the write never touches the host revision; a stale/orphaned target
// (status `stale`) self-heals on the next re-derive.
import type pg from 'pg';
import type {
  AnnotationDetail,
  AnnotationOpOutcome,
  AnnotationTarget,
  Provenance,
} from '@mathmeander/schema';
import { withTransaction, type Db } from './pool.js';
import { insertObjectRow, upsertProvenance } from './graph.js';

type Queryable = pg.Pool | pg.PoolClient;

interface TargetRow {
  id: string;
  annotation_id: string;
  role: string;
  position: number;
  target_unit_id: string;
  target_object_id: string;
  extent: unknown; // jsonb — pre-parsed by pg
  status: string;
  provenance_id: string;
}

function rowToTarget(r: TargetRow): AnnotationTarget {
  return {
    id: r.id,
    annotation_id: r.annotation_id,
    role: r.role,
    position: r.position,
    target_unit_id: r.target_unit_id,
    target_object_id: r.target_object_id,
    extent: r.extent,
    status: r.status,
    provenance_id: r.provenance_id,
  } as AnnotationTarget;
}

const TARGET_COLUMNS = `id, annotation_id, role, "position", target_unit_id, target_object_id,
                        extent, status, provenance_id`;

/** The annotation target rows bound INTO an object — the reconcile's "current" set (new-vs-existing +
 *  orphan detection) and the editor's render input. */
export async function loadAnnotationTargets(
  db: Queryable,
  objectId: string,
): Promise<AnnotationTarget[]> {
  const res = await db.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM annotation_targets WHERE target_object_id = $1
     ORDER BY annotation_id, "position"`,
    [objectId],
  );
  return res.rows.map(rowToTarget);
}

/** An object's annotations for the editor: the detail rows (HOW each is drawn) + the target rows (WHAT each
 *  binds), both keyed by the annotation object's id. */
export async function loadAnnotations(
  db: Queryable,
  objectId: string,
): Promise<{ details: AnnotationDetail[]; targets: AnnotationTarget[] }> {
  const targets = await loadAnnotationTargets(db, objectId);
  const annIds = [...new Set(targets.map((t) => t.annotation_id))];
  const details =
    annIds.length === 0
      ? []
      : (
          await db.query<{ object_id: string; primitives: unknown }>(
            `SELECT object_id, primitives FROM annotation_detail WHERE object_id = ANY($1)`,
            [annIds],
          )
        ).rows.map(
          (r) => ({ object_id: r.object_id, primitives: r.primitives }) as AnnotationDetail,
        );
  return { details, targets };
}

/** Persist a `reconcile_annotations` outcome (§6.2) in one transaction: delete removed annotation objects
 *  (detail + targets cascade via ON DELETE CASCADE), insert new annotation objects, upsert details, and
 *  REPLACE each upserted annotation's targets (delete-then-reinsert). The op's provenance is inserted first
 *  (new objects + targets reference it). Does NOT touch the host revision. */
export async function persistAnnotationDelta(
  db: Db,
  outcome: AnnotationOpOutcome,
  opts: { provenance: Provenance; spaceId: string },
): Promise<void> {
  await withTransaction(db, async (client) => {
    await upsertProvenance(client, opts.provenance);
    if (outcome.objects_removed.length > 0) {
      // Defense-in-depth atop the core's deletes-⊆-current filter: only ANNOTATION objects of the
      // session's own space are ever deletable through this path — an unscoped `id = ANY($1)` was an
      // arbitrary-object delete one hop from client input.
      await client.query(
        `DELETE FROM objects WHERE id = ANY($1) AND type = 'annotation' AND space_id = $2`,
        [outcome.objects_removed, opts.spaceId],
      );
    }
    for (const obj of outcome.new_objects) await insertObjectRow(client, obj);
    for (const d of outcome.details_upserted) {
      await client.query(
        `INSERT INTO annotation_detail (object_id, primitives) VALUES ($1, $2)
         ON CONFLICT (object_id) DO UPDATE SET primitives = EXCLUDED.primitives`,
        [d.object_id, JSON.stringify(d.primitives)],
      );
    }
    // Replace each upserted annotation's targets (delete this annotation's rows, then reinsert the outcome's).
    const upsertedIds = outcome.details_upserted.map((d) => d.object_id);
    if (upsertedIds.length > 0) {
      await client.query(`DELETE FROM annotation_targets WHERE annotation_id = ANY($1)`, [
        upsertedIds,
      ]);
    }
    for (const t of outcome.targets_upserted) {
      await client.query(
        `INSERT INTO annotation_targets (${TARGET_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          t.id,
          t.annotation_id,
          t.role,
          t.position,
          t.target_unit_id,
          t.target_object_id,
          JSON.stringify(t.extent),
          t.status,
          t.provenance_id,
        ],
      );
    }
  });
}
