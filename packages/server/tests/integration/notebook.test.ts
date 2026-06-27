// Stage 2 Pass B — the §6.5 / §B `notebook` surface, driven through the REAL HTTP chokepoint against
// Postgres. Mirrors the journal surface: idempotent + RACE-SAFE get-or-create on the title-derived slug
// (no orphan), slug normalization, the empty-slug (punctuation-only title) 422, alphabetical listing,
// cross-space isolation, and auth gating.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  token = await stack.login('notebooker@example.com');
});

function postNotebook(title: string, authToken = token) {
  return stack.app.inject({
    method: 'POST',
    url: '/api/notebooks',
    headers: bearer(authToken),
    payload: { title },
  });
}

async function notebookCount(): Promise<number> {
  const r = await stack.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM notebook_detail`);
  return Number(r.rows[0]!.n);
}

describe('notebook: get-or-create', () => {
  it('creates a draft notebook with a title-derived slug + a detail row (201)', async () => {
    const res = await postNotebook('Linear Algebra');
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      object: { id: string; type: string; status: string; title: string };
      slug: string;
    };
    expect(body.object.type).toBe('notebook');
    expect(body.object.status).toBe('draft');
    expect(body.object.title).toBe('Linear Algebra'); // the human title rides on the object
    expect(body.slug).toBe('linear-algebra'); // normalized in the core
    expect(await notebookCount()).toBe(1);
  });

  it('pre-creates the notation home: ONE empty `config`/notation unit at position 0', async () => {
    const res = await postNotebook('Real Analysis');
    expect(res.statusCode).toBe(201);
    const objectId = (res.json() as { object: { id: string } }).object.id;
    const units = await stack.db.query<{
      position: number;
      content_kind: string;
      parent_unit_id: string | null;
      content: { kind: string; family: string; source: string };
    }>(
      `SELECT position, content_kind, parent_unit_id, content
       FROM content_units WHERE object_id = $1 ORDER BY position`,
      [objectId],
    );
    expect(units.rows).toHaveLength(1);
    const home = units.rows[0]!;
    expect(home.content_kind).toBe('config'); // the GENERATED column reflects the new arm
    expect(home.position).toBe(0);
    expect(home.parent_unit_id).toBeNull();
    expect(home.content).toMatchObject({ kind: 'config', family: 'notation', source: '' });
  });

  it('the idempotent get-existing path does NOT add a second notation home', async () => {
    const first = await postNotebook('Measure Theory');
    expect(first.statusCode).toBe(201);
    const second = await postNotebook('measure theory'); // same slug → 200, no new rows
    expect(second.statusCode).toBe(200);
    const objectId = (first.json() as { object: { id: string } }).object.id;
    const n = await stack.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_units WHERE object_id = $1`,
      [objectId],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('is idempotent: a title that normalizes to the same slug returns the SAME object (200)', async () => {
    const first = await postNotebook('Linear Algebra');
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { object: { id: string } }).object.id;

    const second = await postNotebook('  linear   algebra!! '); // → same slug `linear-algebra`
    expect(second.statusCode).toBe(200);
    expect((second.json() as { object: { id: string } }).object.id).toBe(firstId);
    expect(await notebookCount()).toBe(1);
  });

  it('is race-safe: concurrent creates of one slug yield exactly one notebook, no orphan', async () => {
    const [a, b] = await Promise.all([postNotebook('Topology'), postNotebook('Topology')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    const ids = [a, b].map((r) => (r.json() as { object: { id: string } }).object.id);
    expect(ids[0]).toBe(ids[1]);
    expect(await notebookCount()).toBe(1);
    const objs = await stack.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM objects WHERE type = 'notebook'`,
    );
    expect(Number(objs.rows[0]!.n)).toBe(1); // the loser's orphan object rolled back
  });

  it('a title that normalizes to an empty slug is a client error (422)', async () => {
    const res = await postNotebook('!!!'); // punctuation only → empty slug
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('content_save_invalid');
    expect(await notebookCount()).toBe(0);
  });
});

describe('notebook: list + read', () => {
  it('lists every notebook in the space, by slug', async () => {
    await postNotebook('Topology');
    await postNotebook('Algebra');
    await postNotebook('Calculus');
    const list = await stack.app.inject({
      method: 'GET',
      url: '/api/notebooks',
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { slug: string }[] }).items;
    expect(items.map((i) => i.slug)).toEqual(['algebra', 'calculus', 'topology']);
  });

  it('GET a missing slug is 404; a malformed slug is 400 at the edge', async () => {
    const missing = await stack.app.inject({
      method: 'GET',
      url: '/api/notebooks/nope',
      headers: bearer(token),
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await stack.app.inject({
      method: 'GET',
      url: '/api/notebooks/Not_A_Slug',
      headers: bearer(token),
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('notebook: authorization', () => {
  it('a notebook in space A is invisible to space B (404 + empty list)', async () => {
    await postNotebook('Private');
    const tokenB = await stack.login('other-notebooker@example.com');
    const read = await stack.app.inject({
      method: 'GET',
      url: '/api/notebooks/private',
      headers: bearer(tokenB),
    });
    expect(read.statusCode).toBe(404);
    const listB = await stack.app.inject({
      method: 'GET',
      url: '/api/notebooks',
      headers: bearer(tokenB),
    });
    expect((listB.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('unauthenticated requests are 401', async () => {
    const post = await stack.app.inject({
      method: 'POST',
      url: '/api/notebooks',
      payload: { title: 'X' },
    });
    expect(post.statusCode).toBe(401);
    const get = await stack.app.inject({ method: 'GET', url: '/api/notebooks' });
    expect(get.statusCode).toBe(401);
  });
});
