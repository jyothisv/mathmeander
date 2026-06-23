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

/** A rough display-math unit (the editable-equation shape the editor flushes, §6.3a). The expr is
 *  fresh: zero occurrences, no inbound anchor — so the relaxed `save_content` accepts create + edit. */
function mathUnit(
  objectId: string,
  position: number,
  surface: string,
  exprId = uuidv7(),
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

// The §6.3a editable-equation path (the relaxed gate, this increment): a display `Math` unit is
// created + edited through the SAME coarse delta as prose, keystone-guarded server-side (the route
// loads current_links). Cited equations must fall back to rewrite_surface — proven here as a 422.
describe('save_content: display math (the relaxed gate)', () => {
  type OutcomeBody = { outcome: { content: { revision: number; units: Unit[] } } };
  const exprOf = (u: Unit) => (u.content.kind === 'math' ? u.content.expr : null);

  it('creates a display equation from nothing (new zero-anchor Math unit)', async () => {
    const dayId = await newDay();
    const m = mathUnit(dayId, 0, 'x^2');
    const res = await save(dayId, { expected_revision: 1, upserts: [m], deletes: [] });
    expect(res.statusCode).toBe(200);
    const outcome = (res.json() as OutcomeBody).outcome;
    expect(outcome.content.revision).toBe(2);
    expect(outcome.content.units).toHaveLength(1);
    expect(outcome.content.units[0]!.content.kind).toBe('math');
    expect(exprOf(outcome.content.units[0]!)?.surface_text).toBe('x^2');
    expect(await unitCount(dayId)).toBe(1);
  });

  it('edits an uncited display equation surface in place (keystone-safe)', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [mathUnit(dayId, 0, 'x')],
      deletes: [],
    });
    const persisted = (r1.json() as OutcomeBody).outcome.content.units[0]!;
    const priorExpr = exprOf(persisted)!;

    // Re-author the surface in place — same expr id, no anchors → rides save_content like a prose edit.
    const edited: Unit = {
      ...persisted,
      content: {
        kind: 'math',
        expr: { ...priorExpr, surface_text: 'y + 1', original_input: 'y + 1' },
      },
    };
    const res = await save(dayId, { expected_revision: 2, upserts: [edited], deletes: [] });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as OutcomeBody).outcome.content.units[0]!;
    expect(after.content.kind).toBe('math');
    expect(exprOf(after)?.surface_text).toBe('y + 1');
    expect(exprOf(after)?.id).toBe(priorExpr.id); // identity preserved across the in-place edit
  });

  it('rejects re-authoring a CITED display equation (keystone → 422, use rewrite_surface)', async () => {
    const dayId = await newDay();
    const exprId = uuidv7();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [mathUnit(dayId, 0, 'x', exprId)],
      deletes: [],
    });
    const persisted = (r1.json() as OutcomeBody).outcome.content.units[0]!;

    // An inbound content-derived edge anchored INTO the expression (an ExpressionSpan locator), the
    // shape resolve_occurrence mints. Seeded directly; reuse the unit's provenance for the NOT-NULL FK.
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, source_unit_id, content_locator,
                          type, status, from_content, provenance_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'related','active',true,$6,now())`,
      [
        uuidv7(),
        dayId,
        dayId,
        persisted.id,
        JSON.stringify({ kind: 'expression_span', expression_id: exprId, start: 0, end: 1 }),
        persisted.provenance_id,
      ],
    );

    // Now a free re-author of the surface must be refused — only rewrite_surface can remap the anchor.
    const edited: Unit = {
      ...persisted,
      content: { kind: 'math', expr: { ...exprOf(persisted)!, surface_text: 'z' } },
    };
    const res = await save(dayId, { expected_revision: 2, upserts: [edited], deletes: [] });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('content_save_invalid');
    // unchanged on disk (the whole tx rolled back conceptually — nothing persisted)
    const after = await stack.db.query<{ content: { expr: { surface_text: string } } }>(
      `SELECT content FROM content_units WHERE id = $1`,
      [persisted.id],
    );
    expect(after.rows[0]!.content.expr.surface_text).toBe('x');
  });

  it('repositions a display equation among prose (position-only, still accepted)', async () => {
    const dayId = await newDay();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [proseUnit(dayId, 0, 'before'), mathUnit(dayId, 1, 'x^2')],
      deletes: [],
    });
    const units = (r1.json() as OutcomeBody).outcome.content.units;
    const swapped = units.map((u) => ({ ...u, position: u.position === 0 ? 1 : 0 }));
    const res = await save(dayId, { expected_revision: 2, upserts: swapped, deletes: [] });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as OutcomeBody).outcome.content.units;
    const math = after.find((u) => u.content.kind === 'math')!;
    expect(math.position).toBe(0); // moved ahead of the prose
  });

  it('rejects re-authoring a CROSS-OBJECT-cited equation (inbound ExpressionRef → 422)', async () => {
    const dayId = await newDay('2026-06-20');
    const other = await newDay('2026-06-21'); // a second object that will cite this equation
    const exprId = uuidv7();
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [mathUnit(dayId, 0, 'x', exprId)],
      deletes: [],
    });
    const persisted = (r1.json() as OutcomeBody).outcome.content.units[0]!;

    // A CROSS-OBJECT citation INTO this expr: a target-side `ExpressionRef` edge from `other` → this object.
    // This is loaded by `loadInboundLinks` (WHERE target_object_id = this), which the keystone now inspects.
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, target_unit_id, target_selector,
                          type, status, from_content, provenance_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'related','active',false,$6,now())`,
      [
        uuidv7(),
        other,
        dayId,
        persisted.id,
        JSON.stringify({ kind: 'expression_ref', expression_id: exprId }),
        persisted.provenance_id,
      ],
    );

    const edited: Unit = {
      ...persisted,
      content: { kind: 'math', expr: { ...exprOf(persisted)!, surface_text: 'z' } },
    };
    const res = await save(dayId, { expected_revision: 2, upserts: [edited], deletes: [] });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('content_save_invalid');
  });
});

