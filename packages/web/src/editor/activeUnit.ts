// Marks the unit (prose block) containing the caret with a `unit-active` class, so the boundary affordance
// can "reveal on focus" — pure CSS can't target the active <p> inside a single contenteditable (focus lives
// on the editor div, not the paragraph). Decorations recompute from state on each render; one block, cheap.
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const activeUnit = new Plugin({
  props: {
    decorations(state) {
      const { $head, empty } = state.selection;
      if (!empty || $head.depth < 1) return null; // only a collapsed caret marks an active unit
      const blockPos = $head.before(1);
      const block = state.doc.nodeAt(blockPos);
      if (!block || block.type.name !== 'prose') return null;
      return DecorationSet.create(state.doc, [
        Decoration.node(blockPos, blockPos + block.nodeSize, { class: 'unit-active' }),
      ]);
    },
  },
});
