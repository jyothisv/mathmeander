// The citation LIVE display — a `reference` atom RESOLVES its target and renders the target block's
// CURRENT designation ("Theorem 1") as a styled LINK, hiding the atom's stored `text` (which is only a
// fallback for an unresolvable target — cross-document or deleted). "Cite the identity, display the
// computed projection" — never a frozen string. Mirrors `mathLivePreview`: a decoration Plugin whose
// expensive part (the core numbering, via WASM) is cached in plugin state and recomputed only on a doc
// edit, so a pure caret move is cheap. Numbers come from the core (`numberingRuntime`) — single source.
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { displayLabels, type BlockInput, type HandleInput } from './numberingRuntime';
import { displayType } from './citePicker';
import { primaryName, type Name } from './names';
import { renderNameSource } from './renderName';

/** Cached citation-display inputs (recomputed on docChanged): the per-unit designation ("Theorem 1") and
 *  primary name, plus EVERY authored name by handle id (so a cite that pinned a specific alias shows it). */
interface RefState {
  designations: Map<string, string>; // unitId → "Theorem 1"
  primaryByUnit: Map<string, string>; // unitId → primary name SOURCE
  nameById: Map<string, string>; // handleId → name SOURCE (all names, for the chosen-alias display)
}
const KEY = new PluginKey<RefState>('referenceLivePreview');

/** Project the doc to the numbering input: ALL prose blocks (typed or not — the section tree must be
 *  complete for reading-order numbering), each with a per-parent `position`. Pure (no wasm). */
export function docBlocks(doc: PMNode): BlockInput[] {
  const blocks: BlockInput[] = [];
  const counters = new Map<string | null, number>();
  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const id = block.attrs.unitId as string | null;
    if (!id) return;
    const parent = (block.attrs.parentId as string | null) ?? null;
    const position = counters.get(parent) ?? 0;
    counters.set(parent, position + 1);
    blocks.push({
      id,
      type: (block.attrs.unitType as string | null) ?? null,
      parent_unit_id: parent,
      position,
    });
  });
  return blocks;
}

/** The PRIMARY authored name per typed block (from the `names` attr) → numbering's `Handle` input, so the
 *  core resolves it into `UnitLabel.name` (the name-first fallback when a cite doesn't pin a specific
 *  alias). Pure (no wasm). */
export function docHandles(doc: PMNode): HandleInput[] {
  const handles: HandleInput[] = [];
  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const id = block.attrs.unitId as string | null;
    if (!id || !block.attrs.unitType) return;
    const name = primaryName((block.attrs.names as Name[]) ?? []);
    if (name) handles.push({ target_unit_id: id, name });
  });
  return handles;
}

/** Compute the citation-display inputs from the doc + the core numbering (wasm). */
function computeState(doc: PMNode): RefState {
  const designations = new Map<string, string>();
  const primaryByUnit = new Map<string, string>();
  for (const l of displayLabels(docBlocks(doc), docHandles(doc))) {
    if (l.unit_type == null) continue;
    designations.set(
      l.unit_id,
      l.number != null ? `${displayType(l.unit_type)} ${l.number}` : displayType(l.unit_type),
    );
    if (l.name) primaryByUnit.set(l.unit_id, l.name);
  }
  const nameById = new Map<string, string>();
  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    for (const n of (block.attrs.names as Name[]) ?? []) if (n.name) nameById.set(n.id, n.name);
  });
  return { designations, primaryByUnit, nameById };
}

/** Scroll to (and place the caret at the start of) the prose block carrying `unitId`. */
function scrollToUnit(view: EditorView, unitId: string): void {
  let at: number | null = null;
  view.state.doc.forEach((block, offset) => {
    if (at === null && block.type.name === 'prose' && block.attrs.unitId === unitId) at = offset;
  });
  if (at != null) {
    const sel = TextSelection.near(view.state.doc.resolve(at + 1), 1);
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
    view.focus();
  }
}

function citationWidget(view: EditorView, source: string, unitId: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'reference-link';
  el.appendChild(renderNameSource(source)); // a chosen name may carry `$…$` → KaTeX; a number is plain text
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    scrollToUnit(view, unitId);
  });
  return el;
}

/** `selfObjectId` = the current document's object id: a same-document `Unit` target resolves to a live
 *  display — the CHOSEN name (the alias the cite pinned, §6.3b) → the unit's primary name → its number; any
 *  other target (an object, or a unit in another document) falls through to the atom's stored text. */
export function referenceLivePreview(opts: { selfObjectId: string }): Plugin<RefState> {
  return new Plugin<RefState>({
    key: KEY,
    state: {
      init: (_config, state) => computeState(state.doc),
      apply: (tr, value) => (tr.docChanged ? computeState(tr.doc) : value),
    },
    props: {
      decorations(state) {
        const st = KEY.getState(state);
        if (!st) return null;
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'reference') return;
          const target = node.attrs.target as {
            kind?: string;
            object_id?: string;
            unit_id?: string;
          } | null;
          if (!(target?.kind === 'unit' && target.object_id === opts.selfObjectId && target.unit_id)) {
            return; // not a same-doc unit → keep the atom's stored text (fallback)
          }
          const unitId = target.unit_id;
          const handleId = node.attrs.targetHandleId as string | null;
          // The chosen alias (reactive) → the unit's primary name → its number.
          const source =
            (handleId ? st.nameById.get(handleId) : undefined) ??
            st.primaryByUnit.get(unitId) ??
            st.designations.get(unitId);
          if (!source) return; // target block gone / no label → fallback to the atom's stored text
          decos.push(Decoration.node(pos, pos + 1, { class: 'reference-hidden' }));
          decos.push(
            Decoration.widget(pos, (view) => citationWidget(view, source, unitId), {
              side: -1,
              key: `refdisp:${unitId}:${handleId ?? ''}:${source}`, // re-renders when the shown name changes
            }),
          );
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
