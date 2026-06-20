// Branch-complete unit tests for the autosave/merge state machine (autosaveController.ts) — the hardest,
// most concurrency-sensitive code in the editor, previously covered only by e2e. Pure node: ProseMirror is
// replaced by a `FakeDoc` (holds the content the user has "typed"), the network by queue-driven `save` /
// `fetchFresh` mocks, and every side effect by a spy. We drive the private `runMerge` through the public
// `flush` (by making `save` throw 409/422), exactly as the real 409/422 path does.
import { describe, expect, it } from 'vitest';
import type { Inline, MathContent, Unit } from '@mathmeander/schema';
import { ApiError } from '../api/client';
import { contentKeyOf } from './projection';
import type { Delta } from './merge';
import type { SaveState } from './saveStatus';
import { createAutosaveController, type AutosavePorts, type SaveBody } from './autosaveController';

const OBJ = '0197675f-71f4-7000-8000-000000000001';
const PROV = '0197675f-71f4-7000-8000-0000000000d1';

function prose(id: string, position: number, text: string, inline: Inline[] = []): Unit {
  return {
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline },
    provenance_id: PROV,
  };
}
const content = (units: Unit[], revision: number): MathContent => ({
  object_id: OBJ,
  revision,
  units,
});

/** The units-array analog of flushToContent — compares by id + position + canonical content, matching the
 *  real delta the editor produces (so harness assertions mean what the controller would see). */
