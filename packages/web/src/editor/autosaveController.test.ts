// Branch-complete unit tests for the autosave/merge state machine (autosaveController.ts) — the hardest,
// most concurrency-sensitive code in the editor, previously covered only by e2e. Pure node: ProseMirror is
// replaced by a `FakeDoc` (holds the content the user has "typed"), the network by queue-driven `save` /
// `fetchFresh` mocks, and every side effect by a spy. We drive the private `runMerge` through the public
// `flush` (by making `save` throw 409/422), exactly as the real 409/422 path does.
import { describe, expect, it } from 'vitest';
import type { Inline, MathContent, Unit, UnitType } from '@mathmeander/schema';
import { ApiError } from '../api/client';
import { contentKeyOf, type StructuralIntent, type StructuralNeed, type TypeNeed } from './projection';
import type { Delta } from './merge';
import type { SaveState } from './saveStatus';
import { createAutosaveController, type AutosavePorts, type SaveBody } from './autosaveController';

const OBJ = '0197675f-71f4-7000-8000-000000000001';
const PROV = '0197675f-71f4-7000-8000-0000000000d1';

function prose(
  id: string,
  position: number,
  text: string,
  inline: Inline[] = [],
  type?: UnitType,
): Unit {
  return {
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    ...(type ? { type } : {}),
    content: { kind: 'prose', text, inline },
    provenance_id: PROV,
  };
}
const content = (units: Unit[], revision: number): MathContent => ({
  object_id: OBJ,
  revision,
  units,
});

/** The units-array analog of flushToContent — compares by id + position + canonical content, AND freezes
 *  the type axis exactly as the real flush does: an existing unit's upsert keeps prev's fields (type
 *  frozen), a brand-new unit carries NO type. So `mine` in a merge never smuggles a cue's type through the
 *  prose delta — the keepTypes overlay is the only thing that preserves it (which is what we test). */
