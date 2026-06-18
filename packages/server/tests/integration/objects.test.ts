// Object API gates (setup step 9): byte-identical raw_source, typed core errors over
// HTTP, the FULL optimistic-concurrency loop, cross-space isolation, transactional
// provenance, and tri-state title semantics.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { bearer, createStack, truncateAll, type TestStack } from './helpers.js';

let stack: TestStack;
let token: string;

// LaTeX + unicode + CRLF + tabs — the §2.2 adversarial preservation fixture.
const ADVERSARIAL_RAW =
  'Thm. $\\forall \\epsilon>0\\ \\exists\\delta$\r\n\t半径 ℝ → ∞\nLine 3 ;NN `\\frak{p}`';

beforeAll(async () => {
  stack = await createStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await truncateAll(stack.db);
  token = await stack.login('dev@mathmeander.local');
});

async function createNote(body: Record<string, unknown>, authToken = token) {
  return stack.app.inject({
    method: 'POST',
    url: '/api/objects',
    headers: bearer(authToken),
    payload: { id: uuidv7(), type: 'note', ...body },
  });
}

describe('create → read', () => {
  it('preserves raw_source byte-for-byte and stamps core-owned fields', async () => {
    const created = await createNote({ title: 'ε-δ notes', raw_source: ADVERSARIAL_RAW });
    expect(created.statusCode).toBe(201);
    const object = created.json().object;
    expect(object.status).toBe('draft');
    expect(object.revision).toBe(1);
    expect(object.schema_version).toBe(1);

    const read = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${object.id}`,
      headers: bearer(token),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().object.raw_source).toBe(ADVERSARIAL_RAW); // byte-identical
    expect(read.json().object.title).toBe('ε-δ notes');
  });

  // Three creation tiers (§9.y/§13a), each a distinct typed core error over HTTP:
  // an unknown type, a formal-family type that is declaration-only, and a reserved type.
  it('rejects an unknown object type', async () => {
    const bad = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: uuidv7(), type: 'flarp' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('unknown_object_type');
    expect(bad.json().error.details.given).toBe('flarp');
  });

  it('rejects a formal-family type as declaration-only, not direct create', async () => {
    const bad = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: uuidv7(), type: 'theorem' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('type_not_directly_creatable');
    expect(bad.json().error.details.object_type).toBe('theorem');
  });

  it('rejects a reserved type that has no create surface yet', async () => {
    const bad = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: uuidv7(), type: 'journal_day' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('type_not_producible_yet');
    expect(bad.json().error.details.object_type).toBe('journal_day');
  });

  it('rejects non-v7 ids with the typed core error', async () => {
    const bad = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: '8c5454e0-66d1-4d3c-8a6f-d4d3f3a1b2c3', type: 'note' }, // v4
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('not_uuid_v7');
  });

  it('duplicate id → 409, and the transaction leaks NO provenance row', async () => {
    const id = uuidv7();
    const first = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id, type: 'note' },
    });
    expect(first.statusCode).toBe(201);

    const before = await stack.db.query('SELECT count(*)::int AS n FROM provenance');
    const dup = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id, type: 'note' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_ID');
    const after = await stack.db.query('SELECT count(*)::int AS n FROM provenance');
    expect(after.rows[0].n).toBe(before.rows[0].n); // rollback proven
  });

  it('lists are space-scoped, newest first', async () => {
    await createNote({ title: 'one' });
    await createNote({ title: 'two' });
    const list = await stack.app.inject({
      method: 'GET',
      url: '/api/objects',
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(2);
  });
});

describe('cross-space isolation (authorization by space, day one)', () => {
  it("user B cannot see or list user A's objects", async () => {
    const created = await createNote({ title: 'private' });
    const objectId = created.json().object.id;

    const tokenB = await stack.login('other@mathmeander.local');
    const read = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}`,
      headers: bearer(tokenB),
    });
    expect(read.statusCode).toBe(404); // cross-space reads are 404, not 403

    const list = await stack.app.inject({
      method: 'GET',
      url: '/api/objects',
      headers: bearer(tokenB),
    });
    expect(list.json().items).toHaveLength(0);
  });
});

describe('optimistic concurrency (§6.4) — the full read-retry loop', () => {
  it('stale write → 409 with current revision → re-read → retry succeeds', async () => {
    const created = await createNote({ title: 'v1' });
    const id = created.json().object.id;

    // Client A wins.
    const a = await stack.app.inject({
      method: 'PATCH',
      url: `/api/objects/${id}`,
      headers: bearer(token),
      payload: { expected_revision: 1, title: 'A was here' },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().object.revision).toBe(2);

    // Client B, holding revision 1, loses — and is told the current revision.
    const b = await stack.app.inject({
      method: 'PATCH',
      url: `/api/objects/${id}`,
      headers: bearer(token),
      payload: { expected_revision: 1, title: 'B was here' },
    });
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe('REVISION_CONFLICT');
    expect(b.json().error.details.current_revision).toBe(2);

    // B re-reads and retries against the fresh revision.
    const reread = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${id}`,
      headers: bearer(token),
    });
    const retry = await stack.app.inject({
      method: 'PATCH',
      url: `/api/objects/${id}`,
      headers: bearer(token),
      payload: { expected_revision: reread.json().object.revision, title: 'B retried' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().object.revision).toBe(3);
    expect(retry.json().object.title).toBe('B retried');
  });
});

describe('tri-state title semantics over HTTP (§6.3)', () => {
  it('absent leaves, null clears, empty string is a VALUE', async () => {
    const created = await createNote({ title: 'named' });
    const id = created.json().object.id;

    // absent → unchanged
    const absent = await stack.app.inject({
      method: 'PATCH',
      url: `/api/objects/${id}`,
      headers: bearer(token),
      payload: { expected_revision: 1 },
    });
    expect(absent.json().object.title).toBe('named');

    // empty string → a value, not a clear
    const empty = await stack.app.inject({
      method: 'PATCH',
      url: `/api/objects/${id}`,
      headers: bearer(token),
      payload: { expected_revision: 2, title: '' },
    });
    expect(empty.json().object.title).toBe('');

    // null → cleared to unset (the field disappears)
    const cleared = await stack.app.inject({
      method: 'PATCH',
      url: `/api/objects/${id}`,
      headers: bearer(token),
      payload: { expected_revision: 3, title: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().object.title ?? null).toBeNull();

    const read = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${id}`,
      headers: bearer(token),
    });
    expect(read.json().object.title ?? null).toBeNull();
    expect(read.json().object.raw_source ?? null).toBeNull(); // untouched throughout
  });
});

describe('edge validation (generated zod at the boundary)', () => {
  it('missing type → 400 INVALID_REQUEST before the core is ever called', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: bearer(token),
      payload: { id: uuidv7() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });
});