function diffContent(current: MathContent, baseline: MathContent): Delta {
  const baseById = new Map(baseline.units.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const upserts: Unit[] = [];
  for (const u of current.units) {
    seen.add(u.id);
    const prev = baseById.get(u.id);
    if (
      !prev ||
      u.position !== prev.position ||
      contentKeyOf(u.content) !== contentKeyOf(prev.content)
    )
      upserts.push(u);
  }
  const deletes = baseline.units.filter((u) => !seen.has(u.id)).map((u) => u.id);
  return { upserts, deletes };
}

/** Stands in for the live ProseMirror doc: holds the content the user has typed; records reprojections. */
class FakeDoc {
  current: MathContent;
  reprojections: MathContent[] = [];
  constructor(init: MathContent) {
    this.current = init;
  }
  delta(baseline: MathContent): Delta {
    return diffContent(this.current, baseline);
  }
  signature(): string {
    return JSON.stringify(this.current.units);
  }
  reproject(c: MathContent): void {
    this.current = c;
    this.reprojections.push(c);
  }
  /** Simulate the user typing (replace the unit set). */
  type(units: Unit[]): void {
    this.current = { ...this.current, units };
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const apiErr = (status: number) => new ApiError(status, 'X', `status ${status}`);

interface Harness {
  ctl: ReturnType<typeof createAutosaveController>;
  doc: FakeDoc;
  prior: { current: MathContent };
  getState: () => SaveState;
  calls: {
    saves: SaveBody[];
    persistDraft: number;
    clearDraft: number;
    cancelFlush: number;
    seeds: MathContent[];
  };
  queueSave: (fn: () => Promise<MathContent>) => void;
  setFetch: (fn: () => Promise<MathContent | null>) => void;
  setOnline: (b: boolean) => void;
  setReady: (b: boolean) => void;
}

function makeHarness(opts: {
  baseline: MathContent;
  doc?: MathContent; // what the user has typed (defaults to baseline = clean)
  maxMergeRetries?: number;
}): Harness {
  const prior = { current: opts.baseline };
  const doc = new FakeDoc(opts.doc ?? opts.baseline);
  let state: SaveState = {
    conflict: false,
    error: false,
    offline: false,
    saving: false,
    dirty: false,
  };
  const calls = {
    saves: [] as SaveBody[],
    persistDraft: 0,
    clearDraft: 0,
    cancelFlush: 0,
    seeds: [] as MathContent[],
  };
  const saveQueue: Array<() => Promise<MathContent>> = [];
  let fetchImpl: () => Promise<MathContent | null> = async () => null;
  let online = true;
  let ready = true;

  const ports: AutosavePorts = {
    objectId: OBJ,
    prior,
    save: (body) => {
      calls.saves.push(body);
      const next = saveQueue.shift();
      if (!next) throw new Error('test: no save response queued');
      return next();
    },
    fetchFresh: () => fetchImpl(),
    delta: (baseline) => doc.delta(baseline),
    signature: () => doc.signature(),
    reproject: (c) => doc.reproject(c),
    persistDraft: () => {
      calls.persistDraft += 1;
    },
    clearDraft: () => {
      calls.clearDraft += 1;
    },
    seedCache: (c) => {
      calls.seeds.push(c);
    },
    setStatus: (fn) => {
      state = fn(state);
    },
    cancelScheduledFlush: () => {
      calls.cancelFlush += 1;
    },
    isOnline: () => online,
    ready: () => ready,
    ...(opts.maxMergeRetries != null ? { maxMergeRetries: opts.maxMergeRetries } : {}),
  };

  return {
    ctl: createAutosaveController(ports),
    doc,
    prior,
    getState: () => state,
    calls,
    queueSave: (fn) => saveQueue.push(fn),
    setFetch: (fn) => {
      fetchImpl = fn;
    },
    setOnline: (b) => {
      online = b;
    },
    setReady: (b) => {
      ready = b;
    },
  };
}

const ok = (c: MathContent) => () => Promise.resolve(c);

describe('flush — happy path & no-op', () => {
  it('clean doc (no delta) clears the latch + draft and settles to not-dirty, never saving', async () => {
    const h = makeHarness({ baseline: content([prose('p0', 0, 'P0')], 1) }); // doc === baseline
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0);
    expect(h.calls.clearDraft).toBe(1);
    expect(h.getState()).toMatchObject({ dirty: false, error: false, saving: false });
  });

  it('saves the delta, advances the baseline, clears the draft when not still dirty', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.queueSave(ok(content([prose('p0', 0, 'P0x')], 2)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1);
    expect(h.calls.saves[0]).toMatchObject({ expected_revision: 1 });
    expect(h.prior.current.revision).toBe(2);
    expect(h.calls.clearDraft).toBe(1);
    expect(h.getState()).toMatchObject({ saving: false, dirty: false, error: false });
  });

  it('keeps the draft + stays dirty when the user typed during the PUT', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    const save = deferred<MathContent>();
    h.queueSave(() => save.promise);
    const p = h.ctl.flush();
    await tick(); // parked awaiting the PUT
    h.doc.type([prose('p0', 0, 'P0x'), prose('pa', 1, 'typed-during')]); // user types
    save.resolve(content([prose('p0', 0, 'P0x')], 2));
    await p;
    expect(h.calls.persistDraft).toBeGreaterThanOrEqual(1);
    expect(h.getState()).toMatchObject({ saving: false, dirty: true, error: false });
  });
});

describe('flush — guards', () => {
  it('no-ops while in conflict (never saves)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.ctl.noteRestored({ conflict: true });
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0);
  });

  it('no-ops while busy — a second overlapping flush is dropped (single save)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    const save = deferred<MathContent>();
    h.queueSave(() => save.promise);
    const p1 = h.ctl.flush(); // sets busy, parks on the PUT
    const p2 = h.ctl.flush(); // busy → immediate no-op
    save.resolve(content([prose('p0', 0, 'P0x')], 2));
    await Promise.all([p1, p2]);
    expect(h.calls.saves).toHaveLength(1);
  });
});

describe('flush — transient errors', () => {
  it('online network failure surfaces an error and persists the draft', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.setOnline(true);
    h.queueSave(() => Promise.reject(new Error('network down')));
    await h.ctl.flush();
    expect(h.calls.persistDraft).toBe(1);
    expect(h.getState()).toMatchObject({ saving: false, error: true });
  });

  it('offline network failure stays calm (no error) and persists the draft', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.setOnline(false);
    h.queueSave(() => Promise.reject(new Error('offline')));
    await h.ctl.flush();
    expect(h.getState()).toMatchObject({ saving: false, error: false });
  });

  it('a 5xx is transient (does NOT route to merge — no fetch)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    let fetched = false;
    h.setFetch(async () => {
      fetched = true;
      return null;
    });
    h.queueSave(() => Promise.reject(apiErr(500)));
    await h.ctl.flush();
    expect(fetched).toBe(false);
    expect(h.getState()).toMatchObject({ error: true });
  });
});

