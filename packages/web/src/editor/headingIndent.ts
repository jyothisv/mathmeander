// §B outline editing (slice 3c-2) — depth-based VISUAL INDENTATION so the section structure is legible.
// Depth is NOT an attr (only `parentId` is), and toDOM can't see the parentId chain — so, like activeUnit /
// headingLivePreview, this is a node-decoration plugin computing each block's indent level from the chain.
// A heading sits at level `depth−1` (a top-level `#` heading is flush-left); a body block sits at its
// section's depth (one step under its heading title). View-only — never canonical; recomputed on doc edits.
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { headingDepthOf, headingIndex } from './cues';

const MAX_DEPTH = 6; // CSS ladder cap (`.mm-depth-1` … `.mm-depth-6`) — bounds runaway nesting

export interface BlockIndent {
  pos: number; // the block's position (doc offset)
  size: number;
  level: number; // 0 = flush-left
}

/** Each prose block's indent level from the `parentId` chain. Heading → `depth−1`; body → its section's
 *  depth (the parent heading's depth, one step under the title); top-level body → 0. */
export function computeDepths(doc: PMNode): BlockIndent[] {
  const byId = headingIndex(doc);
  const out: BlockIndent[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== 'prose') return;
    let level: number;
    if (block.attrs.heading as boolean) {
      level = headingDepthOf(block, byId) - 1;
    } else {
      const parentId = block.attrs.parentId as string | null;
      const parent = parentId ? byId.get(parentId) : undefined;
      level = parent ? headingDepthOf(parent, byId) : 0; // a body sits at its section's depth
    }
    out.push({ pos: offset, size: block.nodeSize, level: Math.max(0, level) });
  });
  return out;
}

interface PluginState {
  indents: BlockIndent[];
}
const KEY = new PluginKey<PluginState>('headingIndent');

export const headingIndent = new Plugin<PluginState>({
  key: KEY,
  state: {
    init: (_config, state) => ({ indents: computeDepths(state.doc) }),
    apply: (tr, prev, _old, newState) =>
      tr.docChanged ? { indents: computeDepths(newState.doc) } : prev,
  },
  props: {
    decorations(state) {
      const ps = KEY.getState(state);
      if (!ps) return null;
      const decos: Decoration[] = [];
      for (const b of ps.indents) {
        if (b.level <= 0) continue; // flush-left → no class
        decos.push(
          Decoration.node(b.pos, b.pos + b.size, {
            class: `mm-depth-${Math.min(b.level, MAX_DEPTH)}`,
          }),
        );
      }
      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});
