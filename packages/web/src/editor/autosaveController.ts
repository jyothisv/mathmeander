// The slice-2c autosave/merge orchestration, extracted from DayEditor's useEffect into a PURE,
// node-testable controller. ProseMirror, the debounce timers, the DOM events and React stay in DayEditor
// (the adapter); everything reachable through the injected ports is deterministic and branch-testable
// without a browser. The hard invariant is unchanged: NEVER silently lose/clobber content — a 409 (or a
// stale-write 422) runs the additive merge (merge.ts); a same-unit clash surfaces a CONFLICT the user
// resolves ("Load the latest" / "Keep mine"). The controller owns the state machine; the e2e merge suite
// is the behaviour-preservation safety net.
import type { MathContent, Unit } from '@mathmeander/schema';
import { planMerge, type Delta } from './merge';
import { classifyFlushError } from './errorClass';
import type { SaveState } from './saveStatus';

/** The §6.0a coarse prose delta the editor PUTs. */
export type SaveBody = { expected_revision: number; upserts: Unit[]; deletes: string[] };

export interface AutosavePorts {
  objectId: string;
  /** Shared baseline ref — the SAME object DayEditor's writeDraft/beaconFlush close over (identity
   *  matters: the controller's mid-save reassignments must be visible to the beacon/draft writers). */
  prior: { current: MathContent };
  /** PUT the delta; resolves to the core's canonical echo (outcome.content); throws ApiError. */
  save(body: SaveBody): Promise<MathContent>;
  /** GET fresh content for this object: the MathContent, `null` if the object is gone; throws = transient. */
  fetchFresh(): Promise<MathContent | null>;
  /** My local delta vs `baseline` (= flushToContent(doc, baseline)). */
  delta(baseline: MathContent): Delta;
  /** A stable signature of the live doc (drives the semantic latch). */
  signature(): string;
  /** Replace the live doc with `content` WITHOUT a dispatch (no spurious dirty/flush). */
  reproject(content: MathContent): void;
  /** Persist the local draft (token-guarded; reads shared `prior` + the doc). */
  persistDraft(): void;
  clearDraft(): void;
  seedCache(content: MathContent): void;
  /** Set the React save status; already cancellation-guarded by the caller (DayEditor's `setIf`). */
  setStatus(next: (s: SaveState) => SaveState): void;
  /** Clear the pending network-flush debounce timer (DayEditor owns the handle). */
  cancelScheduledFlush(): void;
  isOnline(): boolean;
  /** Is the live view mounted? (the resolution handlers guard on it, as the originals did.) */
  ready(): boolean;
  /** Bounded re-409 retries before giving up to a conflict (default 3). */
  maxMergeRetries?: number;
}

export interface AutosaveController {
  /** Debounced network sync (the draft, not this, is durability). Owns the `busy` guard. */
  flush(): Promise<void>;
  /** Conflict resolution "Load the latest": discard my unsynced work, show the server version. */
  resolveTakeTheirs(): Promise<void>;
  /** Conflict resolution "Keep mine": a forced (mine-wins) merge that preserves the other side's adds. */
  resolveKeepMine(): Promise<void>;
  /** On a doc edit: clear the latch, mark dirty; returns whether the caller should schedule a flush. */
  noteEdit(): boolean;
  /** Should a reconnect trigger a flush? (dirty, not in conflict, not mid-operation.) */
  canFlushOnReconnect(): boolean;
  /** Restore-on-mount bridge: seed the dirty/conflict flags (DayEditor sets its own status payload). */
  noteRestored(opts: { conflict: boolean }): void;
  /** Mark the controller torn down — guards async continuations from writing after unmount. */
  dispose(): void;
}

