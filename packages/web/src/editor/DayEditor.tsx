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
import { EditorState, Plugin, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands } from 'prosemirror-commands';
import { inputRules, InputRule, undoInputRule } from 'prosemirror-inputrules';
import { history, undo, redo } from 'prosemirror-history';
import type { MathContent, UnitType } from '@mathmeander/schema';
import {
  getJournalDay,
  saveContent,
  saveContentBeacon,
  setUnitType,
  type JournalDayEager,
} from '../api/client';
import { currentToken } from '../auth/store';
import { editorSchema } from './schema';
import { flushToContent, projectToDoc, typeNeeds, type TypeNeed } from './projection';
import {
  clearDraft,
  getDraft,
  setDraft,
  type EditorDraft,
  CURRENT_DRAFT_VERSION,
} from './draftStore';
import { decideRestore } from './restore';
import { seedDayContent } from './cacheSeed';
import { createAutosaveController } from './autosaveController';
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

// ── Type cues (slice 2c-2, §9.x InputEnvironment seed) ──────────────────────────────────────────────
// The first concrete InputEnvironment rule: a leading cue at block start (`Thm. ` / `Def: `) makes that
// unit that type — "the way Markdown turns `#` into a heading" (§9.y). Recognition is a frontend adapter;
// the type itself is applied by the canonical `set_unit_type` op (§6.0a) — the controller drains the
// node's `unitType` attr after the prose flush. Types are drawn from the generated `UnitType` union
// (never re-declared, §6.0a). Leading cue is the only gesture in 2c-2 (slash / select-then-mark later).
const CUE_MAP: Record<string, UnitType> = {
  Thm: 'theorem',
  Lem: 'lemma',
  Prop: 'proposition',
  Cor: 'corollary',
  Def: 'definition',
  Conj: 'conjecture',
  Claim: 'claim',
  Q: 'question',
  Pf: 'proof',
  Ex: 'example',
  Rmk: 'remark',
  Idea: 'idea',
  Note: 'note',
};
const CUE_RE = new RegExp(`^(${Object.keys(CUE_MAP).join('|')})[.:]\\s$`);

/** Recognize a leading cue the user just typed (the trailing space triggers it): strip the cue text and
 *  set the block's `unitType` attr. inputRules fire on typing only (no re-derive on reproject/re-render),
 *  and integrate with `undoInputRule` so an immediate Backspace restores the literal `Thm. ` text. */
const typeCueRule = new InputRule(CUE_RE, (state, match, start) => {
  const word = match[1];
  const type = word ? CUE_MAP[word] : undefined;
  if (!type) return null;
  const $start = state.doc.resolve(start);
  if ($start.parent.type.name !== 'prose' || $start.parentOffset !== 0) return null; // block start only
  const blockPos = $start.before();
  return state.tr
    .delete(start, start + match[0].length)
    .setNodeAttribute(blockPos, 'unitType', type);
});
const typeCueInputRules = inputRules({ rules: [typeCueRule] });

/** Backspace at the very start of a TYPED prose block clears its type back to plain (the owner's
 *  reversibility gesture). Returns false otherwise so the normal (undo-input-rule / merge) backspace runs. */
const clearTypeAtStart: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if ($cursor.parentOffset !== 0 || $cursor.parent.attrs.unitType == null) return false;
  if (dispatch) dispatch(state.tr.setNodeAttribute($cursor.before(), 'unitType', null));
  return true;
};

const FLUSH_IDLE_MS = 800; // network sync debounce (the draft, not this, is durability)
const DRAFT_IDLE_MS = 200; // IndexedDB draft debounce — a draft exists within 200ms of typing

/** Does the restored draft still differ from the server content? (The one PM-touching restore bit.)
 *  An unparseable draft is treated as "equal" so decideRestore DISCARDS it rather than restoring junk. */