describe('runMerge (via a 409/422 flush) — fetch outcomes', () => {
  it('a 409 routes to merge and GETs fresh content', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1),
    });
    let fetched = false;
    h.setFetch(async () => {
      fetched = true;
      return content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2);
    });
    h.queueSave(() => Promise.reject(apiErr(409))); // first PUT
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('z', 1, 'Z'), prose('pa', 2, 'Pa')], 3))); // merge PUT
    await h.ctl.flush();
    expect(fetched).toBe(true);
  });

  it('a stale-write 422 ALSO routes to merge (decided by revision)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1),
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2));
    h.queueSave(() => Promise.reject(apiErr(422)));
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('z', 1, 'Z'), prose('pa', 2, 'Pa')], 3)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(2); // merged & re-persisted
    expect(h.prior.current.revision).toBe(3);
  });

  it('the GET failing is transient — persists the draft, surfaces error, no conflict', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.setFetch(() => Promise.reject(new Error('GET failed')));
    h.queueSave(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.getState()).toMatchObject({ error: true, conflict: false });
    expect(h.calls.persistDraft).toBeGreaterThanOrEqual(1);
  });

  it('the object being gone (fetch → null) enters conflict', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.setFetch(async () => null);
    h.queueSave(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.getState().conflict).toBe(true);
    expect(h.calls.cancelFlush).toBe(1);
    expect(h.calls.persistDraft).toBeGreaterThanOrEqual(1);
  });
});

describe('runMerge — the genuine-reject latch', () => {
  it('a non-advanced server (revision unchanged) is a genuine reject → latch + error, no merge save', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 2),
      doc: content([prose('p0', 0, 'P0-bad')], 2),
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0')], 2)); // NOT advanced (<= baseline)
    h.queueSave(() => Promise.reject(apiErr(422)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1); // only the rejected PUT; no merge save
    expect(h.getState().error).toBe(true);

    // latch HIT: re-flushing the unchanged doc does NOT re-send
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1);

    // latch MISS via flush: the doc signature changed → the latch lifts and we try again
    h.doc.type([prose('p0', 0, 'P0-better')]);
    h.queueSave(ok(content([prose('p0', 0, 'P0-better')], 3)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(2);
  });

  it('"Keep mine" (force) bypasses the latch even when the server has NOT advanced', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 2),
      doc: content([prose('p0', 0, 'P0-mine')], 2),
    });
    h.ctl.noteRestored({ conflict: true });
    h.setFetch(async () => content([prose('p0', 0, 'P0-server')], 2)); // not advanced
    h.queueSave(ok(content([prose('p0', 0, 'P0-mine')], 3))); // the forced merge persists mine
    await h.ctl.resolveKeepMine();
    expect(h.calls.saves).toHaveLength(1); // forced merge saved (latch skipped)
    expect(h.getState().conflict).toBe(false);
  });
});

describe('runMerge — plan outcomes', () => {
  it('a same-unit clash (planMerge conflict) enters conflict', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1),
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0-server')], 2)); // both edited p0
    h.queueSave(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.getState().conflict).toBe(true);
    expect(h.calls.saves).toHaveLength(1); // no merge save attempted
  });

  it('an empty rebased delta (my reorder is dropped) short-circuits to in-sync, no merge save', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1')], 1),
      doc: content([prose('p1', 0, 'P1'), prose('p0', 1, 'P0')], 1), // pure reorder
    });
    h.setFetch(async () =>
      content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1'), prose('z', 2, 'Z')], 2),
    );
    h.queueSave(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1); // reorder dropped → nothing to persist
    expect(h.prior.current.units.map((u) => u.id)).toEqual(['p0', 'p1', 'z']); // server order, z kept
    expect(h.getState()).toMatchObject({ dirty: false, conflict: false });
    expect(h.calls.clearDraft).toBeGreaterThanOrEqual(1);
  });

  it('a disjoint merge reprojects both sides and persists my rebased delta', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1), // I added pa
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2)); // server added z
    h.queueSave(() => Promise.reject(apiErr(409)));
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('z', 1, 'Z'), prose('pa', 2, 'Pa')], 3)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(2);
    expect(h.calls.saves[1]!.upserts.map((u) => u.id)).toContain('pa'); // my rebased delta
    expect(h.doc.reprojections.at(-1)!.units.map((u) => u.id)).toEqual(['p0', 'z', 'pa']); // both sides
    expect(h.prior.current.revision).toBe(3);
    expect(h.getState()).toMatchObject({
      saving: false,
      dirty: false,
      conflict: false,
      error: false,
    });
  });

  it('the merge PUT failing transiently surfaces error (no retry storm)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1),
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2));
    h.queueSave(() => Promise.reject(apiErr(409))); // first PUT
    h.queueSave(() => Promise.reject(new Error('network'))); // merge PUT, transient
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(2); // not retried
    expect(h.getState().error).toBe(true);
  });
});