export function createAutosaveController(ports: AutosavePorts): AutosaveController {
  const { prior } = ports;
  const MAX_MERGE_RETRIES = ports.maxMergeRetries ?? 3;
  const setStatus = ports.setStatus;

  let busy = false; // single in-progress guard across the whole flush → merge / resolve chain
  let conflict = false; // a 409 we couldn't merge — auto-save paused until the user resolves
  let semanticLatch: string | null = null; // doc signature of a deterministically-rejected (4xx) save
  let mergeRetries = 0;
  let dirtyMirror = false; // closure mirror of `dirty` (read synchronously by canFlushOnReconnect)
  let disposed = false;

  const enterConflict = (): void => {
    conflict = true;
    ports.cancelScheduledFlush();
    ports.persistDraft(); // keep the user's unsynced work
    setStatus((s) => ({ ...s, saving: false, conflict: true }));
  };

  /** A 409 (or a stale-write 422), and the "Keep mine" resolution (`force`) → safe additive merge. We
   *  REPROJECT the merged content (incl. foreign units) into the doc while it's stable, then persist the
   *  rebased delta; the after-recompute then covers any typed-during-PUT edit. The CALLER owns `busy`. */
  const runMerge = async (opts?: { force?: boolean }): Promise<void> => {
    const baseline = prior.current; // snapshot BEFORE the first await (the rebase anchor)
    let fresh: MathContent;
    try {
      const found = await ports.fetchFresh();
      if (disposed) return;
      if (!found) return enterConflict();
      fresh = found;
    } catch {
      ports.persistDraft(); // transient (GET failed) — retry on next edit/online
      setStatus((s) => ({ ...s, saving: false, error: ports.isOnline() }));
      return;
    }
    if (disposed) return;
    // Compute MY delta against the CURRENT doc (captures edits made during the GET) so a fast typist
    // doesn't burn the retry budget; the retry cap is then consumed only by genuine re-409 races.
    const mine = ports.delta(baseline);

    if (fresh.revision <= baseline.revision && !opts?.force) {
      // The server did NOT advance → a GENUINE reject (not a stale-write race). Latch the offending doc
      // so we don't re-send it every keystroke; surface for review. (Forced keep-mine skips this.)
      mergeRetries = 0;
      ports.persistDraft();
      semanticLatch = ports.signature();
      setStatus((s) => ({ ...s, saving: false, error: true }));
      return;
    }

    const plan = planMerge({
      baseline,
      server: fresh,
      mine,
      ...(opts?.force ? { force: true } : {}),
    });
    if (plan.kind === 'conflict') return enterConflict();

    // Doc is stable → bring the merged content on screen and rebase the baseline to the fresh server.
    prior.current = fresh;
    ports.seedCache(fresh);
    ports.reproject(plan.content);

    if (plan.rebasedDelta.upserts.length === 0 && plan.rebasedDelta.deletes.length === 0) {
      // nothing of mine to persist (e.g. my only change was a dropped reorder) — already in sync.
      ports.seedCache(plan.content);
      prior.current = plan.content;
      mergeRetries = 0;
      ports.clearDraft();
      dirtyMirror = false;
      setStatus((s) => ({ ...s, saving: false, dirty: false, error: false, conflict: false }));
      return;
    }

    setStatus((s) => ({ ...s, saving: true, conflict: false }));
    try {
      const content = await ports.save({
        expected_revision: fresh.revision,
        upserts: plan.rebasedDelta.upserts,
        deletes: plan.rebasedDelta.deletes,
      });
      if (disposed) return;
      prior.current = content;
      ports.seedCache(content);
      mergeRetries = 0;
      // The reprojected doc has the foreign units, so any typed-during-PUT edit is a normal delta.
      const after = ports.delta(prior.current);
      const stillDirty = after.upserts.length > 0 || after.deletes.length > 0;
      if (stillDirty) ports.persistDraft();
      else ports.clearDraft();
      dirtyMirror = stillDirty;
      setStatus((s) => ({ ...s, saving: false, dirty: stillDirty, error: false, conflict: false }));
    } catch (err) {
      if (classifyFlushError(err) === 'conflict') {
        if (mergeRetries >= MAX_MERGE_RETRIES) return enterConflict();
        mergeRetries += 1;
        return await runMerge(opts); // another writer raced — bounded retry, still inside `busy`
      }
      ports.persistDraft();
      setStatus((s) => ({ ...s, saving: false, error: ports.isOnline() }));
    }
  };

  const flush = async (): Promise<void> => {
    if (conflict || busy) return;
    const { upserts, deletes } = ports.delta(prior.current);
    if (upserts.length === 0 && deletes.length === 0) {
      semanticLatch = null; // doc returned to the server state
      ports.clearDraft();
      dirtyMirror = false;
      setStatus((s) => ({ ...s, dirty: false, error: false }));
      return;
    }
    if (semanticLatch !== null) {
      if (ports.signature() === semanticLatch) return; // known-bad delta, unchanged → don't re-send
      semanticLatch = null; // doc changed → worth another try
    }
    busy = true;
    setStatus((s) => ({ ...s, saving: true }));
    try {
      const content = await ports.save({
        expected_revision: prior.current.revision,
        upserts,
        deletes,
      });
      prior.current = content; // ids are client-minted, so the doc stays anchored
      ports.seedCache(content);
      // Did the user type more while the PUT was in flight? Keep the draft if so, else drop it.
      const after = ports.delta(prior.current);
      const stillDirty = after.upserts.length > 0 || after.deletes.length > 0;
      if (stillDirty) ports.persistDraft();
      else ports.clearDraft();
      dirtyMirror = stillDirty;
      setStatus((s) => ({ ...s, saving: false, dirty: stillDirty, error: false }));
    } catch (err) {
      if (classifyFlushError(err) === 'transient') {
        // network/5xx: while OFFLINE keep the calm "Offline" status (auto-flushes on reconnect); a
        // genuine online failure surfaces an error. Retries on next edit/online.
        ports.persistDraft();
        setStatus((s) => ({ ...s, saving: false, error: ports.isOnline() }));
        return; // finally clears busy
      }
      // conflict (409) OR semantic (4xx): the server may have advanced under us — a STALE delta is
      // rejected 422 BEFORE the 409 revision gate. runMerge fetches fresh and decides by revision:
      // advanced → merge; not advanced → genuine reject → latch. `busy` stays held.
      await runMerge();
    } finally {
      busy = false;
    }
  };

  // Conflict resolution (the two buttons shown in the conflict state). Both take `busy` for their whole
  // span so a keystroke-scheduled flush can't interleave.
  const resolveTakeTheirs = async (): Promise<void> => {
    if (busy || !ports.ready()) return;
    busy = true;
    setStatus((s) => ({ ...s, saving: true }));
    try {
      const found = await ports.fetchFresh();
      if (disposed) return;
      if (!found) {
        setStatus((s) => ({ ...s, saving: false, error: true }));
        return;
      }
      prior.current = found;
      ports.seedCache(found);
      ports.reproject(found); // discard my unsaved changes, show the server version
      ports.clearDraft();
      conflict = false;
      mergeRetries = 0;
      semanticLatch = null;
      dirtyMirror = false;
      setStatus((s) => ({ ...s, saving: false, conflict: false, dirty: false, error: false }));
    } catch {
      setStatus((s) => ({ ...s, saving: false, error: ports.isOnline() }));
    } finally {
      busy = false;
    }
  };

  const resolveKeepMine = async (): Promise<void> => {
    if (busy || !ports.ready()) return;
    busy = true;
    conflict = false; // resolving in my favour → let the (forced) merge proceed and re-sync
    setStatus((s) => ({ ...s, saving: true, conflict: false }));
    try {
      await runMerge({ force: true });
    } finally {
      busy = false;
    }
  };

  const noteEdit = (): boolean => {
    semanticLatch = null; // edited → any latched delta is stale
    dirtyMirror = true;
    setStatus((s) => (s.dirty ? s : { ...s, dirty: true }));
    return !conflict; // in conflict, keep drafting locally but pause network sync
  };

  const canFlushOnReconnect = (): boolean => dirtyMirror && !conflict && !busy;

  const noteRestored = (opts: { conflict: boolean }): void => {
    dirtyMirror = true;
    if (opts.conflict) conflict = true;
  };

  const dispose = (): void => {
    disposed = true;
  };

  return {
    flush,
    resolveTakeTheirs,
    resolveKeepMine,
    noteEdit,
    canFlushOnReconnect,
    noteRestored,
    dispose,
  };
}
