// §B outline editing (slice 3c-4) — SECTION FOLDING (collapse/expand a heading's body + subsections).
// PURELY a view concern: fold state lives in this plugin (a Set of folded heading unitIds), NEVER in the
// canonical content. A chevron widget at each foldable heading toggles it; folding hides the heading's
// descendant blocks (display:none decorations). Caret safety: folding relocates a caret that was inside the
// subtree onto the heading, and an appendTransaction auto-unfolds if the selection otherwise lands in a
// hidden block. Fold state is keyed by unitId so it survives a reproject (and is pruned when a heading is
// demoted/removed).
import { type Command, type EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { headingIndex } from './cues';
import { isDescendantOf } from './headingDepth';

interface FoldState {
  folded: Set<string>;
  decos: DecorationSet;
}
interface FoldMeta {
  toggle?: string;
  unfold?: string[];
}
const KEY = new PluginKey<FoldState>('headingFold');

/** The descendant blocks (pos + size) of a heading — its body + subsections — by the `parentId` chain. */
export function descendantBlocks(
  doc: PMNode,
  headingId: string,
  byId: Map<string, PMNode>,
): { pos: number; size: number }[] {
  const out: { pos: number; size: number }[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name === 'prose' && isDescendantOf(block, headingId, byId)) {
      out.push({ pos: offset, size: block.nodeSize });
    }
  });
  return out;
}

/** The folded heading ids that are ANCESTORS of `block` (so its content is hidden) — for caret safety. */
function foldedAncestorsOf(block: PMNode, folded: Set<string>, byId: Map<string, PMNode>): string[] {
  const out: string[] = [];
  let pid = block.attrs.parentId as string | null;
  const guard = new Set<string>();
  while (pid && !guard.has(pid)) {
    if (folded.has(pid)) out.push(pid);
    guard.add(pid);
    pid = (byId.get(pid)?.attrs.parentId as string | null) ?? null;
  }
  return out;
}

/** The doc positions hidden by the current fold set (a heading's descendants when it's folded). Exported
 *  for testing the hide computation without a DOM. */
export function foldedHiddenPositions(doc: PMNode, folded: Set<string>): number[] {
  const byId = headingIndex(doc);
  const hidden: number[] = [];
  for (const id of folded) {
    if (!(byId.get(id)?.attrs.heading as boolean)) continue;
    for (const d of descendantBlocks(doc, id, byId)) hidden.push(d.pos);
  }
  return hidden.sort((a, b) => a - b);
}

/** The chevron widget DOM factory for a foldable heading (▸ folded / ▾ expanded). mousedown toggles the
 *  fold (preventing the default caret move); when FOLDING with the caret inside the subtree, the caret is
 *  relocated onto the heading so it isn't stranded in hidden content. */
function foldChevron(id: string, isFolded: boolean): (view: EditorView) => HTMLElement {
  return (view) => {
    const el = document.createElement('span');
    el.className = 'mm-fold-toggle';
    el.textContent = isFolded ? '▸' : '▾';
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('aria-label', isFolded ? 'expand section' : 'collapse section');
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep the caret where it is; don't focus the widget
      const { state } = view;
      const ps = KEY.getState(state);
      const willFold = !ps?.folded.has(id);
      const tr = state.tr.setMeta(KEY, { toggle: id } satisfies FoldMeta);
      if (willFold) {
        const byId = headingIndex(state.doc);
        const selBlock = state.selection.$from.parent;
        if (selBlock.type.name === 'prose' && isDescendantOf(selBlock, id, byId)) {
          let headingEnd: number | null = null;
          state.doc.forEach((b, off) => {
            if (b.attrs.unitId === id) headingEnd = off + 1 + b.content.size;
          });
          if (headingEnd != null) tr.setSelection(TextSelection.create(tr.doc, headingEnd));
        }
      }
      view.dispatch(tr);
    });
    return el;
  };
}

function buildDecorations(doc: PMNode, folded: Set<string>): DecorationSet {
  const byId = headingIndex(doc);
  const decos: Decoration[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== 'prose' || !(block.attrs.heading as boolean)) return;
    const id = block.attrs.unitId as string | null;
    if (!id) return;
    const descendants = descendantBlocks(doc, id, byId);
    if (descendants.length === 0) return; // a leaf heading isn't foldable — no chevron
    const isFolded = folded.has(id);
    decos.push(
      Decoration.widget(offset + 1, foldChevron(id, isFolded), { side: -1, key: `fold:${id}:${isFolded}` }),
    );
    if (isFolded) {
      for (const d of descendants) {
        decos.push(Decoration.node(d.pos, d.pos + d.size, { class: 'mm-folded-hidden' }));
      }
    }
  });
  return DecorationSet.create(doc, decos);
}

/** Apply a fold meta + prune ids whose heading vanished, returning the next folded set (or the same ref). */
function nextFolded(folded: Set<string>, meta: FoldMeta | undefined, doc: PMNode, pruneStale: boolean): Set<string> {
  let next = folded;
  if (meta?.toggle) {
    next = new Set(next);
    if (next.has(meta.toggle)) next.delete(meta.toggle);
    else next.add(meta.toggle);
  }
  if (meta?.unfold && meta.unfold.length) {
    next = new Set(next);
    for (const id of meta.unfold) next.delete(id);
  }
  if (pruneStale && next.size > 0) {
    const byId = headingIndex(doc);
    const pruned = new Set([...next].filter((id) => byId.get(id)?.attrs.heading as boolean));
    if (pruned.size !== next.size) next = pruned;
  }
  return next;
}

export const headingFold = new Plugin<FoldState>({
  key: KEY,
  state: {
    init: (_config, state) => ({ folded: new Set(), decos: buildDecorations(state.doc, new Set()) }),
    apply(tr, value, _old, newState) {
      const meta = tr.getMeta(KEY) as FoldMeta | undefined;
      const folded = nextFolded(value.folded, meta, newState.doc, tr.docChanged);
      if (folded === value.folded && !tr.docChanged) return value; // nothing relevant changed
      return { folded, decos: buildDecorations(newState.doc, folded) };
    },
  },
  // Caret safety: if a transaction leaves the selection inside a hidden (folded-descendant) block — e.g.
  // arrowing into it — unfold the enclosing folded heading(s) so the caret is never stranded out of sight.
  appendTransaction(_trs, _old, newState) {
    const ps = KEY.getState(newState);
    if (!ps || ps.folded.size === 0) return null;
    const block = newState.selection.$from.parent;
    if (block.type.name !== 'prose') return null;
    const ancestors = foldedAncestorsOf(block, ps.folded, headingIndex(newState.doc));
    return ancestors.length ? newState.tr.setMeta(KEY, { unfold: ancestors } satisfies FoldMeta) : null;
  },
  props: {
    decorations: (state) => KEY.getState(state)?.decos ?? null,
  },
});

/** Toggle the fold of a heading by its unitId (the chevron's gesture, also usable from a keymap). Does NOT
 *  relocate the caret — the chevron does that; a programmatic caller should ensure the caret isn't stranded
 *  (the appendTransaction safety net will auto-unfold if it is). */
export function toggleFold(unitId: string): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.setMeta(KEY, { toggle: unitId } satisfies FoldMeta));
    return true;
  };
}

/** The currently-folded heading ids (read-only) — for tests / external inspection. */
export function foldedHeadings(state: EditorState): ReadonlySet<string> {
  return KEY.getState(state)?.folded ?? new Set<string>();
}
