// The journal-day editor (slice 2c-1): a ProseMirror view over a day's prose, flushing a coarse
// DELTA (`saveContent`) on a debounced idle + on blur. New prose blocks are stamped with a
// client-minted UUIDv7 the moment they appear (the `idStamper` plugin), so every block carries a
// stable identity — the next flush never re-creates it, and no re-projection (cursor loss) is needed
// after a save. PM is a frontend adapter only (§6.0a); all canonical meaning lives in `saveContent`.
import { useEffect, useRef, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import type { MathContent } from '@mathmeander/schema';
import { ApiError, saveContent } from '../api/client';
import { editorSchema } from './schema';
import { flushToContent, projectToDoc } from './projection';

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

const FLUSH_IDLE_MS = 800;

export function DayEditor({ objectId, content }: { objectId: string; content: MathContent }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const prior = { current: content }; // last-persisted canonical content (the flush baseline)
    let timer: number | null = null;
    let inFlight = false;

    const flush = async (view: EditorView) => {
      if (inFlight) return;
      const { upserts, deletes } = flushToContent(view.state.doc, prior.current);
      if (upserts.length === 0 && deletes.length === 0) return;
      inFlight = true;
      setSaving(true);
      try {
        const outcome = await saveContent(objectId, {
          expected_revision: prior.current.revision,
          upserts,
          deletes,
        });
        prior.current = outcome.content; // ids are client-minted, so the doc stays anchored — no re-project
      } catch (err) {
        if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') setConflict(true);
        else throw err;
      } finally {
        inFlight = false;
        setSaving(false);
      }
    };

    const view = new EditorView(mount, {
      state: EditorState.create({
        schema: editorSchema,
        doc: projectToDoc(content),
        plugins: [
          history(),
          keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }),
          keymap(baseKeymap),
          idStamper,
        ],
      }),
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) {
          if (timer != null) clearTimeout(timer);
          timer = window.setTimeout(() => void flush(view), FLUSH_IDLE_MS);
        }
      },
      handleDOMEvents: {
        blur: () => {
          if (timer != null) clearTimeout(timer);
          void flush(view);
          return false;
        },
      },
    });

    return () => {
      if (timer != null) clearTimeout(timer);
      view.destroy();
    };
    // Mount once per object; the parent keys this component by date so a new day remounts cleanly.
    // (`content` is the mount-time baseline; later canonical state lives in the closure's `prior`.)
  }, [objectId]);

  return (
    <div>
      <div ref={mountRef} className="day-editor" aria-label="day content" />
      {saving && <p className="meta">Saving…</p>}
      {conflict && (
        <p className="error">This day changed elsewhere — reload to continue (concurrent edit).</p>
      )}
    </div>
  );
}