function draftEqualsServer(draft: EditorDraft, server: MathContent): boolean {
  try {
    const doc = Node.fromJSON(editorSchema, draft.doc as Parameters<typeof Node.fromJSON>[1]);
    const { upserts, deletes } = flushToContent(doc, server);
    // A draft dirty ONLY by a pending type cue must NOT be judged equal (else it'd be discarded, losing
    // the cue) — type lives on a separate axis from the prose delta (§2c-2).
    return upserts.length === 0 && deletes.length === 0 && typeNeeds(doc, server).length === 0;
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
    const prior = { current: content }; // shared baseline (controller advances it; beacon/draft read it)
    const setIf = (next: (s: SaveState) => SaveState) => {
      if (!cancelled) setStatus(next);
    };
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
     *  used after a merge to bring the merged content (incl. foreign units) on screen. Cursor resets.
     *  `keepTypes` re-overlays my still-pending optimistic type cues so a prose merge (which carries only
     *  server types) never silently drops a type the user just declared (§2c-2). */
    const reproject = (c: MathContent, keepTypes: TypeNeed[]) => {
      if (!view) return;
      const tr = view.state.tr
        .replaceWith(0, view.state.doc.content.size, projectToDoc(c).content)
        .setMeta('addToHistory', false);
      if (keepTypes.length > 0) {
        const want = new Map(keepTypes.map((t) => [t.unitId, t.type]));
        tr.doc.descendants((node, pos) => {
          if (node.type.name === 'prose' && want.has(node.attrs.unitId as string)) {
            tr.setNodeAttribute(pos, 'unitType', want.get(node.attrs.unitId as string) ?? null);
          }
        });
      }
      view.updateState(view.state.apply(tr));
    };

    // The autosave/merge state machine (flush / runMerge / conflict resolution / latch / busy / retry-cap)
    // lives in the PURE controller; this effect is the ProseMirror/React/DOM adapter that supplies its
    // ports. `prior` is shared by identity so the beacon/draft writers see the controller's rebases.
    const ctl = createAutosaveController({
      objectId,
      prior,
      save: (body) => saveContent(objectId, body).then((o) => o.content),
      fetchFresh: async () => {
        const day = await getJournalDay(date);
        return day.graph.content.find((c) => c.object_id === objectId) ?? null;
      },
      delta: (baseline) =>
        view ? flushToContent(view.state.doc, baseline) : { upserts: [], deletes: [] },
      signature: () => (view ? JSON.stringify(view.state.doc.toJSON()) : ''),
      reproject,
      persistDraft: () => {
        if (view) writeDraft(view);
      },
      clearDraft: () => void clearDraft(objectId),
      seedCache,
      setType: (unitId, type, expectedRevision) =>
        setUnitType(objectId, {
          expected_revision: expectedRevision,
          unit_id: unitId,
          unit_type: type,
        }).then((o) => o.content),
      docTypeNeeds: (server) => (view ? typeNeeds(view.state.doc, server) : []),
      setStatus: setIf,
      cancelScheduledFlush: () => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      },
      isOnline,
      ready: () => view != null,
    });

    conflictRef.current = {
      takeTheirs: () => void ctl.resolveTakeTheirs(),
      keepMine: () => void ctl.resolveKeepMine(),
    };

    const scheduleFlush = () => {
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => void ctl.flush(), FLUSH_IDLE_MS);
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
            // Backspace: first undo a just-applied cue (restore literal text), else clear a typed block's
            // type at its start, else fall through to baseKeymap's normal backspace.
            keymap({ Backspace: chainCommands(undoInputRule, clearTypeAtStart) }),
            typeCueInputRules,
            keymap(baseKeymap),
            idStamper,
          ],
        }),
        dispatchTransaction(tr) {
          if (!view) return;
          view.updateState(view.state.apply(tr));
          if (tr.docChanged) {
            const v = view;
            const shouldFlush = ctl.noteEdit(); // clears latch, marks dirty; false while in conflict
            if (drafter != null) clearTimeout(drafter);
            drafter = window.setTimeout(() => writeDraft(v), DRAFT_IDLE_MS);
            if (shouldFlush) scheduleFlush(); // in conflict, keep drafting locally but pause network sync
          }
        },
        handleDOMEvents: {
          blur: () => {
            if (!view) return false;
            if (timer != null) clearTimeout(timer);
            writeDraft(view);
            void ctl.flush();
            return false;
          },
        },
      });
      if (immediateSync) scheduleFlush();
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
          ctl.noteRestored({ conflict: verdict.action === 'conflict' });
          if (verdict.action === 'conflict') {
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
      if (ctl.canFlushOnReconnect() && view) scheduleFlush(); // flush pending edits on reconnect
    };
    const onOffline = () => setIf((s) => ({ ...s, offline: true }));
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      ctl.dispose();
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
