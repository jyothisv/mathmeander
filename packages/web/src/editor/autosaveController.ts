// The slice-2c autosave/merge orchestration, extracted from DayEditor's useEffect into a PURE,
// node-testable controller. ProseMirror, the debounce timers, the DOM events and React stay in DayEditor
// (the adapter); everything reachable through the injected ports is deterministic and branch-testable
// without a browser. The hard invariant is unchanged: NEVER silently lose/clobber content — a 409 (or a
// stale-write 422) runs the additive merge (merge.ts); a same-unit clash surfaces a CONFLICT the user
// resolves ("Load the latest" / "Keep mine"). The controller owns the state machine; the e2e merge suite
// is the behaviour-preservation safety net.
import type { AnnotationDraft, MathContent, Unit, UnitType } from '@mathmeander/schema';
import { planMerge, type Delta } from './merge';
import { annotationSig } from './projection';
import type { NameNeed, StructuralIntent, StructuralNeed, TypeNeed } from './projection';
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
   *  overlays my still-pending optimistic type cues, and `keepStruct` my pending §B section gestures
   *  (heading-ness + parent), onto the reprojected doc — so a prose merge (which carries only server
   *  types/structure) never silently drops a type OR a section move the user just made (§2c-2 / §B). */
  reproject(content: MathContent, keepTypes: TypeNeed[], keepStruct: StructuralIntent[]): void;
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
  /** Issue a §B STRUCTURAL op at `expectedRevision`: a `toggle_heading` (the op infers promote/dissolve)
   *  or a `reparent_unit`; resolves to the canonical echo; throws ApiError (409 stale revision / 422 the
   *  target or new parent was concurrently changed). The third op-axis, after content + type. */
  applyStructural(need: StructuralNeed, expectedRevision: number): Promise<MathContent>;
  /** The SENDABLE structural delta vs `server` (= `structuralNeeds` over the live doc): toggle_heading /
   *  reparent ops for persisted units whose heading-ness or parent diverges. What `drainStructure` sends. */
  docStructuralNeeds(server: MathContent): StructuralNeed[];
  /** Issue the §6.3b `set_handle` op for one HANDLE (`name: ''` clears) at `expectedRevision`; resolves to
   *  the canonical content echo; throws ApiError. The fourth op-axis, after content + type + structure. */
  setHandle(
    handleId: string,
    unitId: string,
    name: string,
    expectedRevision: number,
  ): Promise<MathContent>;
  /** The SENDABLE name delta (= `nameNeeds`): persisted units whose `names` attr diverges from `sent`
   *  (the last-persisted name per HANDLE id). What `drainNames` can `set_handle` now. */
  docNameNeeds(
    server: MathContent,
    sent: Map<string, { unitId: string; name: string }>,
  ): NameNeed[];
  /** The handles already on the server at load (the baseline, keyed by HANDLE id) — seeds the running
   *  `sent` map so `drainNames` only fires on a real change. */
  initialNames?: Record<string, { unitId: string; name: string }>;
  /** POST the §6.2 annotation delta via `reconcile_annotations` (upserts + deletes). A SEPARATE aggregate:
   *  no host-revision gate/bump and no content echo (resolves void; `expectedRevision` rides only for the
   *  DTO). Optional — a surface without annotations omits it and the drain no-ops. The FIFTH op-axis. */
  applyAnnotations?(
    upserts: AnnotationDraft[],
    deletes: string[],
    expectedRevision: number,
  ): Promise<void>;
  /** The desired annotation set from the live doc (= `docAnnotationDrafts`). What `drainAnnotations` diffs
   *  against the `sent` baseline to compute upserts + deletes. */
  docAnnotationDrafts?(): AnnotationDraft[];
  /** The server's annotation baseline at load (annotationId → draft SIG, via `serverAnnotationSigs`) — seeds
   *  the running `sent` map so the drain fires only on a real change (and the empty doc doesn't spuriously
   *  delete every loaded annotation). */
  initialAnnotations?: Record<string, string>;
  /** My pending structural INTENTS vs `baseline` (= `structuralIntents`): incl. brand-new blocks. The
   *  keepStruct reproject overlay + the dirty/draft decision (a pending section gesture keeps the draft). */
  docStructuralIntents(baseline: MathContent): StructuralIntent[];
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
  /** Bounded retries for a structural op racing another writer before giving up to a conflict (default 3). */
  maxStructRetries?: number;
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
  /** Seed the ANNOTATION baseline (annotationId → sig) after the async annotation load resolves — so the
   *  first drain doesn't redundantly re-upsert the annotations already on the server (§6.2). */
  seedAnnotations(baseline: Record<string, string>): void;
  /** Mark the controller torn down — guards async continuations from writing after unmount. */
  dispose(): void;
}