describe('runMerge — bounded re-409 retry', () => {
  it('retries under the cap, then succeeds (force NOT set on a plain flush)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1),
    });
    let rev = 2;
    h.setFetch(async () => content([prose('p0', 0, 'P0')], rev++)); // advances each GET
    h.queueSave(() => Promise.reject(apiErr(409))); // flush PUT
    h.queueSave(() => Promise.reject(apiErr(409))); // merge attempt 1
    h.queueSave(() => Promise.reject(apiErr(409))); // merge attempt 2
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 9))); // merge attempt 3 OK
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(4);
    expect(h.getState()).toMatchObject({ conflict: false, error: false, dirty: false });
  });

  it('exhausting the cap enters conflict', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1),
      maxMergeRetries: 1,
    });
    let rev = 2;
    h.setFetch(async () => content([prose('p0', 0, 'P0')], rev++));
    h.queueSave(() => Promise.reject(apiErr(409))); // flush PUT
    h.queueSave(() => Promise.reject(apiErr(409))); // merge attempt 1 (retries=0<1 → retry)
    h.queueSave(() => Promise.reject(apiErr(409))); // merge attempt 2 (retries=1>=1 → conflict)
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(3);
    expect(h.getState().conflict).toBe(true);
  });
});

describe('resolveTakeTheirs — "Load the latest"', () => {
  it('replaces the doc with the server version, clears the draft and the conflict', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1),
    });
    h.ctl.noteRestored({ conflict: true });
    h.setFetch(async () => content([prose('p0', 0, 'P0-server')], 5));
    await h.ctl.resolveTakeTheirs();
    expect(h.doc.reprojections.at(-1)!.revision).toBe(5);
    expect(h.prior.current.revision).toBe(5);
    expect(h.calls.clearDraft).toBeGreaterThanOrEqual(1);
    expect(h.getState()).toMatchObject({
      conflict: false,
      dirty: false,
      error: false,
      saving: false,
    });
  });

  it('a missing object surfaces error and KEEPS the conflict (no silent clear)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1),
    });
    // Enter conflict the real way (a same-unit clash) so the status is genuinely in conflict…
    h.setFetch(async () => content([prose('p0', 0, 'P0-server')], 2));
    h.queueSave(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.getState().conflict).toBe(true);
    // …then the object disappears: "Load the latest" finds nothing → error, conflict NOT cleared.
    h.setFetch(async () => null);
    await h.ctl.resolveTakeTheirs();
    expect(h.getState()).toMatchObject({ error: true, conflict: true });
  });

  it('a failed GET surfaces error (isOnline)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1),
    });
    h.ctl.noteRestored({ conflict: true });
    h.setOnline(true);
    h.setFetch(() => Promise.reject(new Error('GET failed')));
    await h.ctl.resolveTakeTheirs();
    expect(h.getState().error).toBe(true);
  });

  it('is busy-guarded — a second concurrent call is dropped (single GET)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1),
    });
    h.ctl.noteRestored({ conflict: true });
    const gate = deferred<MathContent>();
    let fetches = 0;
    h.setFetch(() => {
      fetches += 1;
      return gate.promise;
    });
    const p1 = h.ctl.resolveTakeTheirs(); // sets busy, parks on the GET
    const p2 = h.ctl.resolveTakeTheirs(); // busy → no-op
    gate.resolve(content([prose('p0', 0, 'P0-server')], 5));
    await Promise.all([p1, p2]);
    expect(fetches).toBe(1);
  });
});