function diffContent(current: MathContent, baseline: MathContent): Delta {
  const baseById = new Map(baseline.units.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const upserts: Unit[] = [];
  // The real flush emits prose-or-heading content keyed to the PERSISTED kind (a promote is the STRUCTURAL
  // axis, never a prose upsert), so the prose delta is blind to heading-ness: normalize heading→prose for
  // both the change comparison and a brand-new unit (new headings can't ride save_content).
  const asProse = (c: Unit['content']): Unit['content'] =>
    c.kind === 'heading' ? { kind: 'prose', text: c.text, inline: c.inline } : c;
  for (const u of current.units) {
    seen.add(u.id);
    const prev = baseById.get(u.id);
    if (!prev) {
      const c = asProse(u.content);
      if (c.kind === 'prose' && c.text === '' && c.inline.length === 0) continue; // empty new → dropped
      // new unit carries NO type (mirrors newProseUnit) — only the plain-prose fields
      upserts.push({
        id: u.id,
        object_id: u.object_id,
        position: u.position,
        status: u.status,
        declared_by: u.declared_by,
        content: c,
        provenance_id: u.provenance_id,
      });
    } else if (
      u.position !== prev.position ||
      contentKeyOf(asProse(u.content)) !== contentKeyOf(asProse(prev.content))
    ) {
      upserts.push({ ...prev, position: u.position, content: asProse(u.content) }); // freeze all but pos+content
    }
  }
  const deletes = baseline.units.filter((u) => !seen.has(u.id)).map((u) => u.id);
  return { upserts, deletes };
}

/** Flip a unit's content prose↔heading for the §B keepStruct overlay (preserving text/inline); other
 *  kinds pass through unchanged (only prose/heading are toggle targets). */
function overlayHeading(content: Unit['content'], heading: boolean): Unit['content'] {
  if (heading && content.kind === 'prose')
    return { kind: 'heading', text: content.text, inline: content.inline };
  if (!heading && content.kind === 'heading')
    return { kind: 'prose', text: content.text, inline: content.inline };
  return content;
}

/** Stands in for the live ProseMirror doc: `current.units` carry both prose content AND the `type` node
 *  attr (so `delta` is prose-only — matching flushToContent which ignores type — and `docTypeNeeds` is the
 *  separate type axis). Records reprojections. */
class FakeDoc {
  current: MathContent;
  reprojections: MathContent[] = [];
  constructor(init: MathContent) {
    this.current = init;
  }
  delta(baseline: MathContent): Delta {
    return diffContent(this.current, baseline); // prose only (ignores type)
  }
  signature(): string {
    return JSON.stringify(this.current.units);
  }
  /** Pending TYPE delta vs `server`: each persisted unit whose doc type differs from the server's. */
  docTypeNeeds(server: MathContent): TypeNeed[] {
    const byId = new Map(server.units.map((u) => [u.id, u]));
    const needs: TypeNeed[] = [];
    for (const u of this.current.units) {
      const srv = byId.get(u.id);
      if (!srv) continue; // not yet persisted
      if ((u.type ?? null) !== (srv.type ?? null))
        needs.push({ unitId: u.id, type: u.type ?? null });
    }
    return needs;
  }
  /** Pending type INTENTS vs `baseline` — like docTypeNeeds but INCLUDES not-in-baseline units (a
   *  brand-new cued block is a pending intent). The keepTypes / dirty-decision source. */
  docTypeIntents(baseline: MathContent): TypeNeed[] {
    const byId = new Map(baseline.units.map((u) => [u.id, u]));
    const out: TypeNeed[] = [];
    for (const u of this.current.units) {
      const base = byId.get(u.id);
      const had = base ? (base.type ?? null) : null;
      if ((u.type ?? null) !== had) out.push({ unitId: u.id, type: u.type ?? null });
    }
    return out;
  }
  /** §B structural axis — the units-model analog of `structuralNeeds` (heading-ness = `content.kind`,
   *  parent = `parent_unit_id`). Toggles ordered before reparents; brand-new units skipped. */
  docStructuralNeeds(server: MathContent): StructuralNeed[] {
    const byId = new Map(server.units.map((u) => [u.id, u]));
    const toggles: StructuralNeed[] = [];
    const reparents: StructuralNeed[] = [];
    const posByParent = new Map<string | null, number>();
    for (const u of this.current.units) {
      const wantParent = u.parent_unit_id ?? null;
      const newPosition = posByParent.get(wantParent) ?? 0;
      posByParent.set(wantParent, newPosition + 1);
      const srv = byId.get(u.id);
      if (!srv) continue;
      if ((u.content.kind === 'heading') !== (srv.content.kind === 'heading'))
        toggles.push({ op: 'toggle_heading', unitId: u.id });
      if (wantParent !== (srv.parent_unit_id ?? null))
        reparents.push({ op: 'reparent', unitId: u.id, newParentId: wantParent, newPosition });
    }
    return [...toggles, ...reparents];
  }
  docStructuralIntents(baseline: MathContent): StructuralIntent[] {
    const byId = new Map(baseline.units.map((u) => [u.id, u]));
    const out: StructuralIntent[] = [];
    for (const u of this.current.units) {
      const want = u.content.kind === 'heading';
      const wantParent = u.parent_unit_id ?? null;
      const base = byId.get(u.id);
      const baseHeading = base ? base.content.kind === 'heading' : false;
      const baseParent = base ? (base.parent_unit_id ?? null) : null;
      if (want !== baseHeading || wantParent !== baseParent)
        out.push({ unitId: u.id, heading: want, parentId: wantParent });
    }
    return out;
  }
  reproject(c: MathContent, keepTypes: TypeNeed[], keepStruct: StructuralIntent[]): void {
    const wantType = new Map(keepTypes.map((t) => [t.unitId, t.type]));
    const wantStruct = new Map(keepStruct.map((s) => [s.unitId, s]));
    this.current = {
      ...c,
      units: c.units.map((u) => {
        let next = wantType.has(u.id) ? { ...u, type: wantType.get(u.id) ?? undefined } : u;
        const s = wantStruct.get(u.id);
        if (s) {
          next = {
            ...next,
            content: overlayHeading(next.content, s.heading),
            ...(s.parentId ? { parent_unit_id: s.parentId } : { parent_unit_id: undefined }),
          };
        }
        return next;
      }),
    };
    this.reprojections.push(this.current);
  }
  /** Simulate the user typing (replace the unit set — prose and/or type attrs). */
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
    setTypes: Array<{ unitId: string; type: UnitType | null; expectedRevision: number }>;
    structurals: Array<{ need: StructuralNeed; expectedRevision: number }>;
    persistDraft: number;
    clearDraft: number;
    cancelFlush: number;
    seeds: MathContent[];
  };
  queueSave: (fn: () => Promise<MathContent>) => void;
  queueSetType: (fn: () => Promise<MathContent>) => void;
  queueStruct: (fn: () => Promise<MathContent>) => void;
  setFetch: (fn: () => Promise<MathContent | null>) => void;
  setOnline: (b: boolean) => void;
  setReady: (b: boolean) => void;
}

