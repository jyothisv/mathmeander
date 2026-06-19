// Slice 2c-1 — the editor's coarse prose-authoring path (§6.0a), driven through the REAL HTTP
// chokepoint. Proves: from-nothing authoring (the gap closed), a DELTA persist (only touched rows),
// the revision gate (409), and the reconcile gate that keeps coarse save from doing semantic work
// (a type change → 422, not a silent mutation). Unit ids are client-minted UUIDv7 (§6.3).
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
  token = await stack.login('author@example.com');
});

/** A fresh journal day (the editor's host surface); returns its object id at revision 1. */
async function newDay(date = '2026-06-19'): Promise<string> {
  const res = await stack.app.inject({
    method: 'POST',
    url: '/api/journal/days',
    headers: bearer(token),
    payload: { date },
  });
  if (res.statusCode !== 201) throw new Error(`day create failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { object: { id: string } }).object.id;
}

/** A minimal rough prose unit (client-minted id), the shape the editor flushes. */
function proseUnit(objectId: string, position: number, text: string, id = uuidv7()): Unit {
  return {
    id,
    object_id: objectId,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline: [] },
    provenance_id: uuidv7(), // placeholder; the route stamps the op's provenance on new units
  };
}

function save(
  objectId: string,
  body: { expected_revision: number; upserts: Unit[]; deletes: string[] },
  authToken = token,
) {
  return stack.app.inject({
    method: 'PUT',
    url: `/api/objects/${objectId}/content`,
    headers: bearer(authToken),
    payload: body,
  });
}

async function unitCount(objectId: string): Promise<number> {
  const r = await stack.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_units WHERE object_id = $1`,
    [objectId],
  );
  return Number(r.rows[0]!.n);
}
async function versionCount(objectId: string): Promise<number> {
  const r = await stack.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM object_versions WHERE object_id = $1`,
    [objectId],
  );
  return Number(r.rows[0]!.n);
}

describe('save_content: prose authoring', () => {
  it('authors the first paragraph in an empty day (the from-nothing path)', async () => {
    const dayId = await newDay();
    const u = proseUnit(dayId, 0, 'First paragraph.');
    const res = await save(dayId, { expected_revision: 1, upserts: [u], deletes: [] });
    expect(res.statusCode).toBe(200);
    const outcome = (res.json() as { outcome: { content: { revision: number; units: Unit[] } } })
      .outcome;
    expect(outcome.content.revision).toBe(2);
    expect(outcome.content.units).toHaveLength(1);
    // The route stamps the op's provenance on a NEW unit — NOT the client's placeholder (§6.1).
    expect(outcome.content.units[0]!.provenance_id).not.toBe(u.provenance_id);
    expect(await unitCount(dayId)).toBe(1);
    expect(await versionCount(dayId)).toBe(1);
  });

  it('reorders paragraphs (a position change on existing units) — the core editing loop', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 0, 'alpha'), proseUnit(dayId, 1, 'beta')],
      deletes: [],
    });
    const persisted = (r1.json() as { outcome: { content: { units: Unit[] } } }).outcome.content
      .units;
    // Swap positions (re-project from canonical, change only position).
    const swapped = persisted.map((u) => ({ ...u, position: u.position === 0 ? 1 : 0 }));
    const res = await save(dayId, { expected_revision: 2, upserts: swapped, deletes: [] });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as { outcome: { content: { units: Unit[] } } }).outcome.content.units;
    const text = (pos: number) => {
      const u = after.find((x) => x.position === pos)!;
      return u.content.kind === 'prose' ? u.content.text : '';
    };
    expect([text(0), text(1)]).toEqual(['beta', 'alpha']);
  });

  it('deletes a MIDDLE paragraph and renumbers the survivor (not just tail-delete)', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 0, 'a'), proseUnit(dayId, 1, 'b'), proseUnit(dayId, 2, 'c')],
      deletes: [],
    });
    const persisted = (r1.json() as { outcome: { content: { units: Unit[] } } }).outcome.content
      .units;
    const b = persisted.find((u) => u.content.kind === 'prose' && u.content.text === 'b')!;
    const c = persisted.find((u) => u.content.kind === 'prose' && u.content.text === 'c')!;
    // Delete the middle unit b; c shifts 2→1 (a shifted survivor in the upserts).
    const res = await save(dayId, {
      expected_revision: 2,
      upserts: [{ ...c, position: 1 }],
      deletes: [b.id],
    });
    expect(res.statusCode).toBe(200);
    expect(await unitCount(dayId)).toBe(2);
  });

  it('edits one paragraph and adds another (a delta over two saves)', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 0, 'alpha')],
      deletes: [],
    });
    // The editor re-projects from canonical content; an edit preserves the unit's id + provenance.
    const persistedA = (r1.json() as { outcome: { content: { units: Unit[] } } }).outcome.content
      .units[0]!;

    const aEdited: Unit = { ...persistedA, content: { kind: 'prose', text: 'ALPHA', inline: [] } };
    const b = proseUnit(dayId, 1, 'beta');
    const res = await save(dayId, { expected_revision: 2, upserts: [aEdited, b], deletes: [] });
    expect(res.statusCode).toBe(200);

    const read = await stack.app.inject({
      method: 'GET',
      url: '/api/journal/days/2026-06-19',
      headers: bearer(token),
    });
    const day = (read.json() as { graph: { content: { object_id: string; units: Unit[] }[] } })
      .graph;
    const dayContent = day.content.find((c) => c.object_id === dayId)!;
    const texts = dayContent.units
      .sort((x, y) => x.position - y.position)
      .map((u) => (u.content.kind === 'prose' ? u.content.text : ''));
    expect(texts).toEqual(['ALPHA', 'beta']);
    expect(await unitCount(dayId)).toBe(2);
  });

  it('deletes a prose unit', async () => {
    const dayId = await newDay();
    const a = proseUnit(dayId, 0, 'keep');
    const b = proseUnit(dayId, 1, 'drop');
    await save(dayId, { expected_revision: 1, upserts: [a, b], deletes: [] });
    const res = await save(dayId, { expected_revision: 2, upserts: [], deletes: [b.id] });
    expect(res.statusCode).toBe(200);
    expect(await unitCount(dayId)).toBe(1);
  });

  it('a stale expected_revision is a 409 conflict', async () => {
    const dayId = await newDay();
    await save(dayId, { expected_revision: 1, upserts: [proseUnit(dayId, 0, 'x')], deletes: [] });
    // try again at the now-stale revision 1
    const res = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 1, 'y')],
      deletes: [],
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
  });

  it('rejects a semantic change (set a unit type via save_content) with 422', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 0, 'a theorem statement')],
      deletes: [],
    });
    const persisted = (r1.json() as { outcome: { content: { units: Unit[] } } }).outcome.content
      .units[0]!;

    // The ONLY difference from the persisted unit is the type — that's set_unit_type's job, not save_content's.
    const typed: Unit = { ...persisted, type: 'theorem' };
    const res = await save(dayId, { expected_revision: 2, upserts: [typed], deletes: [] });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('content_save_invalid');
    expect(await unitCount(dayId)).toBe(1); // unchanged
  });

  it('cross-space content writes are 404', async () => {
    const dayId = await newDay();
    const tokenB = await stack.login('other-author@example.com');
    const res = await save(
      dayId,
      { expected_revision: 1, upserts: [proseUnit(dayId, 0, 'x')], deletes: [] },
      tokenB,
    );
    expect(res.statusCode).toBe(404);
  });

  it('unauthenticated content writes are 401', async () => {
    const dayId = await newDay();
    const res = await stack.app.inject({
      method: 'PUT',
      url: `/api/objects/${dayId}/content`,
      payload: { expected_revision: 1, upserts: [], deletes: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to delete a unit that a link still references (DB constraint → 422)', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 0, 'referenced paragraph')],
      deletes: [],
    });
    const unit = (r1.json() as { outcome: { content: { units: Unit[] } } }).outcome.content
      .units[0]!;

    // A deliberate inbound edge onto the unit (target-side, unit-refined). Reuse the unit's own
    // provenance so the link's NOT-NULL provenance FK is satisfied without seeding a second row.
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, target_unit_id, type, status,
                          from_content, provenance_id, created_at)
       VALUES ($1,$2,$3,$4,'related','active',false,$5,now())`,
      [uuidv7(), dayId, dayId, unit.id, unit.provenance_id],
    );

    // Deleting the still-referenced unit trips the deferred composite FK at COMMIT (pg 23503) →
    // ContentConstraintError → 422 content_save_invalid — a client error, not a 500. The whole tx
    // rolls back, so the unit survives (atomicity).
    const res = await save(dayId, { expected_revision: 2, upserts: [], deletes: [unit.id] });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('content_save_invalid');
    expect(await unitCount(dayId)).toBe(1);
  });
});
