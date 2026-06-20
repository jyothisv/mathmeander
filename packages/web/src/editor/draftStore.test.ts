// draftStore behaviour against an injected async backend (no IndexedDB needed in node).
import { describe, expect, it } from 'vitest';
import { clearDraft, getDraft, setDraft, type DraftBackend, type EditorDraft } from './draftStore';

const OBJ = '0197675f-71f4-7000-8000-000000000001';

/** A Map-backed async backend; optionally make a verb throw to simulate quota/unavailable. */
function memBackend(opts: { failOn?: 'get' | 'set' | 'del' } = {}): DraftBackend {
  const m = new Map<string, unknown>();
  const guard = (verb: 'get' | 'set' | 'del') => {
    if (opts.failOn === verb) throw new Error(`backend ${verb} failed`);
  };
  return {
    get: async (k) => {
      guard('get');
      return m.has(k) ? m.get(k) : undefined;
    },
    set: async (k, v) => {
      guard('set');
      m.set(k, v);
    },
    del: async (k) => {
      guard('del');
      m.delete(k);
    },
  };
}

const draft = (over: Partial<EditorDraft> = {}): EditorDraft => ({
  version: 1,
  objectId: OBJ,
  doc: { type: 'doc', content: [] },
  baseRevision: 2,
  savedAt: 1700000000000,
  ...over,
});

describe('draftStore', () => {
  it('round-trips a draft through set/get', async () => {
    const backend = memBackend();
    await setDraft(draft(), backend);
    expect(await getDraft(OBJ, backend)).toEqual(draft());
  });

  it('namespaces by objectId — distinct objects do not collide', async () => {
    const backend = memBackend();
    const other = '0197675f-71f4-7000-8000-000000000002';
    await setDraft(draft({ baseRevision: 2 }), backend);
    await setDraft(draft({ objectId: other, baseRevision: 9 }), backend);
    expect((await getDraft(OBJ, backend))?.baseRevision).toBe(2);
    expect((await getDraft(other, backend))?.baseRevision).toBe(9);
  });

  it('clearDraft removes only that object’s draft', async () => {
    const backend = memBackend();
    await setDraft(draft(), backend);
    await clearDraft(OBJ, backend);
    expect(await getDraft(OBJ, backend)).toBeNull();
  });

  it('returns null for a missing draft', async () => {
    expect(await getDraft(OBJ, memBackend())).toBeNull();
  });

  it('returns null on a version mismatch (and clears the stale entry)', async () => {
    const backend = memBackend();
    await backend.set('mm:journal-draft:' + OBJ, { ...draft(), version: 0 });
    expect(await getDraft(OBJ, backend)).toBeNull();
    // the corrupt entry was best-effort removed
    expect(await backend.get('mm:journal-draft:' + OBJ)).toBeUndefined();
  });

  it('returns null when the stored objectId does not match the key', async () => {
    const backend = memBackend();
    await backend.set('mm:journal-draft:' + OBJ, draft({ objectId: 'someone-else' }));
    expect(await getDraft(OBJ, backend)).toBeNull();
  });

  it('returns null for a non-object / corrupt value', async () => {
    const backend = memBackend();
    await backend.set('mm:journal-draft:' + OBJ, 'not-a-draft');
    expect(await getDraft(OBJ, backend)).toBeNull();
  });

  it('never throws when the backend is unavailable (get/set/del swallow)', async () => {
    await expect(getDraft(OBJ, memBackend({ failOn: 'get' }))).resolves.toBeNull();
    await expect(setDraft(draft(), memBackend({ failOn: 'set' }))).resolves.toBeUndefined();
    await expect(clearDraft(OBJ, memBackend({ failOn: 'del' }))).resolves.toBeUndefined();
  });
});