function makeHarness(opts: {
  baseline: MathContent;
  doc?: MathContent; // what the user has typed (defaults to baseline = clean)
  maxMergeRetries?: number;
  maxTypeRetries?: number;
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
    setTypes: [] as Array<{ unitId: string; type: UnitType | null; expectedRevision: number }>,
    structurals: [] as Array<{ need: StructuralNeed; expectedRevision: number }>,
    persistDraft: 0,
    clearDraft: 0,
    cancelFlush: 0,
    seeds: [] as MathContent[],
  };
  const saveQueue: Array<() => Promise<MathContent>> = [];
  const setTypeQueue: Array<() => Promise<MathContent>> = [];
  const structQueue: Array<() => Promise<MathContent>> = [];
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
    reproject: (c, keepTypes, keepStruct) => doc.reproject(c, keepTypes, keepStruct),
    persistDraft: () => {
      calls.persistDraft += 1;
    },
    clearDraft: () => {
      calls.clearDraft += 1;
    },
    seedCache: (c) => {
      calls.seeds.push(c);
    },
    setType: (unitId, type, expectedRevision) => {
      calls.setTypes.push({ unitId, type, expectedRevision });
      const override = setTypeQueue.shift();
      if (override) return override(); // simulate an error / specific echo
      // default success: echo prior.current with the type applied + revision bumped
      const units = prior.current.units.map((u) =>
        u.id === unitId ? { ...u, ...(type ? { type } : { type: undefined }) } : u,
      );
      return Promise.resolve({ ...prior.current, revision: prior.current.revision + 1, units });
    },
    docTypeNeeds: (server) => doc.docTypeNeeds(server),
    docTypeIntents: (baseline) => doc.docTypeIntents(baseline),
    applyStructural: (need, expectedRevision) => {
      calls.structurals.push({ need, expectedRevision });
      const override = structQueue.shift();
      if (override) return override(); // simulate an error / specific echo
      // default success: apply the op to prior.current, bump the revision (mimics the server echo).
      if (need.op === 'toggle_heading') {
        const target = prior.current.units.find((x) => x.id === need.unitId);
        const wasHeading = target?.content.kind === 'heading';
        const parentOfTarget = target?.parent_unit_id;
        const units = prior.current.units.map((u) => {
          if (u.id === need.unitId) return { ...u, content: overlayHeading(u.content, !wasHeading) };
          // DISSOLVE side effect (FAITHFUL to the core): lift the former heading's direct children to its
          // parent. This is what makes the controller's residual-reproject path testable.
          if (wasHeading && u.parent_unit_id === need.unitId)
            return parentOfTarget
              ? { ...u, parent_unit_id: parentOfTarget }
              : { ...u, parent_unit_id: undefined };
          return u;
        });
        return Promise.resolve({ ...prior.current, revision: prior.current.revision + 1, units });
      }
      const units = prior.current.units.map((u) =>
        u.id === need.unitId
          ? {
              ...u,
              position: need.newPosition,
              ...(need.newParentId
                ? { parent_unit_id: need.newParentId }
                : { parent_unit_id: undefined }),
            }
          : u,
      );
      return Promise.resolve({ ...prior.current, revision: prior.current.revision + 1, units });
    },
    docStructuralNeeds: (server) => doc.docStructuralNeeds(server),
    docStructuralIntents: (baseline) => doc.docStructuralIntents(baseline),
    setStatus: (fn) => {
      state = fn(state);
    },
    cancelScheduledFlush: () => {
      calls.cancelFlush += 1;
    },
    isOnline: () => online,
    ready: () => ready,
    ...(opts.maxMergeRetries != null ? { maxMergeRetries: opts.maxMergeRetries } : {}),
    ...(opts.maxTypeRetries != null ? { maxTypeRetries: opts.maxTypeRetries } : {}),
  };

  return {
    ctl: createAutosaveController(ports),
    doc,
    prior,
    getState: () => state,
    calls,
    queueSave: (fn) => saveQueue.push(fn),
    queueSetType: (fn) => setTypeQueue.push(fn),
    queueStruct: (fn) => structQueue.push(fn),
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

describe('type cues (2c-2) — drainTypes after the prose part', () => {
  it('a new cued unit: prose save (type=null) THEN set_unit_type', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa', [], 'theorem')], 1),
    });
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa')], 2))); // server creates type=null
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1);
    expect(h.calls.setTypes).toEqual([{ unitId: 'pa', type: 'theorem', expectedRevision: 2 }]);
    expect(h.prior.current.units.find((u) => u.id === 'pa')!.type).toBe('theorem');
    expect(h.getState()).toMatchObject({
      saving: false,
      dirty: false,
      conflict: false,
      error: false,
    });
  });

  it('a pure re-type of an existing unit: NO prose save, one set_unit_type (fall-through past clean)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0', [], 'theorem')], 1), // same text/pos, type added
    });
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0); // type never rides the prose delta
    expect(h.calls.setTypes).toEqual([{ unitId: 'p0', type: 'theorem', expectedRevision: 1 }]);
    expect(h.getState()).toMatchObject({ saving: false, dirty: false });
  });

  it('clearing a type sends set_unit_type with null', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0', [], 'theorem')], 1),
      doc: content([prose('p0', 0, 'P0')], 1), // type cleared
    });
    await h.ctl.flush();
    expect(h.calls.setTypes).toEqual([{ unitId: 'p0', type: null, expectedRevision: 1 }]);
    expect(h.prior.current.units.find((u) => u.id === 'p0')!.type ?? null).toBeNull();
  });

  it('a fully clean doc does no work (no save, no set_unit_type, never saving)', async () => {
    const h = makeHarness({ baseline: content([prose('p0', 0, 'P0')], 1) }); // doc === baseline, no type
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0);
    expect(h.calls.setTypes).toHaveLength(0);
    expect(h.getState()).toMatchObject({ dirty: false });
  });

  it('a 409 mid-drain re-anchors to fresh and retries (preserving the pending type)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 2),
      doc: content([prose('p0', 0, 'P0', [], 'theorem')], 2), // pure type change
    });
    let rev = 3;
    h.setFetch(async () => content([prose('p0', 0, 'P0')], rev++)); // advances each GET
    h.queueSetType(() => Promise.reject(apiErr(409))); // first attempt races
    await h.ctl.flush();
    expect(h.calls.setTypes).toHaveLength(2); // 409 then success
    expect(h.prior.current.units.find((u) => u.id === 'p0')!.type).toBe('theorem');
    expect(h.getState()).toMatchObject({ conflict: false, dirty: false });
  });

  it('exhausting the type-retry budget enters conflict', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 2),
      doc: content([prose('p0', 0, 'P0', [], 'theorem')], 2),
      maxTypeRetries: 1,
    });
    let rev = 3;
    h.setFetch(async () => content([prose('p0', 0, 'P0')], rev++));
    h.queueSetType(() => Promise.reject(apiErr(409)));
    h.queueSetType(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.getState().conflict).toBe(true);
  });

  it('drains a pending type AFTER a prose merge (409 → runMerge → drainTypes)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0x', [], 'theorem')], 1), // edited prose + typed
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2)); // server added z
    h.queueSave(() => Promise.reject(apiErr(409))); // initial prose PUT races
    h.queueSave(ok(content([prose('p0', 0, 'P0x'), prose('z', 1, 'Z')], 3))); // merge PUT
    await h.ctl.flush();
    expect(h.calls.setTypes.map((s) => s.unitId)).toEqual(['p0']); // type drained post-merge
    expect(h.prior.current.units.find((u) => u.id === 'p0')!.type).toBe('theorem');
    expect(h.getState()).toMatchObject({ conflict: false, error: false, dirty: false });
  });

  it('a transient type-op failure is non-lossy: dirty + error, prose safe, retried later', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0', [], 'theorem')], 1),
    });
    h.setOnline(true);
    h.queueSetType(() => Promise.reject(new Error('network')));
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0);
    expect(h.getState()).toMatchObject({ dirty: true, error: true });
    expect(h.prior.current.units.find((u) => u.id === 'p0')!.type ?? null).toBeNull(); // not applied
    expect(h.calls.persistDraft).toBeGreaterThanOrEqual(1); // draft kept
  });

  it('dispose mid-drain stops further type ops (no write after teardown)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0', [], 'theorem')], 1),
    });
    const gate = deferred<MathContent>();
    h.queueSetType(() => gate.promise);
    const p = h.ctl.flush();
    await tick(); // parked on set_unit_type
    h.ctl.dispose();
    gate.resolve(content([prose('p0', 0, 'P0', [], 'theorem')], 2));
    await p;
    expect(h.calls.setTypes).toHaveLength(1);
    expect(h.prior.current.revision).toBe(1); // disposed continuation never advanced the baseline
  });
});

