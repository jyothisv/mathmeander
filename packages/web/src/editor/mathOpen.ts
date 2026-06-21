// The "math is open" signal — a node decoration marking whichever inline-math node currently CONTAINS the
// selection. This is the single source of "open" for MathNodeView: source is visible ONLY while the caret is
// inside the math (strictly caret-keyed, no sticky flag). With `atom: true` the caret reaches a math node's
// inner text only by a deliberate gesture (double-click / `$`-create / Backspace-after / Delete-before — see
// mathKeys + DayEditor), so this decoration appears exactly when the user is editing the source.
//
// `props.decorations` recomputes from state on every selection change, and a changed node decoration drives
// the NodeView's `update` — that is what flips render↔source as the caret crosses the delimiter.
import { Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const mathOpen = new Plugin({
  props: {
    decorations(state) {
      const sel = state.selection;
      if (!(sel instanceof TextSelection)) return null;
      const $from = sel.$from;
      if ($from.parent.type.name !== 'inlineMath') return null;
      const pos = $from.before(); // position of the inline-math node itself
      return DecorationSet.create(state.doc, [
        Decoration.node(pos, pos + $from.parent.nodeSize, {}, { mathOpen: true }),
      ]);
    },
  },
});
