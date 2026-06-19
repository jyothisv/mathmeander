// Slice 2b Pass B — the §6.5 journal surface, driven through the REAL HTTP chokepoint against
// Postgres. Proves: idempotent + RACE-SAFE get-or-create (no orphan), the three-tier date validation
// (shape 400 / impossible 422 / glue 500), date-ordered listing, eager embed-inline resolution
// (re-home INTO a journal_day host), cross-space isolation, and auth gating.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MathpackGraph, OpOutcome } from '@mathmeander/schema';
import {
  bearer,
  createStack,
  seedTheoremSubtreeInto,
  truncateAll,
  type TestStack,
} from './helpers.js';

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
  token = await stack.login('journalist@example.com');
});

function postDay(date: string, authToken = token) {
  return stack.app.inject({
    method: 'POST',
    url: '/api/journal/days',
    headers: bearer(authToken),
    payload: { date },
  });
}

async function journalDayCount(): Promise<number> {
  const r = await stack.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_day_detail`,
  );
  return Number(r.rows[0]!.n);
}

describe('journal day: get-or-create', () => {
  it('creates a draft journal_day with its date + a detail row (201)', async () => {
    const res = await postDay('2026-06-19');
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      object: { id: string; type: string; status: string; revision: number };
      date: string;
    };
    expect(body.object.type).toBe('journal_day');
    expect(body.object.status).toBe('draft');
    expect(body.object.revision).toBe(1);
    expect(body.date).toBe('2026-06-19');
    expect(await journalDayCount()).toBe(1);
  });

  it('is idempotent: the same date returns the SAME object with 200, no second row', async () => {
    const first = await postDay('2026-06-19');
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { object: { id: string } }).object.id;

    const second = await postDay('2026-06-19');
    expect(second.statusCode).toBe(200); // existing, not created
    expect((second.json() as { object: { id: string } }).object.id).toBe(firstId);
    expect(await journalDayCount()).toBe(1);
  });

  it('is race-safe: concurrent creates yield exactly one day, no orphan object', async () => {
    const [a, b] = await Promise.all([postDay('2026-06-20'), postDay('2026-06-20')]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 201]); // exactly one winner
    const ids = [a, b].map((r) => (r.json() as { object: { id: string } }).object.id);
    expect(ids[0]).toBe(ids[1]); // both resolve to the same day

    expect(await journalDayCount()).toBe(1); // exactly one detail row
    const objs = await stack.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM objects WHERE type = 'journal_day'`,
    );
    expect(Number(objs.rows[0]!.n)).toBe(1); // the loser's orphan object rolled back
  });

  it('an impossible-but-well-formed date is a client error (422), not a 500', async () => {
    const res = await postDay('2026-02-30'); // passes the shape regex; the core rejects it
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('malformed_input');
    expect(await journalDayCount()).toBe(0);
  });

  it('a malformed-shape date is rejected at the edge (400)', async () => {
    const res = await postDay('nope');
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });
});

describe('journal: list + read', () => {
  it('lists every day in the space, newest date first', async () => {
    await postDay('2026-06-17');
    await postDay('2026-06-19');
    await postDay('2026-06-18');

    const list = await stack.app.inject({
      method: 'GET',
      url: '/api/journal',
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { date: string }[] }).items;
    expect(items.map((i) => i.date)).toEqual(['2026-06-19', '2026-06-18', '2026-06-17']);
  });

  it('GET a missing date is 404', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/api/journal/days/2026-01-01',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET a malformed-shape date is a 400 at the edge (never a SQL-cast 500)', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/api/journal/days/garbage',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('GET an impossible-but-well-formed date is a 400, not a SQL-cast 500', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/api/journal/days/2026-02-30',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('GET :date resolves an embedded object inline (re-home INTO a journal_day host)', async () => {
    // A journal_day IS a valid re-home host (the core treats it as raw MathContent). Seed a theorem
    // subtree into the day, re-home it into a new object → the day keeps one Embed{Object}; the eager
    // read must carry the embedded object's content too (the §9.y boundary-invisible contract).
    const date = '2026-06-21';
    const created = await postDay(date);
    const dayId = (created.json() as { object: { id: string } }).object.id;
    const sub = await seedTheoremSubtreeInto(stack, dayId);

    const rehome = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${dayId}/ops/rehome`,
      headers: bearer(token),
      payload: { expected_revision: 1, subtree_root: sub.rootId, type: 'theorem' },
    });
    expect(rehome.statusCode).toBe(200);
    const newObjectId = (rehome.json() as { outcome: OpOutcome }).outcome.new_objects[0]!.id;

    const read = await stack.app.inject({
      method: 'GET',
      url: `/api/journal/days/${date}`,
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as { object: { id: string }; date: string; graph: MathpackGraph };
    expect(body.date).toBe(date);
    // The transitive subgraph carries BOTH the day and the re-homed object's content.
    const contentIds = body.graph.content.map((c) => c.object_id);
    expect(contentIds).toContain(dayId);
    expect(contentIds).toContain(newObjectId);
    // The day now holds an Embed pointing at the re-homed object.
    const dayContent = body.graph.content.find((c) => c.object_id === dayId)!;
    const embed = dayContent.units.find(
      (u) => u.content.kind === 'embed' && u.content.target.object_id === newObjectId,
    );
    expect(embed).toBeDefined();
  });
});

describe('journal: authorization', () => {
  it('a day in space A is invisible to space B (404)', async () => {
    await postDay('2026-06-19'); // user A
    const tokenB = await stack.login('other-journalist@example.com');
    const read = await stack.app.inject({
      method: 'GET',
      url: '/api/journal/days/2026-06-19',
      headers: bearer(tokenB),
    });
    expect(read.statusCode).toBe(404);
    const listB = await stack.app.inject({
      method: 'GET',
      url: '/api/journal',
      headers: bearer(tokenB),
    });
    expect((listB.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('unauthenticated requests are 401', async () => {
    const post = await stack.app.inject({
      method: 'POST',
      url: '/api/journal/days',
      payload: { date: '2026-06-19' },
    });
    expect(post.statusCode).toBe(401);
    const get = await stack.app.inject({ method: 'GET', url: '/api/journal' });
    expect(get.statusCode).toBe(401);
  });
});