describe('type cues (2c-2) — review fixes', () => {
  it('B1 blocker: a brand-new cue survives a prose-409 merge (keepTypes overlay)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, 'Pa', [], 'theorem')], 1), // new cued block
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2)); // server advanced
    h.queueSave(() => Promise.reject(apiErr(409))); // prose PUT races
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('z', 1, 'Z'), prose('pa', 2, 'Pa')], 3))); // merge (pa type=null)
    await h.ctl.flush();
    // pa's cue is NOT lost: drained via set_unit_type after the merge re-created it.
    expect(h.calls.setTypes.map((s) => s.unitId)).toContain('pa');
    expect(h.prior.current.units.find((u) => u.id === 'pa')!.type).toBe('theorem');
    expect(h.getState()).toMatchObject({ conflict: false, error: false, dirty: false });
  });

  it('B2 empty cued block: no save/setType, but the draft is KEPT (not discarded)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 1),
      // a cued-but-empty new block (Thm. then pause) — unpersistable, lives only as intent
      doc: content([prose('p0', 0, 'P0'), prose('pa', 1, '', [], 'theorem')], 1),
    });
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0); // empty block isn't persisted
    expect(h.calls.setTypes).toHaveLength(0); // can't set type on an unpersisted unit
    expect(h.calls.persistDraft).toBeGreaterThanOrEqual(1); // draft KEPT (the cue survives reload)
    expect(h.calls.clearDraft).toBe(0);
    expect(h.getState().dirty).toBe(true);
  });

  it('B3 genuine reject: a non-advancing set_unit_type 409 defers (no loop → no conflict)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0')], 2),
      doc: content([prose('p0', 0, 'P0', [], 'theorem')], 2), // pure type change
    });
    h.setFetch(async () => content([prose('p0', 0, 'P0')], 2)); // NOT advanced (rev unchanged)
    h.queueSetType(() => Promise.reject(apiErr(409)));
    await h.ctl.flush();
    expect(h.calls.setTypes).toHaveLength(1); // one attempt, no retry storm
    expect(h.getState()).toMatchObject({ error: true, conflict: false });
  });

  it('B0 clear-then-delete: deleting a typed block clears its type then deletes (no 422 stuck error)', async () => {
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0', [], 'theorem'), prose('p1', 1, 'P1')], 2),
      doc: content([prose('p1', 0, 'P1')], 2), // the user removed the theorem block p0
    });
    h.queueSave(ok(content([prose('p1', 0, 'P1')], 4))); // delete succeeds once p0 is untyped
    await h.ctl.flush();
    expect(h.calls.setTypes).toEqual([{ unitId: 'p0', type: null, expectedRevision: 2 }]); // type cleared first
    expect(h.calls.saves.at(-1)!.deletes).toEqual(['p0']); // then deleted via save_content
    expect(h.prior.current.units.map((u) => u.id)).toEqual(['p1']);
    expect(h.getState()).toMatchObject({ error: false, conflict: false });
  });
});

