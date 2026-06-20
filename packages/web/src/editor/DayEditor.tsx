// The journal-day editor (slice 2c) — local-first autosave. The IndexedDB DRAFT is the durability
// guarantee: every edit is persisted locally (debounced ~200ms) before/independent of the network, so
// it survives fast navigation, reload, and tab-close. The server flush is debounced (800ms) and SILENT
// in the happy path; on success we seed the TanStack cache with the core's canonical echo so reopening
// the day is always fresh (the old "missing on first reopen" bug was a stale cache). A 409 is rebased
// and re-sent silently. A calm, persistent <SaveStatus> reflects state without the old per-cycle flash.
// PM is a frontend adapter only (§6.0a); all canonical meaning lives in `saveContent`.
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
import {
  ApiError,
  getJournalDay,
  saveContent,
  saveContentBeacon,
  type JournalDayEager,
} from '../api/client';
import { editorSchema } from './schema';
import { flushToContent, projectToDoc } from './projection';
import { clearDraft, getDraft, setDraft, type EditorDraft } from './draftStore';
import { decideRestore } from './restore';
import { seedDayContent } from './cacheSeed';
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
const MAX_CONFLICT_RETRIES = 3;

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
  const [status, setStatus] = useState<SaveState>(() => ({
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
    let inFlight = false;
    let conflictRetries = 0;
    const prior = { current: content }; // the flush baseline (mount-time content, advanced per save)
    const setIf = (next: (s: SaveState) => SaveState) => {
      if (!cancelled) setStatus(next);
    };

    const writeDraft = (v: EditorView) => {
      void setDraft({
        version: 1,
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

    const flush = async (v: EditorView): Promise<void> => {
      if (inFlight) return;
      const { upserts, deletes } = flushToContent(v.state.doc, prior.current);
      if (upserts.length === 0 && deletes.length === 0) {
        void clearDraft(objectId);
        setIf((s) => ({ ...s, dirty: false }));
        return;
      }
      inFlight = true;
      setIf((s) => ({ ...s, saving: true }));
      try {
        const outcome = await saveContent(objectId, {
          expected_revision: prior.current.revision,
          upserts,
          deletes,
        });
        prior.current = outcome.content; // ids are client-minted, so the doc stays anchored
        seedCache(outcome.content); // cache coherence → reopen is fresh, no refetch needed
        conflictRetries = 0;
        // Did the user type more while the PUT was in flight? Keep the draft if so, else drop it.
        const after = flushToContent(v.state.doc, prior.current);
        const stillDirty = after.upserts.length > 0 || after.deletes.length > 0;
        if (stillDirty) writeDraft(v);
        else void clearDraft(objectId);
        setIf((s) => ({ ...s, saving: false, dirty: stillDirty, error: false }));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
          inFlight = false; // allow the rebased re-flush
          await resolveConflict(v);
          return;
        }
        // 422 core-reject / network error: keep the draft, surface for review, do NOT loop.
        writeDraft(v);
        setIf((s) => ({ ...s, saving: false, error: true }));
      } finally {
        inFlight = false;
      }
    };

    // Silent 409 resolution (single-user last-write-wins): pull fresh server content, rebase the
    // baseline, re-flush the delta against it. Capped + backoff so it can't hot-loop.
    const resolveConflict = async (v: EditorView): Promise<void> => {
      if (conflictRetries >= MAX_CONFLICT_RETRIES) {
        writeDraft(v);
        setIf((s) => ({ ...s, saving: false, error: true }));
        return;
      }
      conflictRetries += 1;
      try {
        const fresh = await getJournalDay(date);
        if (cancelled) return;
        qc.setQueryData<JournalDayEager>(['journal', date], fresh);
        const freshDay = fresh.graph.content.find((c) => c.object_id === objectId);
        if (!freshDay) {
          writeDraft(v);
          setIf((s) => ({ ...s, saving: false, error: true }));
          return;
        }
        prior.current = freshDay;
        await new Promise((r) => setTimeout(r, 150 * conflictRetries));
        if (cancelled) return;
        await flush(v);
      } catch {
        writeDraft(v);
        setIf((s) => ({ ...s, saving: false, error: true }));
      }
    };

    const scheduleFlush = (v: EditorView) => {
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => void flush(v), FLUSH_IDLE_MS);
    };

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
            setIf((s) => (s.dirty ? s : { ...s, dirty: true }));
            if (drafter != null) clearTimeout(drafter);
            drafter = window.setTimeout(() => writeDraft(v), DRAFT_IDLE_MS);
            scheduleFlush(v);
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

    // Restore-on-mount: prefer an unsynced local draft over the server projection, else project.
    void (async () => {
      const draft = await getDraft(objectId);
      if (cancelled) return;
      const verdict = decideRestore(draft, content, draftEqualsServer);
      if (verdict.action === 'restore' && draft) {
        try {
          buildView(
            Node.fromJSON(editorSchema, draft.doc as Parameters<typeof Node.fromJSON>[1]),
            true,
          );
          setIf((s) => ({ ...s, dirty: true }));
          return;
        } catch {
          void clearDraft(objectId); // unparseable — fall back to the server projection
        }
      } else if (draft) {
        void clearDraft(objectId); // stale/equal draft — drop it
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
    const onOnline = () => setIf((s) => ({ ...s, offline: false }));
    const onOffline = () => setIf((s) => ({ ...s, offline: true }));
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
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
    </div>
  );
}