describe('resolveKeepMine — "Keep mine" (forced merge)', () => {
  it('mine wins the clash while the other side’s separate addition survives', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1), // I edited p0
    });
    h.ctl.noteRestored({ conflict: true });
    h.setFetch(async () => content([prose('p0', 0, 'P0-server'), prose('z', 1, 'Z')], 2)); // server edited p0 + added z
    h.queueSave(ok(content([prose('p0', 0, 'P0-mine'), prose('z', 1, 'Z')], 3)));
    await h.ctl.resolveKeepMine();
    expect(h.calls.saves).toHaveLength(1);
    const merged = h.doc.reprojections.at(-1)!;
    expect(merged.units.find((u) => u.id === 'p0')!.content).toMatchObject({ text: 'P0-mine' }); // mine wins
    expect(merged.units.map((u) => u.id)).toContain('z'); // foreign addition preserved
    expect(h.getState().conflict).toBe(false);
  });

  it('is busy-guarded', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0-mine')], 1),
    });
    h.ctl.noteRestored({ conflict: true });
    const gate = deferred<MathContent>();
    let fetches = 0;
    h.setFetch(() => {
      fetches += 1;
      return gate.promise;
    });
    const p1 = h.ctl.resolveKeepMine();
    const p2 = h.ctl.resolveKeepMine();
    gate.resolve(content([prose('p0', 0, 'P0-server')], 2));
    h.queueSave(ok(content([prose('p0', 0, 'P0-mine')], 3)));
    await Promise.all([p1, p2]);
    expect(fetches).toBe(1);
  });
});

describe('noteEdit / canFlushOnReconnect / dispose', () => {
  it('noteEdit marks dirty and returns true when not in conflict', () => {
    const h = makeHarness({ baseline: content([prose('p0', 0, 'P0')], 1) });
    expect(h.ctl.noteEdit()).toBe(true);
    expect(h.getState().dirty).toBe(true);
  });

  it('noteEdit returns false in conflict (drafts locally, pauses network sync)', () => {
    const h = makeHarness({ baseline: content([prose('p0', 0, 'P0')], 1) });
    h.ctl.noteRestored({ conflict: true });
    expect(h.ctl.noteEdit()).toBe(false);
  });

  it('noteEdit clears the latch so the next flush re-sends', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 2),
      doc: content([prose('p0', 0, 'P0-bad')], 2),
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0')], 2)); // not advanced → latch
    h.queueSave(() => Promise.reject(apiErr(422)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1);
    await h.ctl.flush(); // latch hit
    expect(h.calls.saves).toHaveLength(1);

    h.ctl.noteEdit(); // clears the latch (even with the same signature)
    h.queueSave(ok(content([prose('p0', 0, 'P0-bad')], 3)));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(2);
  });

  it('canFlushOnReconnect: false when clean, true once dirty, false in conflict', () => {
    const h = makeHarness({ baseline: content([prose('p0', 0, 'P0')], 1) });
    expect(h.ctl.canFlushOnReconnect()).toBe(false); // not dirty
    h.ctl.noteEdit();
    expect(h.ctl.canFlushOnReconnect()).toBe(true); // dirty, not conflict, not busy
    h.ctl.noteRestored({ conflict: true });
    expect(h.ctl.canFlushOnReconnect()).toBe(false); // conflict gates it
  });

  it('canFlushOnReconnect is false while busy (an op is in flight)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x')], 1),
    });
    h.ctl.noteEdit(); // dirty
    const save = deferred<MathContent>();
    h.queueSave(() => save.promise);
    const p = h.ctl.flush(); // busy
    await tick();
    expect(h.ctl.canFlushOnReconnect()).toBe(false); // busy gates it
    save.resolve(content([prose('p0', 0, 'P0x')], 2));
    await p;
  });

  it('dispose stops a mid-flight merge from writing after teardown', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 1),
    });
    const gate = deferred<MathContent>();
    h.setFetch(() => gate.promise);
    h.queueSave(() => Promise.reject(apiErr(409))); // flush PUT fails → runMerge awaits the GET
    const p = h.ctl.flush();
    await tick(); // parked on the GET
    h.ctl.dispose();
    gate.resolve(content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2));
    await p;
    expect(h.calls.saves).toHaveLength(1); // no merge save after disposal
    expect(h.doc.reprojections).toHaveLength(0); // nothing reprojected
  });
});