describe('type cues (2c-2) — typed-delete via the merge path (the intermittent "Couldn’t save")', () => {
  it('a disjoint typed-delete that 409s into runMerge clears-then-deletes (no 422, no stuck error)', async () => {
    // baseline: a plain p0 @0 and a TYPED t1 @1 (last). The user deletes t1 (only); p0 stays put.
    const h = makeHarness({
      baseline: content([prose('p0', 0, 'P0'), prose('t1', 1, 'T1', [], 'theorem')], 1),
      doc: content([prose('p0', 0, 'P0')], 1), // t1 removed
    });
    // The flush's clear-then-delete setType races (another tab advanced) → 409 → routes to runMerge.
    h.queueSetType(() => Promise.reject(apiErr(409)));
    // Fresh server: another tab edited p0 (disjoint from t1); t1 is STILL typed.
    h.setFetch(async () =>
      content([prose('p0', 0, 'P0x'), prose('t1', 1, 'T1', [], 'theorem')], 2),
    );
    // The merge's save behaves like the real save_content: deleting a STILL-typed t1 → 422. So this passes
    // ONLY if runMerge cleared t1's type first (the fix); pre-fix t1 stays typed → 422 → stuck error.
    h.queueSave(() => {
      const t1StillTyped = h.prior.current.units.some(
        (u) => u.id === 't1' && (u.type ?? null) != null,
      );
      return t1StillTyped
        ? Promise.reject(apiErr(422))
        : Promise.resolve(content([prose('p0', 0, 'P0x')], 4));
    });
    await h.ctl.flush();
    // No stuck "Couldn’t save": t1 is gone, the merge applied, no error/conflict.
    expect(h.prior.current.units.map((u) => u.id)).toEqual(['p0']);
    expect(h.getState()).toMatchObject({ error: false, conflict: false });
    // t1's type was cleared (once in the flush attempt, once in the merge) before any delete.
    expect(h.calls.setTypes.every((s) => s.unitId === 't1' && s.type === null)).toBe(true);
  });
});

