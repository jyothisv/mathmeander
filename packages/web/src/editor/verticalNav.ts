// Escape-hatch for native vertical caret nav across NO-TEXT-CARET math lines (the intermittent "Up/Down does
// nothing" bug). A display `$$…$$` block — a single equation OR a multi-line system — renders its source
// `display:none` with only a contentEditable=false KaTeX widget visible, so that on-screen line has NO text
// caret target; the same is true of a block whose sole content is one inline `$…$`. Vertical caret motion in
// this editor is 100% native browser geometry (nothing binds the bare arrows, and there is no gapcursor — a
// display block is an inline-allowing textblock, which gapcursor does not bridge), so ArrowDown from the line
// above (or ArrowUp from below) finds no caret rect on that line and STALLS.
//
// This command binds bare ArrowUp/ArrowDown and returns false (→ native nav, the fast path) in EVERY normal
// case; it only takes over when the immediate visual neighbour in the travel direction is such a hidden math
// line, landing the caret ON it — which reveals its source (mathLivePreview's reveal-on-touch) so the caret is
// on real editable text and motion resumes. Pure selection move: no schema / math-model / hash change.
import { type Command, Selection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { hiddenMathLineAt } from './mathLivePreview';

export function verticalNav(dir: 'up' | 'down'): Command {
  return (state, dispatch, view) => {
    const sel = state.selection;
    if (!sel.empty || !view) return false; // Shift+Arrow / range / no view → 100% native (no selection regress)
    const $c = sel.$from;
    if ($c.depth < 1) return false;
    // Only intervene at the block's vertical boundary line — within-block (hard_break) Up/Down stays native.
    if (!view.endOfTextblock(dir)) return false;
    const blocks: { node: PMNode; pos: number }[] = [];
    state.doc.forEach((node, pos) => blocks.push({ node, pos }));
    const idx = blocks.findIndex((b) => b.pos === $c.before(1)); // the caret's top-level block
    if (idx < 0) return false;
    const target = blocks[dir === 'down' ? idx + 1 : idx - 1];
    if (!target) return false; // at the document edge → native (no-op) is correct
    if (!hiddenMathLineAt(state, target.pos, target.node)) return false; // a real text line → native nav
    if (dispatch) {
      // Land the caret ON the hidden math block (Selection.near reveals its source), at the near edge.
      const inside = dir === 'down' ? target.pos + 1 : target.pos + target.node.nodeSize - 1;
      const bias = dir === 'down' ? 1 : -1;
      dispatch(
        state.tr.setSelection(Selection.near(state.doc.resolve(inside), bias)).scrollIntoView(),
      );
    }
    return true;
  };
}
