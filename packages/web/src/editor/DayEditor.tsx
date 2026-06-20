// The journal-day editor (slice 2c) — local-first autosave with a SAFE ADDITIVE MERGE on conflict.
// The IndexedDB DRAFT is the durability guarantee: every edit is persisted locally (~200ms) before the
// network, so it survives navigation, reload, and tab-close. The flush is debounced (800ms), SILENT in
// the happy path, and seeds the TanStack cache with the core's canonical echo so reopen is fresh.
// On a 409 (another tab/device wrote) we fetch fresh content and try `planMerge`: disjoint changes keep
// BOTH sides; a same-unit clash surfaces a CONFLICT (the user's work stays on screen + in the draft,
// auto-save pauses). We NEVER silently lose or clobber content. PM is a frontend adapter only (§6.0a).
import { useEffect, useRef, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useQueryClient } from '@tanstack/react-query';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import type { MathContent } from '@mathmeander/schema';
import { getJournalDay, saveContent, saveContentBeacon, type JournalDayEager } from '../api/client';
import { currentToken } from '../auth/store';
import { editorSchema } from './schema';
import { flushToContent, projectToDoc } from './projection';
import {
  clearDraft,
  getDraft,
  setDraft,
  type EditorDraft,
  CURRENT_DRAFT_VERSION,
} from './draftStore';
import { decideRestore } from './restore';
import { seedDayContent } from './cacheSeed';
import { planMerge } from './merge';
import { classifyFlushError } from './errorClass';
import { SaveStatusIndicator } from './SaveStatusIndicator';
import type { SaveState } from './saveStatus';

/** Stamp every new prose block (null `unitId`) with a fresh client-minted id (§6.3) so its identity
 *  is stable from creation — flush distinguishes new-vs-existing by id and never double-creates. */
const idStamper = new Plugin({
  appendTransaction(_trs, _oldState, newState) {
    let tr: ReturnType<typeof newState.tr.setNodeAttribute> | null = null;
    newState.doc.descendants((node, pos) => {
      if (node.type.name === 'prose' && node.attrs.unitId == null) {
        tr = (tr ?? newState.tr).setNodeAttribute(pos, 'unitId', uuidv7());
      }
    });
    return tr ?? null;
  },
});

const FLUSH_IDLE_MS = 800; // network sync debounce (the draft, not this, is durability)
const DRAFT_IDLE_MS = 200; // IndexedDB draft debounce — a draft exists within 200ms of typing
const MAX_MERGE_RETRIES = 3;

/** Does the restored draft still differ from the server content? (The one PM-touching restore bit.)
 *  An unparseable draft is treated as "equal" so decideRestore DISCARDS it rather than restoring junk. */
function draftEqualsServer(draft: EditorDraft, server: MathContent): boolean {
  try {
    const doc = Node.fromJSON(editorSchema, draft.doc as Parameters<typeof Node.fromJSON>[1]);
    const { upserts, deletes } = flushToContent(doc, server);
    return upserts.length === 0 && deletes.length === 0;
  } catch {
    return true;
  }
}