describe('drainStructure — §B section axis', () => {
  const heading = (id: string, position: number, text: string, parent?: string): Unit => ({
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    ...(parent ? { parent_unit_id: parent } : {}),
    content: { kind: 'heading', text, inline: [] },
    provenance_id: PROV,
  });
  const child = (id: string, position: number, text: string, parent: string): Unit => ({
    ...prose(id, position, text),
    parent_unit_id: parent,
  });

  it('promote: a heading-doc over a prose server unit fires toggle_heading (no prose delta)', async () => {
    const server = content([prose('p0', 0, 'Title')], 1);
    const h = makeHarness({ baseline: server });
    h.doc.type([heading('p0', 0, 'Title')]); // user typed "# " → block is now a heading
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0); // pure promote → no prose delta (structural axis only)
    expect(h.calls.structurals).toHaveLength(1);
    expect(h.calls.structurals[0]!.need).toEqual({ op: 'toggle_heading', unitId: 'p0' });
    expect(h.prior.current.units[0]!.content.kind).toBe('heading'); // server echo applied
    expect(h.getState()).toMatchObject({ saving: false, dirty: false, conflict: false });
  });

  it('reparent: a body unit claiming a heading parent fires reparent_unit (no prose delta)', async () => {
    const server = content([heading('h1', 0, 'Sec'), prose('p1', 1, 'body')], 1); // p1 top-level
    const h = makeHarness({ baseline: server });
    // p1 now flows UNDER h1. Its `position` stays at the server's (1): the real flush positions an existing
    // unit in its BASELINE parent's namespace and never changes parent via the prose delta, so a pure
    // reparent has no prose delta — only the structural axis. (The reparent's own target index comes from
    // docStructuralNeeds, not this field.)
    h.doc.type([heading('h1', 0, 'Sec'), child('p1', 1, 'body', 'h1')]);
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(0); // no prose delta — purely structural
    expect(h.calls.structurals).toHaveLength(1);
    expect(h.calls.structurals[0]!.need).toMatchObject({
      op: 'reparent',
      unitId: 'p1',
      newParentId: 'h1',
    });
    expect(h.prior.current.units.find((u) => u.id === 'p1')!.parent_unit_id).toBe('h1');
  });

  it('toggles run BEFORE reparents (promote the heading, then move the body under it)', async () => {
    const server = content([prose('u1', 0, 'Sec'), prose('p1', 1, 'body')], 1);
    const h = makeHarness({ baseline: server });
    h.doc.type([heading('u1', 0, 'Sec'), child('p1', 1, 'body', 'u1')]); // position 1 = server's (no prose delta)
    await h.ctl.flush();
    expect(h.calls.structurals.map((s) => s.need.op)).toEqual(['toggle_heading', 'reparent']);
  });

  it('a brand-new heading is created in ONE flush: save_content (prose) then drainStructure promotes', async () => {
    // The user typed a new "# Foo" line (no server unit). Pass 1 of the SAME flush: save_content creates it
    // as PROSE (new headings can't ride save_content); then drainStructure — running after the prose save in
    // the same cycle — sees it now persisted and toggle_heading-promotes it. Net: one flush, fully settled.
    const server = content([prose('p0', 0, 'P0')], 1);
    const h = makeHarness({ baseline: server });
    h.doc.type([prose('p0', 0, 'P0'), heading('new1', 1, 'Foo')]); // new1 not on server
    h.queueSave(ok(content([prose('p0', 0, 'P0'), prose('new1', 1, 'Foo')], 2))); // created as prose
    await h.ctl.flush();
    expect(h.calls.saves).toHaveLength(1); // new prose row created first
    expect(h.calls.structurals).toEqual([
      { need: { op: 'toggle_heading', unitId: 'new1' }, expectedRevision: 2 }, // then promoted, same flush
    ]);
    expect(h.prior.current.units.find((u) => u.id === 'new1')!.content.kind).toBe('heading');
    expect(h.getState()).toMatchObject({ dirty: false, conflict: false });
  });

  it('a structural 409 with NO server advance DEFERS (draft kept), never a silent conflict', async () => {
    const server = content([prose('p0', 0, 'Title')], 1);
    const h = makeHarness({ baseline: server });
    h.doc.type([heading('p0', 0, 'Title')]);
    h.queueStruct(() => Promise.reject(apiErr(409))); // toggle_heading races
    h.setFetch(async () => server); // server did NOT advance → deterministic, not a race
    await h.ctl.flush();
    expect(h.getState()).toMatchObject({ conflict: false }); // deferred, not conflict
    expect(h.calls.persistDraft).toBeGreaterThan(0);
  });

  it('dissolve converges: the op lifts children server-side, the doc adopts them (no phantom-reparent wedge)', async () => {
    // server: section h1 with one body child c1. The user dissolved h1 (Backspace on the empty heading): the
    // gesture marks h1 not-a-heading but does NOT lift c1 in the doc — toggle_heading lifts c1 server-side,
    // and the controller's residual-reproject must bring the doc into agreement (else c1 would re-POST as a
    // phantom reparent under the now-prose h1 → a 422 every flush).
    const server = content([heading('h1', 0, 'Sec'), child('c1', 0, 'body', 'h1')], 1);
    const h = makeHarness({ baseline: server });
    h.doc.type([prose('h1', 0, 'Sec'), child('c1', 0, 'body', 'h1')]); // h1 dissolved; c1 still under h1 in doc
    await h.ctl.flush();
    expect(h.calls.structurals.map((s) => s.need.op)).toEqual(['toggle_heading']); // ONE op (no phantom)
    expect(h.prior.current.units.find((u) => u.id === 'c1')!.parent_unit_id ?? null).toBe(null); // lifted
    expect(h.doc.docStructuralNeeds(h.prior.current)).toEqual([]); // doc adopted the lift → converged
    expect(h.getState()).toMatchObject({ dirty: false, conflict: false });
  });
});