export function createAutosaveController(ports: AutosavePorts): AutosaveController {
  const { prior } = ports;
  const MAX_MERGE_RETRIES = ports.maxMergeRetries ?? 3;
  const MAX_TYPE_RETRIES = ports.maxTypeRetries ?? 3;
  const MAX_STRUCT_RETRIES = ports.maxStructRetries ?? 3;
  const setStatus = ports.setStatus;
  // The running NAME baseline (last name persisted per HANDLE id → {unitId, name}), seeded from the loaded
  // handles. `drainNames` diffs the doc's `names` attrs against this; on a successful set_handle it advances.
  const sentNames = new Map<string, { unitId: string; name: string }>(
    Object.entries(ports.initialNames ?? {}),
  );
  // The running ANNOTATION baseline (last sig persisted per annotationId), seeded from the loaded annotations.
  // `drainAnnotations` diffs the doc's annotation drafts against this; on success it advances (§6.2).
  const sentAnnotations = new Map<string, string>(Object.entries(ports.initialAnnotations ?? {}));

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
    const structLeft = ports.docStructuralIntents(prior.current).length > 0;
    const namesLeft = ports.docNameNeeds(prior.current, sentNames).length > 0;
    const anno = pendingAnnotations();
    const annosLeft = anno.upserts.length > 0 || anno.deletes.length > 0;
    const stillDirty = proseLeft || typesLeft || structLeft || namesLeft || annosLeft;
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
        const keepStruct = ports.docStructuralIntents(baseline); // my pending §B section gestures, preserved
        prior.current = fresh;
        ports.seedCache(fresh);
        ports.reproject(plan.content, keep, keepStruct);
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

  /** Apply pending STRUCTURAL changes (3b §B) via `toggle_heading` / `reparent_unit`, AFTER the prose part
   *  of a sync. Stateless + idempotent: recompute `docStructuralNeeds` each pass (toggles ordered before
   *  reparents — a body reparents UNDER a heading only once that unit IS one, §B parent-capability), apply
   *  each sequentially at the current revision (each op bumps it). On a 409/422 → re-anchor by MERGING fresh
   *  (preserving my unflushed prose AND my pending type + structural intents), then loop to retry at the new
   *  revision; bounded retries → conflict. A transient failure DEFERS (draft kept, retried next flush).
   *  Structure NEVER rides the prose delta (§6.0a freezes parent/kind). The CALLER owns `busy`. The
   *  structure-axis twin of `drainTypes`. */
  const drainStructure = async (): Promise<'done' | 'deferred' | 'conflict'> => {
    for (let attempt = 0; attempt <= MAX_STRUCT_RETRIES; attempt += 1) {
      const needs = ports.docStructuralNeeds(prior.current);
      if (needs.length === 0) return 'done';
      try {
        for (const need of needs) {
          const content = await ports.applyStructural(need, prior.current.revision);
          if (disposed) return 'done';
          prior.current = content;
          ports.seedCache(content);
        }
        return 'done';
      } catch (err) {
        if (disposed) return 'done';
        if (classifyFlushError(err) === 'transient') return 'deferred'; // retried next flush/reconnect
        // 409/422: another writer advanced the revision (or changed the target/parent). Re-anchor by merging
        // fresh — preserving my unflushed prose AND my pending type + structural intents — then loop to retry
        // at the new revision. (Self-contained; mirrors drainTypes' merge step.)
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
          // The server did NOT advance → a deterministic structural reject (e.g. a reparent the current tree
          // can't accept), not a race. Surface (don't loop to the retry cap → conflict); retried on the next
          // real edit. (Mirrors the prose latch / the type-axis deterministic-reject branch.)
          return 'deferred';
        }
        const plan = planMerge({ baseline, server: fresh, mine: ports.delta(baseline) });
        if (plan.kind === 'conflict') {
          enterConflict();
          return 'conflict';
        }
        const keepTypes = ports.docTypeIntents(baseline);
        const keepStruct = ports.docStructuralIntents(baseline); // my pending §B gestures, preserved
        prior.current = fresh;
        ports.seedCache(fresh);
        ports.reproject(plan.content, keepTypes, keepStruct);
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
        // loop: recompute docStructuralNeeds(prior.current) and retry at the advanced revision
      }
    }
    enterConflict(); // exhausted the structural-retry budget under repeated races
    return 'conflict';
  };

  /** Apply pending NAME changes (§6.3b) via `set_handle`, AFTER content/structure/type. A name is a
   *  low-stakes, idempotent overlay on a persisted unit, so this is the SIMPLEST drain: apply each need
   *  sequentially at the current revision (each op bumps it), advancing the `sent` baseline; on ANY error
   *  (transient OR a race) DEFER — the draft keeps the `[name]` marker and the next flush re-drains (after
   *  the content merge re-anchors the revision). The name NEVER rides the prose delta (the flush strips the
   *  marker). The CALLER owns `busy`. */
  const drainNames = async (): Promise<'done' | 'deferred'> => {
    const needs = ports.docNameNeeds(prior.current, sentNames);
    if (needs.length === 0) return 'done';
    try {
      for (const need of needs) {
        const content = await ports.setHandle(
          need.handleId,
          need.unitId,
          need.name,
          prior.current.revision,
        );
        if (disposed) return 'done';
        prior.current = content;
        ports.seedCache(content);
        if (need.name) sentNames.set(need.handleId, { unitId: need.unitId, name: need.name });
        else sentNames.delete(need.handleId);
      }
      return 'done';
    } catch {
      if (disposed) return 'done';
      return 'deferred'; // transient OR a revision race — the draft keeps the marker; next flush retries
    }
  };

  /** The annotation upserts/deletes SENDABLE now vs the `sent` baseline — the drain input AND the flush/dirty
   *  gate (§6.2). Upserts = doc drafts whose sig moved AND whose bound unit is already on the server; deletes =
   *  sent ids no longer in the doc. An upsert whose `target_unit_id` isn't yet persisted is SKIPPED here (the
   *  `typeNeeds` skip-not-yet-persisted idiom) so `reconcile_annotations` never 422s on a missing unit — it
   *  drains cleanly on a later flush once `save_content` created the unit. The doc stays dirty meanwhile via the
   *  content delta that will create that unit. Pure. */
  const pendingAnnotations = (): { upserts: AnnotationDraft[]; deletes: string[] } => {
    if (!ports.docAnnotationDrafts) return { upserts: [], deletes: [] };
    const drafts = ports.docAnnotationDrafts();
    const desiredIds = new Set(drafts.map((d) => d.annotation_id));
    const onServer = new Set(prior.current.units.map((u) => u.id));
    const upserts = drafts.filter(
      (d) =>
        sentAnnotations.get(d.annotation_id) !== annotationSig(d) &&
        d.targets.every((t) => onServer.has(t.target_unit_id)),
    );
    const deletes = [...sentAnnotations.keys()].filter((id) => !desiredIds.has(id));
    return { upserts, deletes };
  };

  /** Apply pending ANNOTATION changes (§6.2) via `reconcile_annotations`, AFTER content/structure/type/name.
   *  Annotations are a SEPARATE, self-healing aggregate with NO host-revision gate, so this is the SIMPLEST
   *  drain (even simpler than names): send the diff, advance the `sent` baseline on success, and DEFER on ANY
   *  error — a 422 for a target on a not-yet-persisted unit self-corrects on the next flush (the content drain
   *  ran first, so by then the unit exists). A broken sub-anchor is not an error here: the server keeps it as
   *  `stale`. The annotation NEVER rides the prose delta. The CALLER owns `busy`. */
  const drainAnnotations = async (): Promise<'done' | 'deferred'> => {
    if (!ports.applyAnnotations) return 'done';
    const { upserts, deletes } = pendingAnnotations();
    if (upserts.length === 0 && deletes.length === 0) return 'done';
    try {
      await ports.applyAnnotations(upserts, deletes, prior.current.revision);
      if (disposed) return 'done';
      for (const d of upserts) sentAnnotations.set(d.annotation_id, annotationSig(d));
      for (const id of deletes) sentAnnotations.delete(id);
      return 'done';
    } catch {
      if (disposed) return 'done';
      return 'deferred'; // transient, a race, OR a not-yet-persisted target — the draft holds; next flush retries
    }
  };

  /** Shared success tail of flush + runMerge: drain pending STRUCTURE, then TYPES, then settle the status
   *  (unless a drain ended in a conflict, which already set it). Structure FIRST: a unit must become a
   *  heading before a child reparents under it (§B parent-capability), and a reparent's target only exists
   *  once the prose flush created it. `proseLatched` keeps `error:true` while a known-bad prose delta is
   *  still pending (we drained the secondary axes past it but the prose remains rejected). */
  const finishWithSecondaryOps = async (proseLatched = false): Promise<void> => {
    const structBaseline = prior.current; // the server state the doc's pending §B gestures are relative to
    const structOutcome = await drainStructure();
    if (structOutcome === 'conflict') return; // enterConflict already set the status
    // A structural op can have SIDE EFFECTS on units the user did NOT gesture on: toggle_heading DISSOLVE
    // lifts the former heading's children to its parent server-side. The doc still shows those children
    // under the (now-prose) former heading, so the next pass would re-POST a phantom reparent UNDER a prose
    // unit → a deterministic 422 every flush (an autosave WEDGE). When the drain fully succeeded yet leaves
    // RESIDUAL needs, reproject to ADOPT those server-side moves — preserving the user's OWN pending gestures
    // (intents vs the PRE-drain baseline), so a non-gestured lifted child is taken from the server, not
    // re-sent. A pure promote/reparent has no such residual → no reproject → the cursor is undisturbed.
    if (structOutcome === 'done' && ports.docStructuralNeeds(prior.current).length > 0) {
      ports.reproject(
        prior.current,
        ports.docTypeIntents(structBaseline),
        ports.docStructuralIntents(structBaseline),
      );
    }
    const typeOutcome = await drainTypes();
    if (typeOutcome === 'conflict') return;
    const nameOutcome = await drainNames();
    // Annotations LAST: a self-healing separate aggregate that needs the bound units already persisted
    // (content drained above) so a sub-term/phrase target resolves rather than 422-ing (§6.2). Its outcome is
    // DELIBERATELY excluded from the content-`error` decision below: annotations never gate the host revision,
    // so a deferred annotation is NOT a "Couldn't save" — it stays `dirty` (settleAfterFlush counts annosLeft)
    // and retries quietly on the next flush. Only content/structure/type/name deferrals are real save errors.
    await drainAnnotations();
    const deferred =
      structOutcome === 'deferred' || typeOutcome === 'deferred' || nameOutcome === 'deferred';
    settleAfterFlush(proseLatched ? true : deferred ? ports.isOnline() : false);
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
    const keepStruct = ports.docStructuralIntents(baseline); // my pending §B section gestures, preserved
    prior.current = fresh;
    ports.seedCache(fresh);
    ports.reproject(plan.content, keepTypes, keepStruct);

    if (plan.rebasedDelta.upserts.length === 0 && plan.rebasedDelta.deletes.length === 0) {
      // nothing PROSE of mine to persist (e.g. my only change was a dropped reorder) — already in sync;
      // any pending structure/type still drains via finishWithSecondaryOps.
      ports.seedCache(plan.content);
      prior.current = plan.content;
      mergeRetries = 0;
      return await finishWithSecondaryOps();
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
      // structure + types then drain + settle.
      await finishWithSecondaryOps();
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
    const hasStructOps = ports.docStructuralNeeds(prior.current).length > 0; // sendable toggle/reparent now
    const anno = pendingAnnotations();
    const hasAnnoOps = anno.upserts.length > 0 || anno.deletes.length > 0; // sendable reconcile_annotations now

    if (!hasProse && !hasTypeOps && !hasStructOps && !hasAnnoOps) {
      // No NETWORK work this cycle. But a pending unpersisted INTENT (a cued-but-empty block, or a section
      // gesture on a not-yet-persisted unit) must keep its draft so it survives a reload; else fully clean →
      // clear. A clean doc never flips `saving` either way.
      semanticLatch = null; // doc returned to the server state
      const intentsPending =
        ports.docTypeIntents(prior.current).length > 0 ||
        ports.docStructuralIntents(prior.current).length > 0;
      if (intentsPending) {
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
    // The latch is a PROSE concept and gates only the prose SAVE: a type/section-only edit never lifts it,
    // and a latch hit still drains the secondary axes (structure + types are independent).
    let proseLatched = false;
    if (hasProse && semanticLatch !== null) {
      if (ports.signature() === semanticLatch) {
        if (!hasTypeOps && !hasStructOps) return; // known-bad prose, unchanged, nothing else → don't re-send
        proseLatched = true; // skip the prose save, but still drain pending structure + types
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
      // Reached by the saved-prose, the latched-prose, AND the secondary-only branches (a pure type/section
      // change has no prose delta and must NOT early-return before the drain). Drains structure + types,
      // then settles.
      await finishWithSecondaryOps(proseLatched);
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
      ports.reproject(found, [], []); // discard my unsaved changes AND pending type/section cues — show server
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

  const seedAnnotations = (baseline: Record<string, string>): void => {
    sentAnnotations.clear();
    for (const [id, sig] of Object.entries(baseline)) sentAnnotations.set(id, sig);
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
    seedAnnotations,
    dispose,
  };
}
