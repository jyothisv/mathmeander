// The slice-2c autosave/merge orchestration, extracted from DayEditor's useEffect into a PURE,
// node-testable controller. ProseMirror, the debounce timers, the DOM events and React stay in DayEditor
// (the adapter); everything reachable through the injected ports is deterministic and branch-testable
// without a browser. The hard invariant is unchanged: NEVER silently lose/clobber content — a 409 (or a
// stale-write 422) runs the additive merge (merge.ts); a same-unit clash surfaces a CONFLICT the user
// resolves ("Load the latest" / "Keep mine"). The controller owns the state machine; the e2e merge suite
// is the behaviour-preservation safety net.
import type { MathContent, Unit, UnitType } from '@mathmeander/schema';
import { planMerge, type Delta } from './merge';
import type { TypeNeed } from './projection';
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
  /** Replace the live doc with `content` WITHOUT a dispatch (no spurious dirty/flush). `keepTypes`
   *  overlays my still-pending optimistic type cues onto the reprojected doc so a prose merge (which
   *  carries only server types) never silently drops a type the user just declared (§2c-2). */
  reproject(content: MathContent, keepTypes: TypeNeed[]): void;
  /** Persist the local draft (token-guarded; reads shared `prior` + the doc). */
  persistDraft(): void;
  clearDraft(): void;
  seedCache(content: MathContent): void;
  /** Issue the §6.0a `set_unit_type` op (value=set, null=clear) at `expectedRevision`; resolves to the
   *  canonical echo; throws ApiError (409 stale revision / 422 the target unit was concurrently removed). */
  setType(unitId: string, type: UnitType | null, expectedRevision: number): Promise<MathContent>;
  /** The SENDABLE type delta vs `server` (= `typeNeeds` over the live doc): persisted units whose node
   *  type attr differs from the server's `type`. What `drainTypes` can actually `set_unit_type` now. */
  docTypeNeeds(server: MathContent): TypeNeed[];
  /** My pending type INTENTS vs `baseline` (= `typeIntents` over the live doc): includes brand-new cued
   *  blocks not yet persisted. Used for the keepTypes reproject overlay and the dirty/draft decision. */
  docTypeIntents(baseline: MathContent): TypeNeed[];
  /** Set the React save status; already cancellation-guarded by the caller (DayEditor's `setIf`). */
  setStatus(next: (s: SaveState) => SaveState): void;
  /** Clear the pending network-flush debounce timer (DayEditor owns the handle). */
  cancelScheduledFlush(): void;
  isOnline(): boolean;
  /** Is the live view mounted? (the resolution handlers guard on it, as the originals did.) */
  ready(): boolean;
  /** Bounded re-409 retries before giving up to a conflict (default 3). */
  maxMergeRetries?: number;
  /** Bounded retries for a type-set racing another writer before giving up to a conflict (default 3). */
  maxTypeRetries?: number;
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
  const MAX_TYPE_RETRIES = ports.maxTypeRetries ?? 3;
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

  /** Unified post-sync bookkeeping (covers prose AND type work): dirty iff EITHER a prose delta or a type
   *  need still remains; persist/clear the draft to match. A partial type failure leaves dirty=true so the
   *  next flush re-drains — non-lossy. Always lands conflict:false (the clean exit of a sync). */
  const settleAfterFlush = (error: boolean): void => {
    const d = ports.delta(prior.current);
    const proseLeft = d.upserts.length > 0 || d.deletes.length > 0;
    // INTENTS, not just sendable needs: an empty cued block (un-persistable) stays dirty/drafted, not lost.
    const typesLeft = ports.docTypeIntents(prior.current).length > 0;
    const stillDirty = proseLeft || typesLeft;
    if (!proseLeft) semanticLatch = null; // prose is synced → any prose latch is now stale
    if (stillDirty) ports.persistDraft();
    else ports.clearDraft();
    dirtyMirror = stillDirty;
    setStatus((s) => ({ ...s, saving: false, dirty: stillDirty, error, conflict: false }));
  };

  /** A typed unit can't be deleted via `save_content` (§6.0a; reviewable dissolve is 2c-3). Before ANY
   *  save_content that deletes units, clear the type of each to-be-deleted unit that's typed on the current
   *  baseline (`set_unit_type` null), advancing the baseline — so the now-plain unit deletes cleanly. Used
   *  by `flush` AND `runMerge` AND the `drainTypes` re-anchor, so a typed-delete NEVER 422s on any path
   *  (incl. a delete that 409s into a merge — the source of an intermittent stuck "Couldn't save"). Caller
   *  owns `busy`; a throw propagates to the caller's existing catch. */
  const clearTypesForDeletes = async (deletes: string[]): Promise<void> => {
    for (const id of deletes) {
      const u = prior.current.units.find((x) => x.id === id);
      if (u && (u.type ?? null) != null) {
        const cleared = await ports.setType(id, null, prior.current.revision);
        if (disposed) return;
        prior.current = cleared;
        ports.seedCache(cleared);
      }
    }
  };

  /** Apply pending TYPE changes (2c-2) via `set_unit_type`, AFTER the prose part of a sync. Stateless +
   *  idempotent: recompute `docTypeNeeds` each pass, apply each sequentially at the current revision (each
   *  op bumps it). On a 409 (revision advanced) or 422 (the target unit was concurrently removed) →
   *  re-anchor by MERGING fresh (preserving my unflushed prose AND my pending type cues), then loop to
   *  retry the types at the new revision; bounded retries → conflict. A transient failure DEFERS (draft
   *  kept, retried on the next flush). Type NEVER rides the prose delta (§6.0a). The CALLER owns `busy`. */
  const drainTypes = async (): Promise<'done' | 'deferred' | 'conflict'> => {
    for (let attempt = 0; attempt <= MAX_TYPE_RETRIES; attempt += 1) {
      const needs = ports.docTypeNeeds(prior.current);
      if (needs.length === 0) return 'done';
      try {
        for (const need of needs) {
          const content = await ports.setType(need.unitId, need.type, prior.current.revision);
          if (disposed) return 'done';
          prior.current = content;
          ports.seedCache(content);
        }
        return 'done';
      } catch (err) {
        if (disposed) return 'done';
        if (classifyFlushError(err) === 'transient') return 'deferred'; // retried next flush/reconnect
        // 409/422: another writer advanced the revision (or removed the target unit). Re-anchor by merging
        // fresh — preserving my unflushed prose AND my pending cues — then loop to retry at the new
        // revision. (Self-contained; mirrors runMerge's merge step without the latch/force/retry-cap.)
        const baseline = prior.current;
        let fresh: MathContent;
        try {
          const found = await ports.fetchFresh();
          if (disposed) return 'done';
          if (!found) {
            enterConflict();
            return 'conflict';
          }
          fresh = found;
        } catch {
          return 'deferred'; // GET failed (transient) — retry on the next flush
        }
        if (fresh.revision <= baseline.revision) {
          // The server did NOT advance → a deterministic set_unit_type reject, not a race. Surface (don't
          // loop to the retry cap → conflict); retried on the next real edit. (Mirrors the prose latch.)
          return 'deferred';
        }
        const plan = planMerge({ baseline, server: fresh, mine: ports.delta(baseline) });
        if (plan.kind === 'conflict') {
          enterConflict();
          return 'conflict';
        }
        const keep = ports.docTypeIntents(baseline); // my pending cues (incl. unpersisted), preserved
        prior.current = fresh;
        ports.seedCache(fresh);
        ports.reproject(plan.content, keep);
        if (plan.rebasedDelta.upserts.length > 0 || plan.rebasedDelta.deletes.length > 0) {
          try {
            await clearTypesForDeletes(plan.rebasedDelta.deletes); // typed-delete → clear first
            if (disposed) return 'done';
            const content = await ports.save({
              expected_revision: prior.current.revision,
              upserts: plan.rebasedDelta.upserts,
              deletes: plan.rebasedDelta.deletes,
            });
            if (disposed) return 'done';
            prior.current = content;
            ports.seedCache(content);
          } catch {
            return 'deferred'; // prose re-save raced again — defer; the next flush retries
          }
        }
        // loop: recompute typeNeeds(prior.current) and retry setType at the advanced revision
      }
    }
    enterConflict(); // exhausted the type-retry budget under repeated races
    return 'conflict';
  };

  /** Shared success tail of flush + runMerge: drain pending types, then settle the status (unless the
   *  drain ended in a conflict, which already set the status). `proseLatched` keeps `error:true` while a
   *  known-bad prose delta is still pending (we drained types past it but the prose remains rejected). */
  const finishWithTypes = async (proseLatched = false): Promise<void> => {
    const outcome = await drainTypes();
    if (outcome === 'conflict') return; // enterConflict already set the status
    settleAfterFlush(proseLatched ? true : outcome === 'deferred' ? ports.isOnline() : false);
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
    // Capture my still-pending type INTENTS vs the baseline (incl. a brand-new cued block not yet on the
    // server) BEFORE the reproject overwrites the doc's type attrs, and overlay them back — so a prose
    // merge never silently drops a type the user just declared (§2c-2 blocker), while a concurrent foreign
    // retype on a unit I didn't touch is preserved (intents-vs-baseline, not snapshot-all).
    const keepTypes = ports.docTypeIntents(baseline);
    prior.current = fresh;
    ports.seedCache(fresh);
    ports.reproject(plan.content, keepTypes);

    if (plan.rebasedDelta.upserts.length === 0 && plan.rebasedDelta.deletes.length === 0) {
      // nothing PROSE of mine to persist (e.g. my only change was a dropped reorder) — already in sync;
      // any pending type still drains via finishWithTypes.
      ports.seedCache(plan.content);
      prior.current = plan.content;
      mergeRetries = 0;
      return await finishWithTypes();
    }

    setStatus((s) => ({ ...s, saving: true, conflict: false }));
    try {
      await clearTypesForDeletes(plan.rebasedDelta.deletes); // typed-delete via the merge path → clear first
      if (disposed) return;
      const content = await ports.save({
        expected_revision: prior.current.revision,
        upserts: plan.rebasedDelta.upserts,
        deletes: plan.rebasedDelta.deletes,
      });
      if (disposed) return;
      prior.current = content;
      ports.seedCache(content);
      mergeRetries = 0;
      // The reprojected doc has the foreign units, so any typed-during-PUT edit is a normal delta; pending
      // types then drain + settle.
      await finishWithTypes();
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
    const hasProse = upserts.length > 0 || deletes.length > 0;
    const hasTypeOps = ports.docTypeNeeds(prior.current).length > 0; // sendable set_unit_type now

    if (!hasProse && !hasTypeOps) {
      // No NETWORK work this cycle. But a pending unpersisted type INTENT (a cued-but-empty block — the
      // model can't persist it until it has content) must keep its draft so the cue survives a reload;
      // else fully clean → clear. A clean doc never flips `saving` either way.
      semanticLatch = null; // doc returned to the server state
      if (ports.docTypeIntents(prior.current).length > 0) {
        ports.persistDraft();
        dirtyMirror = true;
        setStatus((s) => ({ ...s, dirty: true, error: false }));
      } else {
        ports.clearDraft();
        dirtyMirror = false;
        setStatus((s) => ({ ...s, dirty: false, error: false }));
      }
      return;
    }
    // The latch is a PROSE concept and gates only the prose SAVE: a type-only edit never lifts it, and a
    // latch hit still drains pending types (they're an independent axis).
    let proseLatched = false;
    if (hasProse && semanticLatch !== null) {
      if (ports.signature() === semanticLatch) {
        if (!hasTypeOps) return; // known-bad prose, unchanged, nothing else to do → don't re-send
        proseLatched = true; // skip the prose save, but still drain pending types
      } else {
        semanticLatch = null; // prose changed → worth another try
      }
    }
    busy = true;
    setStatus((s) => ({ ...s, saving: true }));
    try {
      if (hasProse && !proseLatched) {
        // A typed unit can't be deleted via save_content (§6.0a). Clear the type of any to-be-deleted typed
        // unit first → save_content then deletes the now-plain unit. (Shared with runMerge/drainTypes so a
        // typed-delete never 422s on any path.)
        await clearTypesForDeletes(deletes);
        if (disposed) return;
        const content = await ports.save({
          expected_revision: prior.current.revision,
          upserts,
          deletes,
        });
        prior.current = content; // ids are client-minted, so the doc stays anchored
        ports.seedCache(content);
      }
      // Reached by the saved-prose, the latched-prose, AND the type-only branches (a pure type change has
      // no prose delta and must NOT early-return before the drain). Drains pending types, then settles.
      await finishWithTypes(proseLatched);
    } catch (err) {
      // The prose `save` (or a clear-then-delete `setType`) can throw here; drainTypes/runMerge own theirs.
      if (classifyFlushError(err) === 'transient') {
        // network/5xx: while OFFLINE keep the calm "Offline" status (auto-flushes on reconnect); a
        // genuine online failure surfaces an error. Retries on next edit/online.
        ports.persistDraft();
        setStatus((s) => ({ ...s, saving: false, error: ports.isOnline() }));
        return; // finally clears busy
      }
      // conflict (409) OR semantic (4xx): the server may have advanced under us — a STALE delta is
      // rejected 422 BEFORE the 409 revision gate. runMerge fetches fresh and decides by revision:
      // advanced → merge (+ drain types); not advanced → genuine reject → latch. `busy` stays held.
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
      ports.reproject(found, []); // discard my unsaved changes AND pending type cues — show the server
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