describe('save_content: systems (2-B — Equations container + Math rows)', () => {
  /** A rough `Equations` container (the system); rows nest under it via `parent_unit_id`. */
  function equationsContainer(objectId: string, position: number, id = uuidv7()): Unit {
    return {
      id,
      object_id: objectId,
      position,
      status: 'rough',
      declared_by: 'user',
      content: { kind: 'equations' },
      provenance_id: uuidv7(),
    };
  }
  /** A Math ROW under an Equations container. */
  function mathRow(
    objectId: string,
    parent: string,
    position: number,
    surface: string,
    id = uuidv7(),
  ): Unit {
    return { ...mathUnit(objectId, position, surface, uuidv7(), id), parent_unit_id: parent };
  }
  async function parentRows(objectId: string, parent: string): Promise<number> {
    const r = await stack.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_units WHERE object_id = $1 AND parent_unit_id = $2`,
      [objectId, parent],
    );
    return Number(r.rows[0]!.n);
  }

  it('creates a system in one delta: container + 2 rows persist with parent_unit_id + positions', async () => {
    const dayId = await newDay();
    const container = equationsContainer(dayId, 0);
    const rows = [
      mathRow(dayId, container.id, 0, '2x + y = 1'),
      mathRow(dayId, container.id, 1, 'x - y = 4'),
    ];
    const res = await save(dayId, {
      expected_revision: 1,
      upserts: [container, ...rows],
      deletes: [],
    });
    expect(res.statusCode).toBe(200);
    expect(await unitCount(dayId)).toBe(3);
    expect(await parentRows(dayId, container.id)).toBe(2);
  });

  it('edits a system row in place (a content-only upsert)', async () => {
    const dayId = await newDay();
    const container = equationsContainer(dayId, 0);
    const row0 = mathRow(dayId, container.id, 0, 'a = 1');
    const row1 = mathRow(dayId, container.id, 1, 'b = 2');
    const r1 = await save(dayId, {
      expected_revision: 1,
      upserts: [container, row0, row1],
      deletes: [],
    });
    // Edit the PERSISTED row (route-stamped provenance) — an existing-unit content edit must match every
    // frozen facet except content/position, so we re-flush from the server's returned unit.
    const units = (r1.json() as { outcome: { content: { units: Unit[] } } }).outcome.content.units;
    const persisted = units.find((u) => u.parent_unit_id === container.id && u.position === 1)!;
    const e0 = persisted.content.kind === 'math' ? persisted.content.expr : null;
    const edited: Unit = {
      ...persisted,
      content: { kind: 'math', expr: { ...e0!, surface_text: 'b = 3' } },
    };
    const res = await save(dayId, { expected_revision: 2, upserts: [edited], deletes: [] });
    expect(res.statusCode).toBe(200);
    expect(await unitCount(dayId)).toBe(3); // still container + 2 rows
  });

  it('deletes a whole system (container + rows) in one delta', async () => {
    const dayId = await newDay();
    const container = equationsContainer(dayId, 0);
    const row0 = mathRow(dayId, container.id, 0, 'a = 1');
    const row1 = mathRow(dayId, container.id, 1, 'b = 2');
    await save(dayId, { expected_revision: 1, upserts: [container, row0, row1], deletes: [] });

    const res = await save(dayId, {
      expected_revision: 2,
      upserts: [],
      deletes: [container.id, row0.id, row1.id],
    });
    expect(res.statusCode).toBe(200);
    expect(await unitCount(dayId)).toBe(0);
  });

  it('rejects a row under a NON-Equations parent → 422', async () => {
    const dayId = await newDay();
    const p = proseUnit(dayId, 0, 'a paragraph');
    await save(dayId, { expected_revision: 1, upserts: [p], deletes: [] });
    // A math row pointing at the prose unit as its parent — not an Equations container.
    const row = mathRow(dayId, p.id, 1, 'x');
    const res = await save(dayId, { expected_revision: 2, upserts: [row], deletes: [] });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('content_save_invalid');
  });
});
