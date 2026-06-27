// The journal-day editor (slice 2c) — local-first autosave with a SAFE ADDITIVE MERGE on conflict.
// The IndexedDB DRAFT is the durability guarantee: every edit is persisted locally (~200ms) before the
// network, so it survives navigation, reload, and tab-close. The flush is debounced (800ms), SILENT in
// the happy path, and seeds the TanStack cache with the core's canonical echo so reopen is fresh.
// On a 409 (another tab/device wrote) we fetch fresh content and try `planMerge`: disjoint changes keep
// BOTH sides; a same-unit clash surfaces a CONFLICT (the user's work stays on screen + in the draft,
// auto-save pauses). We NEVER silently lose or clobber content. PM is a frontend adapter only (§6.0a).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands } from 'prosemirror-commands';
import { inputRules } from 'prosemirror-inputrules';
import { history, undo, redo } from 'prosemirror-history';
import type { MathContent, MathpackGraph } from '@mathmeander/schema';
import {
  saveContent,
  saveContentBeacon,
  setUnitType,
  reparentUnit,
  toggleHeading,
} from '../api/client';
import { currentToken } from '../auth/store';
import { editorSchema } from './schema';
import {
  flushToContent,
  projectToDoc,
  typeNeeds,
  typeIntents,
  structuralNeeds,
  structuralIntents,
  type StructuralIntent,
  type TypeNeed,
} from './projection';
import {
  cueRule,
  headingCueRule,
  displayCueRule,
  clearTypeAtStart,
  displayEnter,
  headingEnter,
  enterParagraph,
  exitTypedUnit,
  guardConfigMerge,
  guardConfigMergeForward,
  guardDisplayMerge,
  guardDisplayMergeForward,
  guardHeadingMergeForward,
  insertHardBreak,
  mergeIntoPrevious,
} from './cues';
import { idStamper } from './idStamper';
import { activeUnit } from './activeUnit';
import { mathRecognize } from './mathRecognize';
import { markRecognize } from './markRecognize';
import { markLivePreview } from './markLivePreview';
import { headingRecognize } from './headingRecognize';
import { headingLivePreview } from './headingLivePreview';
import { headingIndent } from './headingIndent';
import { headingFold } from './headingFold';
import { formattingKeymap } from './markKeys';
import { changeHeadingDepth } from './headingDepth';
import { wrapSelectionAsMath } from './mathWrap';
import { transformPastedSlice, guardAtomicPaste, guardAtomicDrop } from './paste';
import { mathLivePreview } from './mathLivePreview';
import { mathBackspace, mathDelete } from './mathKeys';
import {
  clearDraft,
  getDraft,
  setDraft,
  type EditorDraft,
  CURRENT_DRAFT_VERSION,
} from './draftStore';
import { decideRestore } from './restore';
import { seedEagerContent } from './cacheSeed';
import { createAutosaveController } from './autosaveController';
import { SaveStatusIndicator } from './SaveStatusIndicator';
import type { SaveState } from './saveStatus';

const FLUSH_IDLE_MS = 800; // network sync debounce (the draft, not this, is durability)
const DRAFT_IDLE_MS = 200; // IndexedDB draft debounce — a draft exists within 200ms of typing

/** Does the restored draft still differ from the server content? (The one PM-touching restore bit.)
 *  An unparseable draft is treated as "equal" so decideRestore DISCARDS it rather than restoring junk. */
function draftEqualsServer(draft: EditorDraft, server: MathContent): boolean {
  try {
    const doc = Node.fromJSON(editorSchema, draft.doc as Parameters<typeof Node.fromJSON>[1]);
    const { upserts, deletes } = flushToContent(doc, server);
    // A draft dirty ONLY by a pending type INTENT (incl. an unpersisted cued-but-empty block) must NOT be
    // judged equal — else it'd be discarded on restore, losing the cue. `typeIntents` (vs the server),
    // unlike `typeNeeds`, does not skip not-yet-persisted blocks. Type is a separate axis (§2c-2).
    return (
      upserts.length === 0 &&
      deletes.length === 0 &&
      typeIntents(doc, server).length === 0 &&
      structuralIntents(doc, server).length === 0 // a pending §B section gesture also keeps the draft
    );
  } catch {
    return true;
  }
}

/** The surface-specific bits the editor needs — so the SAME editor serves a journal day OR a notebook.
 *  `key` is a stable identity (date / slug) for the mount effect; `cacheKey` is where the canonical echo is
 *  seeded after a save; `fetchEager` re-reads the object + subgraph on a 409 conflict. */
