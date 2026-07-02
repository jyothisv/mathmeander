// §6.2 brace annotations, driven through the REAL HTTP chokepoint (web → server → napi core → DB). Proves:
// a first-seen annotation mints an `annotation` object + detail + target rows; a resolvable sub-term target
// is `active`; a broken sub-term path ORPHANS to `stale` (never dropped); GET returns the rows; a delete
// removes the object (detail + targets cascade); a target on a missing unit is a 422.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { Unit } from '@mathmeander/schema';
import { bearer, createStack, truncateAll, type TestStack } from './helpers.js';

let stack: TestStack;
let token: string;

beforeAll(async () => {
  stack = await createStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await truncateAll(stack.db);
  token = await stack.login('annotator@example.com');
});

async function newDay(date = '2026-06-25'): Promise<string> {
  const res = await stack.app.inject({
    method: 'POST',
    url: '/api/journal/days',
    headers: bearer(token),
    payload: { date },
  });
  if (res.statusCode !== 201) throw new Error(`day create failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { object: { id: string } }).object.id;
}

function proseUnit(objectId: string, position: number, text: string, id = uuidv7()): Unit {
  return {
    id,
    object_id: objectId,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline: [] },
    provenance_id: uuidv7(),
  };
}
function mathUnit(
  objectId: string,
  position: number,
  surface: string,
  exprId: string,
  id = uuidv7(),
): Unit {
  return {
    id,
    object_id: objectId,
    position,
    status: 'rough',
    declared_by: 'user',
    content: {
      kind: 'math',
      expr: {
        id: exprId,
        surface_text: surface,
        surface_format: 'mathmeander',
        input_syntax: 'mathmeander',
        original_input: surface,
        parse_status: 'renderable',
        occurrences: [],
      },
    },
    provenance_id: uuidv7(),
  };
}
const save = (
  objectId: string,
  body: { expected_revision: number; upserts: Unit[]; deletes: string[] },
) =>
  stack.app.inject({
    method: 'PUT',
    url: `/api/objects/${objectId}/content`,
    headers: bearer(token),
    payload: body,
  });

const reconcile = (objectId: string, body: Record<string, unknown>) =>
  stack.app.inject({
    method: 'POST',
    url: `/api/objects/${objectId}/annotations`,
    headers: bearer(token),
    payload: body,
  });
const getAnnotations = (objectId: string) =>
  stack.app.inject({
    method: 'GET',
    url: `/api/objects/${objectId}/annotations`,
    headers: bearer(token),
  });

function overbrace(text: string) {
  return { kind: 'overbrace', label: { text, inline: [] }, gap: 'small' };
}
function subTermTarget(id: string, unitId: string, exprId: string, path: number[]) {
  return {
    id,
    role: 'target',
    position: 0,
    target_unit_id: unitId,
    extent: { kind: 'sub_term', expression_id: exprId, term_path: path },
  };
}

describe('§6.2 brace annotations: reconcile round-trip', () => {
  it('binds an overbrace to a math sub-term, persists, reads back, and orphans a broken path', async () => {
    const dayId = await newDay();
    const mathId = uuidv7();
    const exprId = uuidv7();
    // Author a display equation "x^2 + y" (so `[0]` is the `Sup{x,2}` sub-term) + a prose unit.
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [
        mathUnit(dayId, 0, 'x^2 + y', exprId, mathId),
        proseUnit(dayId, 1, 'the discriminant'),
      ],
      deletes: [],
    });
    expect(r1.statusCode).toBe(200);

    // Bind an overbrace to the `[0]` sub-term → a fresh annotation object + an ACTIVE target.
    const annId = uuidv7();
    const tgtId = uuidv7();
    const res = await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(), // the route overrides this from the session
      upserts: [
        {
          annotation_id: annId,
          primitives: [overbrace('the square')],
          targets: [subTermTarget(tgtId, mathId, exprId, [0])],
        },
      ],
      deletes: [],
    });
    expect(res.statusCode).toBe(200);
    const outcome = (
      res.json() as { outcome: { new_objects: unknown[]; targets_upserted: { status: string }[] } }
    ).outcome;
    expect(outcome.new_objects).toHaveLength(1);
    expect(outcome.targets_upserted).toHaveLength(1);
    expect(outcome.targets_upserted[0]!.status).toBe('active');

    // GET returns the detail + target rows.
    const got = (await getAnnotations(dayId)).json() as {
      details: { object_id: string }[];
      targets: { annotation_id: string; status: string }[];
    };
    expect(got.details).toHaveLength(1);
    expect(got.details[0]!.object_id).toBe(annId);
    expect(got.targets).toHaveLength(1);
    expect(got.targets[0]!.annotation_id).toBe(annId);

    // Re-reconcile the SAME annotation with a broken path `[9]` → the target ORPHANS to `stale`, not dropped.
    const res2 = await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(),
      upserts: [
        {
          annotation_id: annId,
          primitives: [overbrace('gone')],
          targets: [subTermTarget(tgtId, mathId, exprId, [9])],
        },
      ],
      deletes: [],
    });
    expect(res2.statusCode).toBe(200);
    const got2 = (await getAnnotations(dayId)).json() as { targets: { status: string }[] };
    expect(got2.targets).toHaveLength(1); // kept
    expect(got2.targets[0]!.status).toBe('stale');
  });

  it('deletes an annotation (detail + targets cascade)', async () => {
    const dayId = await newDay();
    const mathId = uuidv7();
    const exprId = uuidv7();
    await save(dayId, {
      expected_revision: 1,
      upserts: [mathUnit(dayId, 0, 'x^2 + y', exprId, mathId)],
      deletes: [],
    });
    const annId = uuidv7();
    await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(),
      upserts: [
        {
          annotation_id: annId,
          primitives: [overbrace('x')],
          targets: [subTermTarget(uuidv7(), mathId, exprId, [0])],
        },
      ],
      deletes: [],
    });
    const del = await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(),
      upserts: [],
      deletes: [annId],
    });
    expect(del.statusCode, del.body).toBe(200);
    const got = (await getAnnotations(dayId)).json() as { details: unknown[]; targets: unknown[] };
    expect(got.details).toHaveLength(0);
    expect(got.targets).toHaveLength(0);
  });

  it('rejects a target on a unit not in this object (422)', async () => {
    const dayId = await newDay();
    await save(dayId, { expected_revision: 1, upserts: [proseUnit(dayId, 0, 'x')], deletes: [] });
    const res = await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(),
      upserts: [
        {
          annotation_id: uuidv7(),
          primitives: [overbrace('x')],
          targets: [
            {
              id: uuidv7(),
              role: 'target',
              position: 0,
              target_unit_id: uuidv7(),
              extent: { kind: 'locator', locator: { kind: 'whole_unit' } },
            },
          ],
        },
      ],
      deletes: [],
    });
    expect(res.statusCode).toBe(422);
  });

  it('deleting an ANNOTATED unit succeeds and drops the dangling target (no FK wedge)', async () => {
    // The review's MAJOR 1: persistContentDelta cleaned handles + from_content links for deleted units
    // but not annotation_targets — the deferred composite FK tripped at COMMIT (23503 → 422 → permanent
    // autosave wedge). The annotation OBJECT survives (an orphan the editor may re-bind or drop).
    const dayId = await newDay();
    const mathId = uuidv7();
    const exprId = uuidv7();
    const annId = uuidv7();
    await save(dayId, {
      expected_revision: 1,
      upserts: [mathUnit(dayId, 0, 'x^2 + y', exprId, mathId), proseUnit(dayId, 1, 'stays')],
      deletes: [],
    });
    await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(),
      upserts: [
        {
          annotation_id: annId,
          primitives: [overbrace('x')],
          targets: [subTermTarget(uuidv7(), mathId, exprId, [0])],
        },
      ],
      deletes: [],
    });
    // Delete the annotated unit through the content path.
    const res = await save(dayId, { expected_revision: 2, upserts: [], deletes: [mathId] });
    expect(res.statusCode).toBe(200); // the wedge was a 422 here
    const got = (await getAnnotations(dayId)).json() as { details: unknown[]; targets: unknown[] };
    expect(got.targets).toHaveLength(0); // the dangling binding died with its unit
    // The annotation OBJECT survives (an orphan; only its unit binding died with the unit).
    const obj = await stack.db.query(`SELECT id FROM objects WHERE id = $1`, [annId]);
    expect(obj.rows).toHaveLength(1);
  });

  it('a delete naming a NON-annotation / foreign object id is a no-op (never deletes it)', async () => {
    // The review's MAJOR 2: input.deletes went verbatim into `DELETE FROM objects` — an arbitrary-object
    // delete. The core now filters deletes to the host's own annotations, and the SQL is scoped to
    // annotation-type objects of the session's space.
    const dayId = await newDay();
    const otherDayId = await newDay('2026-06-26'); // an innocent object in the same space
    await save(dayId, { expected_revision: 1, upserts: [proseUnit(dayId, 0, 'hi')], deletes: [] });
    const res = await reconcile(dayId, {
      expected_revision: 2,
      space_id: uuidv7(),
      upserts: [],
      deletes: [otherDayId],
    });
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { outcome: { objects_removed: string[] } }).outcome.objects_removed,
    ).toEqual([]);
    const victim = await stack.db.query(`SELECT id FROM objects WHERE id = $1`, [otherDayId]);
    expect(victim.rows).toHaveLength(1); // the named object is untouched
  });
});
