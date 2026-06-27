// §B heading live preview (Obsidian-style) — the `#`/`##` SOURCE prefix is kept as editable text, but
// HIDDEN when the caret is away from the heading and shown DIMMED when the caret is in the heading line
// (the analogue of markLivePreview's delimiter hide/reveal, with a dim state while editing). No widget —
// the title text IS the content (styled as a heading by the `.mm-heading` block class); this plugin only
// adds `display:none` / dimmed decorations over the `#` prefix chars. Ranges are cached in plugin state and
// recomputed on a doc edit; a pure caret move just re-decorates.
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { HEADING_PREFIX_RE } from './headingSyntax';

interface Prefix {
  from: number; // position of the first `#` (block content start)
  to: number; // position just past the prefix space
  blockEnd: number; // end of the block's content (for caret-in-block detection)
}

function computePrefixes(doc: PMNode): Prefix[] {
  const out: Prefix[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== 'prose' || !(block.attrs.heading as boolean)) return;
    const m = HEADING_PREFIX_RE.exec(block.textContent);
    if (!m) return; // a heading whose prefix was deleted (headingRecognize will demote it) → nothing to hide
    const contentStart = offset + 1;
    // The prefix is ASCII (`#`s + a single `\s`), so the match's code-unit length equals its PM position span.
    out.push({
      from: contentStart,
      to: contentStart + m[0].length,
      blockEnd: contentStart + block.content.size,
    });
  });
  return out;
}

interface PluginState {
  prefixes: Prefix[];
}
const KEY = new PluginKey<PluginState>('headingLivePreview');

export const headingLivePreview = new Plugin<PluginState>({
  key: KEY,
  state: {
    init: (_config, state) => ({ prefixes: computePrefixes(state.doc) }),
    apply: (tr, prev, _old, newState) =>
      tr.docChanged ? { prefixes: computePrefixes(newState.doc) } : prev,
  },
  props: {
    decorations(state) {
      const ps = KEY.getState(state);
      if (!ps) return null;
      const { from: selFrom, to: selTo } = state.selection;
      const decos: Decoration[] = [];
      for (const p of ps.prefixes) {
        // Caret/selection anywhere in the heading BLOCK → DIM the prefix (you're editing it); otherwise
        // HIDE it entirely. Inclusive of the prefix so caret motion across the boundary stays robust.
        const inBlock = selFrom <= p.blockEnd && selTo >= p.from;
        decos.push(
          Decoration.inline(p.from, p.to, {
            class: inBlock ? 'heading-prefix-dimmed' : 'heading-prefix-hidden',
          }),
        );
      }
      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});