export interface EditorSurface {
  key: string;
  cacheKey: readonly unknown[];
  fetchEager: () => Promise<{ graph: MathpackGraph }>;
}

export function DayEditor({
  objectId,
  content,
  surface,
}: {
  objectId: string;
  content: MathContent;
  surface: EditorSurface;
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
      qc.setQueryData<{ graph: MathpackGraph }>(surface.cacheKey, (prev) =>
        seedEagerContent(prev, objectId, next),
      );

    /** Replace the live doc with `c` WITHOUT going through dispatchTransaction (no spurious dirty/flush);
     *  used after a merge to bring the merged content (incl. foreign units) on screen. Cursor resets.
     *  `keepTypes` re-overlays my still-pending optimistic type cues, and `keepStruct` my pending §B
     *  section gestures (heading-ness + parent), so a prose merge (which carries only server types/
     *  structure) never silently drops a type OR a section move the user just made (§2c-2 / §B). */
    const reproject = (c: MathContent, keepTypes: TypeNeed[], keepStruct: StructuralIntent[]) => {
      if (!view) return;
      const tr = view.state.tr
        .replaceWith(0, view.state.doc.content.size, projectToDoc(c).content)
        .setMeta('addToHistory', false);
      if (keepTypes.length > 0 || keepStruct.length > 0) {
        const wantType = new Map(keepTypes.map((t) => [t.unitId, t.type]));
        const wantStruct = new Map(keepStruct.map((s) => [s.unitId, s]));
        tr.doc.descendants((node, pos) => {
          if (node.type.name !== 'prose') return;
          const id = node.attrs.unitId as string;
          if (wantType.has(id)) tr.setNodeAttribute(pos, 'unitType', wantType.get(id) ?? null);
          const s = wantStruct.get(id);
          if (s) {
            tr.setNodeAttribute(pos, 'heading', s.heading);
            tr.setNodeAttribute(pos, 'parentId', s.parentId);
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
        const eager = await surface.fetchEager();
        return eager.graph.content.find((c) => c.object_id === objectId) ?? null;
      },
      delta: (baseline) =>
        view ? flushToContent(view.state.doc, baseline) : { upserts: [], deletes: [] },
      // PROSE-only signature: drop the `unitType` attr so a type-only edit can't lift a prose latch.
      signature: () =>
        view
          ? JSON.stringify(view.state.doc.toJSON(), (k, v) => (k === 'unitType' ? undefined : v))
          : '',
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
      docTypeIntents: (baseline) => (view ? typeIntents(view.state.doc, baseline) : []),
      applyStructural: (need, expectedRevision) =>
        (need.op === 'toggle_heading'
          ? toggleHeading(objectId, { expected_revision: expectedRevision, unit_id: need.unitId })
          : reparentUnit(objectId, {
              expected_revision: expectedRevision,
              unit_id: need.unitId,
              new_parent_unit_id: need.newParentId,
              new_position: need.newPosition,
            })
        ).then((o) => o.content),
      docStructuralNeeds: (server) => (view ? structuralNeeds(view.state.doc, server) : []),
      docStructuralIntents: (baseline) => (view ? structuralIntents(view.state.doc, baseline) : []),
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
            // Backspace: at the start of a TYPED unit → clear type (peel); at the start of a PLAIN unit →
            // merge into the previous unit; next to a `$…$` equation → a controlled single-char delete
            // (mathBackspace) so native deletion next to the rendered math's hidden source can't destroy the
            // whole equation. Otherwise falls through to baseKeymap's native char delete. Delete (forward) gets
            // the mirror guard (mathDelete). Both are placed before baseKeymap so they pre-empt native.
            keymap({
              // guardConfigMerge/guardDisplayMerge refuse a join that would dissolve a notation-home / `$$…$$`
              // block (both atomic for block joins); else clear type / soft-break-merge / single-char
              // math-boundary delete, then native.
              Backspace: chainCommands(
                clearTypeAtStart,
                guardConfigMerge,
                guardDisplayMerge,
                mergeIntoPrevious,
                mathBackspace,
              ),
            }),
            keymap({
              Delete: chainCommands(
                guardConfigMergeForward,
                guardDisplayMergeForward,
                guardHeadingMergeForward,
                mathDelete,
              ),
            }),
            // Enter — paragraph model: a soft line on a non-empty line; a blank line makes a new unit in
            // plain prose but a paragraph break inside a typed unit (2nd consecutive blank exits it).
            // Shift-Enter is always a soft line break; ⌘/Ctrl-Enter finishes a unit and starts a new one.
            keymap({
              // displayEnter pre-empts inside a `$$…$$` equation; headingEnter pre-empts in a §B heading
              // (Enter spawns a body unit flowing UNDER the title, never a soft break). Else the paragraph model.
              Enter: chainCommands(displayEnter, headingEnter, enterParagraph),
              'Shift-Enter': insertHardBreak,
              'Mod-Enter': exitTypedUnit,
            }),
            // Inline-formatting shortcuts (Mod-b/i/`, Shift-Mod-x): insert/toggle the markdown delimiters;
            // markRecognize applies the styling from them (delimiters are never consumed — keyboard-friendly,
            // no hidden text). Before baseKeymap so Mod-b etc. aren't shadowed.
            keymap(formattingKeymap),
            // §B outline (3c): Tab / Shift-Tab change a heading's depth (indent/outdent the section) by
            // rewriting the `#` prefix of the whole subtree; the recognizer + structural drain reparent it.
            // Falls through (no-op) outside a heading, so Tab elsewhere is unaffected.
            keymap({ Tab: changeHeadingDepth(1), 'Shift-Tab': changeHeadingDepth(-1) }),
            // Input rules (ONE plugin — PM fires only one inputRules plugin's handleTextInput): the type cue
            // (`Thm.` etc.); the `# `/`## ` heading cue and the `$$…$$` display cue, which SPLIT the line onto
            // its own block so the construct is recognized on ANY line, not just a block's first (the rules are
            // disjoint — word vs `#` vs the closing `$$`). Inline `$…$` still needs no rule (mathRecognize scans).
            inputRules({ rules: [cueRule, headingCueRule, displayCueRule] }),
            keymap(baseKeymap),
            idStamper,
            headingRecognize, // scan a block's leading `#`×n → set heading/parentId (depth); demote when gone
            mathRecognize, // scan `$…$`/`$$…$$` text → the mathExpr identity mark + synced expr (skips headings)
            markRecognize, // scan `**…**`/`*…*`/`~~…~~`/`` `…` `` → the styled mark (after math; math wins)
            headingLivePreview, // hide the `#` prefix when the caret is out of the heading; dim it when in
            headingIndent, // indent each block by its section depth (view-only; from the parentId chain)
            headingFold, // collapse/expand a section (chevron widget hides descendants; view-only)
            mathLivePreview, // render KaTeX over a marked span (inline on caret-out; display always, centered)
            markLivePreview, // hide the markdown delimiters when the caret is out; reveal on touch (like math)
            activeUnit,
          ],
        }),
        // Type `$` over a SELECTION → wrap it in `$…$` (a 2nd `$` over an inline equation → `$$…$$` display).
        // A direct view prop so it runs BEFORE the inputRules plugin; an empty selection returns false (the
        // `$` types normally, and the display cue / inline recognizer handle a hand-typed `$$…$$`/`$…$`).
        handleTextInput(_view, _from, _to, text) {
          if (text !== '$' || !view) return false;
          return wrapSelectionAsMath(view.state, view.dispatch.bind(view));
        },
        // Re-segment a paste into clean whole blocks so `# `/`$$…$$` land as units (not inline text) and a
        // multi-block paste splits the target instead of merging — recognizers re-apply identity from source.
        transformPasted: (slice) => transformPastedSlice(slice),
        // A block-level paste must NEVER split an atomic block (a heading — whose hidden `# ` prefix traps a
        // visual-start click PAST the prefix, so a split would sever it into a stray empty heading + demote
        // the title — or a `$$…$$` equation). Redirect such a paste to the block boundary. Runs after
        // transformPasted, before the default replaceSelection; returns false (default) when there's no risk.
        handlePaste(_view, _event, slice) {
          if (!view) return false;
          const tr = guardAtomicPaste(view.state, slice);
          if (!tr) return false;
          view.dispatch(tr);
          return true;
        },
        // Drag-drop reuses the same closed-slice path as paste, so it can split an atomic block the same way.
        // Guard it at the DROP POINT (handleDrop is otherwise unwired → default behaviour would corrupt).
        handleDrop(_view, event, slice, moved) {
          if (!view) return false;
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!at) return false;
          const tr = guardAtomicDrop(view.state, slice, at.pos, moved);
          if (!tr) return false;
          view.dispatch(tr);
          return true;
        },
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
    // Mount once per object/surface; `content` is the mount-time baseline (later canonical state lives in
    // the closure's `prior`), so a post-save cache refresh does NOT tear down the live editor. `surface` is
    // memoized by the page (stable per date/slug), so this re-mounts only on a genuine surface switch.
  }, [objectId, surface, qc]);

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
