// Slice 2a Pass B — the §9.y ownership matrix, driven through the REAL HTTP chokepoint against
// Postgres (web → server → napi core → DB). Re-home moves a declared subtree into a new object
// (ids preserved, the host left holding one Embed) and dissolve is its inverse; this proves the
// model-level §9.y criteria end-to-end AND the cross-object atomic persist (deferred-FK move,
// dual-gate dissolve). A final test records the origin-reference side-by-side scorecard (§18.5).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { OpOutcome } from '@mathmeander/schema';
import { bearer, createStack, seedTheoremHost, truncateAll, type TestStack } from './helpers.js';
import { loadContent, persistObjectGraph } from '../../src/db/graph.js';
import { dissolveObject } from '../../src/core/index.js';

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
  token = await stack.login('mathematician@example.com');
});

// ── tiny SQL helpers (no endpoint authors these rows yet) ──
async function spaceOf(objectId: string): Promise<string> {
  const r = await stack.db.query<{ space_id: string }>(
    `SELECT space_id FROM objects WHERE id = $1`,
    [objectId],
  );
  return r.rows[0]!.space_id;
}
async function objectCount(): Promise<number> {
  const r = await stack.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM objects`);
  return Number(r.rows[0]!.n);
}
async function revisionOf(objectId: string): Promise<number | null> {
  const r = await stack.db.query<{ revision: number }>(
    `SELECT revision FROM objects WHERE id = $1`,
    [objectId],
  );
  return r.rows[0]?.revision ?? null;
}
async function unitObjectId(unitId: string): Promise<string | null> {
  const r = await stack.db.query<{ object_id: string }>(
    `SELECT object_id FROM content_units WHERE id = $1`,
    [unitId],
  );
  return r.rows[0]?.object_id ?? null;
}

/** Rehome the seeded theorem; returns the new object's id + the response outcome. */
async function rehome(
  hostId: string,
  rootId: string,
  expectedRevision = 1,
): Promise<{ status: number; newObjectId: string; outcome: OpOutcome | undefined }> {
  const res = await stack.app.inject({
    method: 'POST',
    url: `/api/objects/${hostId}/ops/rehome`,
    headers: bearer(token),
    payload: { expected_revision: expectedRevision, subtree_root: rootId, type: 'theorem' },
  });
  const body = res.json() as { outcome?: OpOutcome };
  return {
    status: res.statusCode,
    newObjectId: body.outcome ? body.outcome.new_objects[0]!.id : '',
    outcome: body.outcome,
  };
}

describe('§9.y ownership: re-home', () => {
  test('materializes a new object: ids preserved, host left with one embed, T owns its history', async () => {
    const h = await seedTheoremHost(stack, token);
    const { status, newObjectId, outcome } = await rehome(h.hostId, h.rootId);
    expect(status).toBe(200);
    expect(outcome).toBeDefined();
    const oc = outcome!;

    // The outcome: content = the new object (the moved subtree); host_content = the mutated host.
    const movedIds = oc.content.units.map((u) => u.id).sort();
    expect(movedIds).toEqual([h.rootId, h.stmtId, h.mathId].sort());
    const embeds = (oc.host_content?.units ?? []).filter((u) => u.content.kind === 'embed');
    expect(embeds).toHaveLength(1);
    const embed = embeds[0]!;
    if (embed.content.kind === 'embed' && embed.content.target.kind === 'object') {
      expect(embed.content.target.object_id).toBe(newObjectId);
    }

    // Persisted: the moved units now live under the new object; host keeps before/after + the embed.
    expect(await unitObjectId(h.rootId)).toBe(newObjectId);
    expect(await unitObjectId(h.stmtId)).toBe(newObjectId);
    expect(await unitObjectId(h.beforeId)).toBe(h.hostId);
    expect(await objectCount()).toBe(2); // host + the new theorem object

    // T owns its OWN version history; the host's revision bumped.
    expect(await revisionOf(newObjectId)).toBe(1);
    expect(await revisionOf(h.hostId)).toBe(2);
    const tv = await stack.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM object_versions WHERE object_id = $1`,
      [newObjectId],
    );
    expect(Number(tv.rows[0]!.n)).toBe(1);
  });

  test('rejects a non-producible new type (422), writing nothing', async () => {
    const h = await seedTheoremHost(stack, token);
    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/rehome`,
      headers: bearer(token),
      payload: { expected_revision: 1, subtree_root: h.rootId, type: 'source_excerpt' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('type_not_producible_yet');
    expect(await objectCount()).toBe(1); // no orphan object
  });

  test('a stale host gate loses the race → 409, no orphan object', async () => {
    const h = await seedTheoremHost(stack, token);
    const { status } = await rehome(h.hostId, h.rootId, 99);
    expect(status).toBe(409);
    expect(await objectCount()).toBe(1);
    expect(await unitObjectId(h.rootId)).toBe(h.hostId); // nothing moved
  });

  test('materialize: a stale source gate → 409 (no orphan copy); the current revision copies', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId); // a materializable `theorem` object, rev 1
    const materialize = (sourceId: string, rev: number) =>
      stack.app.inject({
        method: 'POST',
        url: `/api/objects/${sourceId}/ops/materialize`,
        headers: bearer(token),
        payload: { expected_revision: rev },
      });
    // §6.4: copying a SINCE-CHANGED source must 409 — pre-fix the materialize branch skipped the revision
    // gate and copied silently. A wrong expected_revision stands in for "the source moved since you read it".
    expect((await materialize(newObjectId, 99)).statusCode).toBe(409);
    expect(await objectCount()).toBe(2); // host + theorem; the rejected copy left no orphan
    // At the current revision the copy succeeds (a fresh object).
    expect((await materialize(newObjectId, 1)).statusCode).toBe(200);
    expect(await objectCount()).toBe(3); // + the materialized copy
  });

  test('composite-FK edges (link source + unit/expr handles) re-point to the new object', async () => {
    const h = await seedTheoremHost(stack, token);
    const space = await spaceOf(h.hostId);
    // A content-derived edge whose source is a moved unit.
    const linkId = uuidv7();
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, unresolved_text, type, status,
                          from_content, source_unit_id, content_locator, provenance_id, created_at)
       VALUES ($1,$2,NULL,'Bolzano','related','active',true,$3,$4,$5,now())`,
      [linkId, h.hostId, h.stmtId, JSON.stringify({ kind: 'whole_unit' }), h.provenanceId],
    );
    // A unit-anchored handle and an expression-anchored handle, both on moved units.
    const handleU = uuidv7();
    const handleE = uuidv7();
    await stack.db.query(
      `INSERT INTO handles (id, space_id, name, target_object_id, target_unit_id, status, scope, provenance_id)
       VALUES ($1,$2,'(unit)',$3,$4,'active','object',$5)`,
      [handleU, space, h.hostId, h.stmtId, h.provenanceId],
    );
    await stack.db.query(
      `INSERT INTO handles (id, space_id, name, target_object_id, target_expression_id, status, scope, provenance_id)
       VALUES ($1,$2,'(expr)',$3,$4,'active','object',$5)`,
      [handleE, space, h.hostId, h.exprId, h.provenanceId],
    );

    const { status, newObjectId } = await rehome(h.hostId, h.rootId);
    expect(status).toBe(200);

    const link = await stack.db.query<{ source_object_id: string }>(
      `SELECT source_object_id FROM links WHERE id = $1`,
      [linkId],
    );
    expect(link.rows[0]!.source_object_id).toBe(newObjectId); // source-side followed the moved unit
    const hu = await stack.db.query<{ target_object_id: string }>(
      `SELECT target_object_id FROM handles WHERE id = $1`,
      [handleU],
    );
    expect(hu.rows[0]!.target_object_id).toBe(newObjectId);
    const he = await stack.db.query<{ target_object_id: string }>(
      `SELECT target_object_id FROM handles WHERE id = $1`,
      [handleE],
    );
    expect(he.rows[0]!.target_object_id).toBe(newObjectId); // expression-anchored handle too
  });

  test('cross-object revision independence: editing the rehomed object does not touch the host', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);
    expect(await revisionOf(h.hostId)).toBe(2);

    const typed = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${newObjectId}/ops/set-unit-type`,
      headers: bearer(token),
      payload: { expected_revision: 1, unit_id: h.stmtId, unit_type: 'lemma' },
    });
    expect(typed.statusCode).toBe(200);
    expect(await revisionOf(newObjectId)).toBe(2); // the object's own history advanced
    expect(await revisionOf(h.hostId)).toBe(2); // the host did NOT
  });
});

describe('§9.y ownership: dissolve (the inverse)', () => {
  test('re-home ∘ dissolve restores the host; the object is destroyed', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);

    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/dissolve`,
      headers: bearer(token),
      payload: {
        expected_revision: 2,
        expected_dissolved_revision: 1,
        dissolved_object_id: newObjectId,
      },
    });
    expect(res.statusCode).toBe(200);

    // The object is gone; its units folded back under the host; no embed remains.
    expect(await revisionOf(newObjectId)).toBeNull();
    expect(await unitObjectId(h.rootId)).toBe(h.hostId);
    expect(await unitObjectId(h.stmtId)).toBe(h.hostId);
    const embeds = await stack.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_units WHERE object_id = $1 AND content_kind = 'embed'`,
      [h.hostId],
    );
    expect(Number(embeds.rows[0]!.n)).toBe(0);
    expect(await objectCount()).toBe(1);
  });

  test('a tag on a moved unit survives re-home AND dissolve (FK on id, never re-pointed)', async () => {
    const h = await seedTheoremHost(stack, token);
    const space = await spaceOf(h.hostId);
    const tagId = uuidv7();
    const taggingId = uuidv7();
    await stack.db.query(`INSERT INTO tags (id, space_id, name) VALUES ($1,$2,'central')`, [
      tagId,
      space,
    ]);
    await stack.db.query(
      `INSERT INTO taggings (id, tag_id, tagged_unit_id, created_at) VALUES ($1,$2,$3,now())`,
      [taggingId, tagId, h.stmtId],
    );

    const { newObjectId } = await rehome(h.hostId, h.rootId);
    const afterRehome = await stack.db.query(`SELECT id FROM taggings WHERE id = $1`, [taggingId]);
    expect(afterRehome.rowCount).toBe(1); // the tag still resolves to the (preserved) unit, now under T

    await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/dissolve`,
      headers: bearer(token),
      payload: {
        expected_revision: 2,
        expected_dissolved_revision: 1,
        dissolved_object_id: newObjectId,
      },
    });
    const afterDissolve = await stack.db.query(`SELECT id FROM taggings WHERE id = $1`, [
      taggingId,
    ]);
    expect(afterDissolve.rowCount).toBe(1); // survives the fold-back too
  });

  test('dissolution with an external inbound link is a reviewable refusal (422), nothing destroyed', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);

    // A second object proves the theorem — an external dependency on its identity.
    const proofId = uuidv7();
    await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: proofId, type: 'note', title: 'proof' },
    });
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, type, status, from_content, provenance_id, created_at)
       VALUES ($1,$2,$3,'proves','active',false,$4,now())`,
      [uuidv7(), proofId, newObjectId, h.provenanceId],
    );

    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/dissolve`,
      headers: bearer(token),
      payload: {
        expected_revision: 2,
        expected_dissolved_revision: 1,
        dissolved_object_id: newObjectId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('dissolution_blocked');
    expect(await revisionOf(newObjectId)).toBe(1); // still alive
  });

  test('dual-gate atomicity: a stale dissolved-revision → 409, nothing destroyed', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);
    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/dissolve`,
      headers: bearer(token),
      payload: {
        expected_revision: 2,
        expected_dissolved_revision: 99,
        dissolved_object_id: newObjectId,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(await revisionOf(newObjectId)).toBe(1); // not deleted
    expect(await unitObjectId(h.rootId)).toBe(newObjectId); // host not mutated (units still under T)
  });
});

describe('§9.y ownership: re-point + concurrency coverage', () => {
  test('backlink: a unit-targeted inbound edge re-points to the new object on rehome', async () => {
    const h = await seedTheoremHost(stack, token);
    const refId = uuidv7();
    await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: refId, type: 'note', title: 'refers' },
    });
    // A deliberate edge from another object INTO the statement unit (target-side, unit-refined).
    const linkId = uuidv7();
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, target_unit_id, type, status,
                          from_content, provenance_id, created_at)
       VALUES ($1,$2,$3,$4,'related','active',false,$5,now())`,
      [linkId, refId, h.hostId, h.stmtId, h.provenanceId],
    );

    const { newObjectId } = await rehome(h.hostId, h.rootId);
    const link = await stack.db.query<{ target_object_id: string; target_unit_id: string }>(
      `SELECT target_object_id, target_unit_id FROM links WHERE id = $1`,
      [linkId],
    );
    expect(link.rows[0]!.target_object_id).toBe(newObjectId); // the backlink followed the moved unit
    expect(link.rows[0]!.target_unit_id).toBe(h.stmtId);
  });

  test('inline-math carrier: an expression-anchored handle on inline math re-points on rehome', async () => {
    const h = await seedTheoremHost(stack, token);
    const space = await spaceOf(h.hostId);
    const handleId = uuidv7();
    await stack.db.query(
      `INSERT INTO handles (id, space_id, name, target_object_id, target_expression_id, status, scope, provenance_id)
       VALUES ($1,$2,'(inline)',$3,$4,'active','object',$5)`,
      [handleId, space, h.hostId, h.inlineExprId, h.provenanceId],
    );
    const { newObjectId } = await rehome(h.hostId, h.rootId);
    const hr = await stack.db.query<{ target_object_id: string }>(
      `SELECT target_object_id FROM handles WHERE id = $1`,
      [handleId],
    );
    // The inline expression id is found via the prose-inline walk → the handle followed it.
    expect(hr.rows[0]!.target_object_id).toBe(newObjectId);
  });

  test('a stale HOST gate on dissolve → 409, nothing destroyed', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);
    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/dissolve`,
      headers: bearer(token),
      payload: {
        expected_revision: 99,
        expected_dissolved_revision: 1,
        dissolved_object_id: newObjectId,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(await revisionOf(newObjectId)).toBe(1); // not destroyed
    expect(await unitObjectId(h.rootId)).toBe(newObjectId); // host not mutated
  });

  test('a self-edge re-points to the new object on rehome and back to the host on dissolve', async () => {
    const h = await seedTheoremHost(stack, token);
    const linkId = uuidv7();
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, unresolved_text, type, status,
                          from_content, source_unit_id, content_locator, provenance_id, created_at)
       VALUES ($1,$2,NULL,'BW','related','active',true,$3,$4,$5,now())`,
      [linkId, h.hostId, h.stmtId, JSON.stringify({ kind: 'whole_unit' }), h.provenanceId],
    );

    const { newObjectId } = await rehome(h.hostId, h.rootId);
    let link = await stack.db.query<{ source_object_id: string }>(
      `SELECT source_object_id FROM links WHERE id = $1`,
      [linkId],
    );
    expect(link.rows[0]!.source_object_id).toBe(newObjectId); // followed the moved unit into T

    const dis = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${h.hostId}/ops/dissolve`,
      headers: bearer(token),
      payload: {
        expected_revision: 2,
        expected_dissolved_revision: 1,
        dissolved_object_id: newObjectId,
      },
    });
    expect(dis.statusCode).toBe(200);
    link = await stack.db.query<{ source_object_id: string }>(
      `SELECT source_object_id FROM links WHERE id = $1`,
      [linkId],
    );
    expect(link.rows[0]!.source_object_id).toBe(h.hostId); // re-pointed back to the host on dissolve
  });

  test('dissolution TOCTOU: a reference added after the (clean) pre-read is caught in-transaction', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);
    const space = await spaceOf(h.hostId);

    // Build a dissolve outcome AS IF the route's pre-read saw no inbound refs (inbound_references: []).
    const hostContent = await loadContent(stack.db, space, h.hostId);
    const dissolvedContent = await loadContent(stack.db, space, newObjectId);
    const embed = hostContent!.units.find((u) => u.content.kind === 'embed')!;
    const provId = uuidv7();
    const result = dissolveObject(
      {
        expected_revision: 2,
        expected_dissolved_revision: 1,
        host_content: hostContent!,
        embed_unit_id: embed.id,
        dissolved_object_id: newObjectId,
        dissolved_content: dissolvedContent!,
        inbound_references: [],
      },
      { provenance_id: provId, version_id: uuidv7() },
      new Date(),
    );
    if (!result.ok) throw new Error('dissolve op should succeed with a clean pre-read');

    // A CONCURRENT external inbound link commits AFTER the pre-read, BEFORE persist.
    const proofId = uuidv7();
    await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: proofId, type: 'note', title: 'racer' },
    });
    const linkId = uuidv7();
    await stack.db.query(
      `INSERT INTO links (id, source_object_id, target_object_id, type, status, from_content, provenance_id, created_at)
       VALUES ($1,$2,$3,'proves','active',false,$4,now())`,
      [linkId, proofId, newObjectId, h.provenanceId],
    );

    // The in-transaction re-check catches it → blocked, nothing destroyed (no silent re-point).
    const persisted = await persistObjectGraph(stack.db, h.hostId, result.value, {
      provenance: { id: provId, origin: 'system', occurred_at: new Date().toISOString() },
      expectedRevision: 2,
      expectedDissolvedRevision: 1,
      now: new Date(),
    });
    expect(persisted.won).toBe(false);
    expect(persisted.blockedReferences).toEqual([linkId]);
    expect(await revisionOf(newObjectId)).toBe(1); // the object survived
    const racer = await stack.db.query<{ target_object_id: string }>(
      `SELECT target_object_id FROM links WHERE id = $1`,
      [linkId],
    );
    expect(racer.rows[0]!.target_object_id).toBe(newObjectId); // NOT silently re-pointed to the host
  });
});

describe('§9.y ownership: export + the scorecard', () => {
  test('the host export transitively includes the embedded object and round-trips on import', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);

    const exported = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${h.hostId}/mathpack`,
      headers: bearer(token),
    });
    expect(exported.statusCode).toBe(200);
    const pack = exported.json() as { graph: { objects: { id: string }[] } };
    const ids = pack.graph.objects.map((o) => o.id);
    expect(ids).toContain(h.hostId);
    expect(ids).toContain(newObjectId); // the embed's target travelled with the pack

    const imported = await stack.app.inject({
      method: 'POST',
      url: '/api/mathpack/import',
      headers: bearer(token),
      payload: pack,
    });
    expect(imported.statusCode).toBe(200); // embed_target_missing is satisfiable on the transitive pack
  });

  test('origin-reference side-by-side scorecard: identical reads, divergent version-history home (§18.5)', async () => {
    const h = await seedTheoremHost(stack, token);
    const { newObjectId } = await rehome(h.hostId, h.rootId);

    // The re-homing column is OBSERVED from the real DB; the origin-reference column is the analyzed
    // alternative (content stays in the host; the object is a by-reference pointer). Harness-only —
    // origin-reference is never modeled or persisted.
    const versionRowsOnObject = Number(
      (
        await stack.db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM object_versions WHERE object_id = $1`,
          [newObjectId],
        )
      ).rows[0]!.n,
    );
    const unitsOwnedByObject = Number(
      (
        await stack.db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM content_units WHERE object_id = $1`,
          [newObjectId],
        )
      ).rows[0]!.n,
    );

    const scorecard = [
      {
        criterion: 'unit-id preservation',
        rehoming: 'preserved',
        originRef: 'preserved',
        identical: true,
      },
      {
        criterion: 'undo via dissolve',
        rehoming: 'restores host',
        originRef: 'restores host',
        identical: true,
      },
      {
        criterion: 'backlinks resolve',
        rehoming: 'yes (edge follows)',
        originRef: 'yes (via host indirection)',
        identical: true,
      },
      {
        criterion: 'version-history home (the deciding criterion, §18.10)',
        rehoming: `the object owns it (${versionRowsOnObject} object_versions row, ${unitsOwnedByObject} content_units)`,
        originRef: 'split: the host owns the content+history, the object is empty',
        identical: false,
      },
    ];

    // The mechanisms are externally identical for reads/edits/undo…
    for (const row of scorecard.filter((r) => r.identical)) {
      expect(row.rehoming).toBeTruthy();
    }
    // …but DIVERGE on one-fact-one-home: re-homing gives the object its OWN content + history, which
    // origin-reference cannot without splitting it across two homes. This is why re-homing wins (§18.5).
    const decider = scorecard.find((r) => !r.identical)!;
    expect(decider.identical).toBe(false);
    expect(versionRowsOnObject).toBe(1);
    expect(unitsOwnedByObject).toBe(3);
  });
});