export function DayEditor({
  objectId,
  content,
  date,
}: {
  objectId: string;
  content: MathContent;
  date: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  // Conflict-resolution handlers, set by the effect and called from the conflict buttons' onClick.
  const conflictRef = useRef<{ takeTheirs: () => void; keepMine: () => void } | null>(null);
  const [status, setStatus] = useState<SaveState>(() => ({
    conflict: false,
    error: false,
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    saving: false,
    dirty: false,
  }));

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let view: EditorView | null = null;
    let timer: number | null = null; // network-flush debounce
    let drafter: number | null = null; // IndexedDB-draft debounce
    let busy = false; // single in-progress guard across the whole flush → merge / resolve chain
    let conflict = false; // a 409 we couldn't merge — auto-save paused until the user resolves
    let semanticLatch: string | null = null; // doc signature of a deterministically-rejected (4xx) save
    let mergeRetries = 0;
    let dirtyMirror = false; // closure mirror of `dirty` (read synchronously in the online handler)
    const prior = { current: content }; // the flush baseline (mount-time content, advanced per save)
    const setIf = (next: (s: SaveState) => SaveState) => {
      if (!cancelled) setStatus(next);
    };
    const docSig = (v: EditorView): string => JSON.stringify(v.state.doc.toJSON());
    const isOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

    const writeDraft = (v: EditorView) => {
      if (!currentToken()) return; // logged out — don't (re-)create a draft a sign-out just cleared
      void setDraft({
        version: CURRENT_DRAFT_VERSION,
        objectId,
        doc: v.state.doc.toJSON(),
        baseRevision: prior.current.revision,
        savedAt: Date.now(),
      });
    };

    const beaconFlush = (v: EditorView) => {
      const { upserts, deletes } = flushToContent(v.state.doc, prior.current);
      if (upserts.length === 0 && deletes.length === 0) return;
      saveContentBeacon(objectId, { expected_revision: prior.current.revision, upserts, deletes });
    };

    const seedCache = (next: MathContent) =>
      qc.setQueryData<JournalDayEager>(['journal', date], (prev) =>
        seedDayContent(prev, objectId, next),
      );

    /** Replace the live doc with `c` WITHOUT going through dispatchTransaction (no spurious dirty/flush);
     *  used after a merge to bring the merged content (incl. foreign units) on screen. Cursor resets. */
    const reproject = (c: MathContent) => {
      if (!view) return;
      const tr = view.state.tr
        .replaceWith(0, view.state.doc.content.size, projectToDoc(c).content)
        .setMeta('addToHistory', false);
      view.updateState(view.state.apply(tr));
    };

    const enterConflict = (v: EditorView) => {
      conflict = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      writeDraft(v); // keep the user's unsynced work
      setIf((s) => ({ ...s, saving: false, conflict: true }));
    };

    const scheduleFlush = (v: EditorView) => {
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => void flush(v), FLUSH_IDLE_MS);
    };

    const flush = async (v: EditorView): Promise<void> => {
      if (conflict || busy) return;
      const { upserts, deletes } = flushToContent(v.state.doc, prior.current);
      if (upserts.length === 0 && deletes.length === 0) {
        semanticLatch = null; // doc returned to the server state
        void clearDraft(objectId);
        dirtyMirror = false;
        setIf((s) => ({ ...s, dirty: false, error: false }));
        return;
      }
      if (semanticLatch !== null) {
        if (docSig(v) === semanticLatch) return; // known-bad delta, unchanged → don't re-send (no loop)
        semanticLatch = null; // doc changed → worth another try
      }
      busy = true;
      setIf((s) => ({ ...s, saving: true }));
      try {
        const outcome = await saveContent(objectId, {
          expected_revision: prior.current.revision,
          upserts,
          deletes,
        });
        prior.current = outcome.content; // ids are client-minted, so the doc stays anchored
        seedCache(outcome.content);
        // Did the user type more while the PUT was in flight? Keep the draft if so, else drop it.
        const after = flushToContent(v.state.doc, prior.current);
        const stillDirty = after.upserts.length > 0 || after.deletes.length > 0;
        if (stillDirty) writeDraft(v);
        else void clearDraft(objectId);
        dirtyMirror = stillDirty;
        setIf((s) => ({ ...s, saving: false, dirty: stillDirty, error: false }));
      } catch (err) {
        const cls = classifyFlushError(err);
        if (cls === 'transient') {
          // network/5xx: while OFFLINE keep the calm "Offline" status (auto-flushes on reconnect); a
          // genuine online failure surfaces an error. Retries on next edit/online.
          writeDraft(v);
          setIf((s) => ({ ...s, saving: false, error: isOnline() }));
          return; // finally clears busy
        }
        // conflict (409) OR semantic (4xx): the server may have advanced under us — a STALE delta is
        // rejected 422 (collides with newer content) BEFORE the 409 revision gate. runMerge fetches fresh
        // and decides: advanced → merge; not advanced → genuine reject → latch. `busy` stays held.
        await runMerge(v);
      } finally {
        busy = false;
      }
    };

    /** A 409 (or a stale-write 422), and the "Keep mine" resolution (`force`) → safe additive merge. We
     *  REPROJECT the merged content (incl. foreign units) into the doc while it's stable, then persist the
     *  rebased delta; the after-recompute then covers any typed-during-PUT edit. The CALLER owns `busy`. */
    const runMerge = async (v: EditorView, opts?: { force?: boolean }): Promise<void> => {
      const baseline = prior.current;
      let fresh: MathContent;
      try {
        const day = await getJournalDay(date);
        if (cancelled) return;
        const found = day.graph.content.find((c) => c.object_id === objectId);
        if (!found) return enterConflict(v);
        fresh = found;
      } catch {
        writeDraft(v); // transient (GET failed) — retry on next edit/online
        setIf((s) => ({ ...s, saving: false, error: isOnline() }));
        return;
      }
      if (cancelled) return;
      // Compute MY delta against the CURRENT doc (captures edits made during the GET) so a fast typist
      // doesn't burn the retry budget; the retry cap is then consumed only by genuine re-409 races.
      const mine = flushToContent(v.state.doc, baseline);

      if (fresh.revision <= baseline.revision && !opts?.force) {
        // The server did NOT advance → a GENUINE reject (not a stale-write race). Latch the offending doc
        // so we don't re-send it every keystroke; surface for review. (Forced keep-mine skips this.)
        mergeRetries = 0;
        writeDraft(v);
        semanticLatch = docSig(v);
        setIf((s) => ({ ...s, saving: false, error: true }));
        return;
      }

      const plan = planMerge({
        baseline,
        server: fresh,
        mine,
        ...(opts?.force ? { force: true } : {}),
      });
      if (plan.kind === 'conflict') return enterConflict(v);

      // Doc is stable → bring the merged content on screen and rebase the baseline to the fresh server.
      prior.current = fresh;
      seedCache(fresh);
      reproject(plan.content);

      if (plan.rebasedDelta.upserts.length === 0 && plan.rebasedDelta.deletes.length === 0) {
        // nothing of mine to persist (e.g. my only change was a dropped reorder) — already in sync.
        seedCache(plan.content);
        prior.current = plan.content;
        mergeRetries = 0;
        void clearDraft(objectId);
        dirtyMirror = false;
        setIf((s) => ({ ...s, saving: false, dirty: false, error: false, conflict: false }));
        return;
      }

      setIf((s) => ({ ...s, saving: true, conflict: false }));
      try {
        const outcome = await saveContent(objectId, {
          expected_revision: fresh.revision,
          upserts: plan.rebasedDelta.upserts,
          deletes: plan.rebasedDelta.deletes,
        });
        if (cancelled) return;
        prior.current = outcome.content;
        seedCache(outcome.content);
        mergeRetries = 0;
        // The reprojected doc has the foreign units, so any typed-during-PUT edit is a normal delta.
        const after = flushToContent(v.state.doc, prior.current);
        const stillDirty = after.upserts.length > 0 || after.deletes.length > 0;
        if (stillDirty) writeDraft(v);
        else void clearDraft(objectId);
        dirtyMirror = stillDirty;
        setIf((s) => ({ ...s, saving: false, dirty: stillDirty, error: false, conflict: false }));
      } catch (err) {
        if (classifyFlushError(err) === 'conflict') {
          if (mergeRetries >= MAX_MERGE_RETRIES) return enterConflict(v);
          mergeRetries += 1;
          return await runMerge(v, opts); // another writer raced — bounded retry, still inside `busy`
        }
        writeDraft(v);
        setIf((s) => ({ ...s, saving: false, error: isOnline() }));
      }
    };

    // Conflict resolution (the two buttons shown in the conflict state). Both take `busy` for their whole
    // span so a keystroke-scheduled flush can't interleave.
    const resolveTakeTheirs = async (): Promise<void> => {
      if (busy || !view) return;
      busy = true;
      setIf((s) => ({ ...s, saving: true }));
      try {
        const day = await getJournalDay(date);
        if (cancelled) return;
        const found = day.graph.content.find((c) => c.object_id === objectId);
        if (!found) {
          setIf((s) => ({ ...s, saving: false, error: true }));
          return;
        }
        prior.current = found;
        seedCache(found);
        reproject(found); // discard my unsaved changes, show the server version
        await clearDraft(objectId);
        conflict = false;
        mergeRetries = 0;
        semanticLatch = null;
        dirtyMirror = false;
        setIf((s) => ({ ...s, saving: false, conflict: false, dirty: false, error: false }));
      } catch {
        setIf((s) => ({ ...s, saving: false, error: isOnline() }));
      } finally {
        busy = false;
      }
    };

    const resolveKeepMine = async (): Promise<void> => {
      if (busy || !view) return;
      const v = view;
      busy = true;
      conflict = false; // resolving in my favor → let the (forced) merge proceed and re-sync
      setIf((s) => ({ ...s, saving: true, conflict: false }));
      try {
        await runMerge(v, { force: true });
      } finally {
        busy = false;
      }
    };
    conflictRef.current = {
      takeTheirs: () => void resolveTakeTheirs(),
      keepMine: () => void resolveKeepMine(),
    };

    const stampNullIds = (v: EditorView) => v.dispatch(v.state.tr); // triggers idStamper.appendTransaction

    const buildView = (doc: Node, immediateSync: boolean) => {
      view = new EditorView(mount, {
        state: EditorState.create({
          schema: editorSchema,
          doc,
          plugins: [
            history(),
            keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }),
            keymap(baseKeymap),
            idStamper,
          ],
        }),
        dispatchTransaction(tr) {
          if (!view) return;
          view.updateState(view.state.apply(tr));
          if (tr.docChanged) {
            const v = view;
            if (semanticLatch !== null) semanticLatch = null; // edited → the latched delta is stale
            dirtyMirror = true;
            setIf((s) => (s.dirty ? s : { ...s, dirty: true }));
            if (drafter != null) clearTimeout(drafter);
            drafter = window.setTimeout(() => writeDraft(v), DRAFT_IDLE_MS);
            if (!conflict) scheduleFlush(v); // in conflict, keep drafting locally but pause network sync
          }
        },
        handleDOMEvents: {
          blur: () => {
            if (!view) return false;
            if (timer != null) clearTimeout(timer);
            writeDraft(view);
            void flush(view);
            return false;
          },
        },
      });
      if (immediateSync) scheduleFlush(view);
    };

    // Restore-on-mount: prefer an unsynced local draft over the server projection; never auto-delete a
    // draft that still differs from the server (decideRestore: restore / conflict / discard).
    void (async () => {
      const draft = await getDraft(objectId);
      if (cancelled) return;
      const verdict = decideRestore(draft, content, draftEqualsServer);
      if ((verdict.action === 'restore' || verdict.action === 'conflict') && draft) {
        try {
          buildView(
            Node.fromJSON(editorSchema, draft.doc as Parameters<typeof Node.fromJSON>[1]),
            verdict.action === 'restore', // conflict: show the user's work but do NOT auto-sync
          );
          if (view) stampNullIds(view); // a draft captured mid-stamp could carry a null id
          dirtyMirror = true;
          if (verdict.action === 'conflict') {
            conflict = true;
            setIf((s) => ({ ...s, conflict: true, dirty: true }));
          } else {
            setIf((s) => ({ ...s, dirty: true }));
          }
          return;
        } catch {
          void clearDraft(objectId); // unparseable — fall back to the server projection
        }
      } else if (draft) {
        void clearDraft(objectId); // discard (equal / impossible-future) — safe to clear
      }
      buildView(projectToDoc(content), false);
    })();

    // Exit flush: best-effort keepalive PUT + a guaranteed local draft, when the page is going away.
    const onHide = () => {
      if (!view) return;
      writeDraft(view);
      beaconFlush(view);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    const onOnline = () => {
      setIf((s) => ({ ...s, offline: false }));
      if (dirtyMirror && !conflict && !busy && view) scheduleFlush(view); // flush pending edits on reconnect
    };
    const onOffline = () => setIf((s) => ({ ...s, offline: true }));
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      conflictRef.current = null;
      if (timer != null) clearTimeout(timer);
      if (drafter != null) clearTimeout(drafter);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (view) {
        writeDraft(view); // synchronous-intent backstop (IDB write may not finish on abrupt kill)
        beaconFlush(view);
        view.destroy();
      }
    };
    // Mount once per object/date; `content` is the mount-time baseline (later canonical state lives in
    // the closure's `prior`), so a post-save cache refresh does NOT tear down the live editor.
  }, [objectId, date, qc]);

  return (
    <div>
      <div ref={mountRef} className="day-editor" aria-label="day content" />
      <SaveStatusIndicator state={status} />
      {status.conflict && (
        <div className="conflict-actions" role="group" aria-label="resolve conflict">
          <p className="meta">
            This day changed elsewhere. “Load the latest” discards your unsaved changes — copy
            anything you want to keep first.
          </p>
          <button
            type="button"
            disabled={status.saving}
            onClick={() => conflictRef.current?.takeTheirs()}
          >
            Load the latest
          </button>
          <button
            type="button"
            disabled={status.saving}
            onClick={() => conflictRef.current?.keepMine()}
          >
            Keep mine
          </button>
        </div>
      )}
    </div>
  );
}
