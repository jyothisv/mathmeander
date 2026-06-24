// The inline-FORMATTING live preview — hide-on-blur / reveal-on-caret for the markdown delimiters, mirroring
// mathLivePreview's `$…$` behavior. The styled inner (bold/italic/strike/code) is ALWAYS shown; only the
// wrapping delimiters (`**`/`*`/`~~`/`` ` ``) are hidden when the selection is outside the region, and revealed
// (shown as plain editable text) the moment the selection touches it — INCLUSIVE of the delimiters, so caret
// motion across the hidden↔shown boundary stays robust by keyboard (you can never get stuck on hidden text).
//
// Unlike math there is no rendered widget: the inner text is the content, just styled, so this plugin only
// adds/removes `display:none` decorations over the delimiter chars. The regions are cached in plugin state and
// recomputed only on a doc edit (a pure caret move just re-decorates).
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { editorSchema } from './schema';
import { MARK_DELIM } from './markSyntax';

const STYLED = editorSchema.marks.styled;
// MARK_DELIM is the delimiter string per style (shared with the scanner + keymap). A style with no entry has no
// markdown delimiters (e.g. a future style) and is left untouched (never hidden).

/** A formatting region: the styled INNER `[from,to)` and its wrapping `delim`. The full region (incl. the
 *  delimiters) is `[from - delim.length, to + delim.length)`. */
interface Region {
  from: number;
  to: number;
  delim: string;
}

/** The styled inner spans of the doc that have known markdown delimiters, adjacent same-style runs merged. */
function computeRegions(doc: PMNode): Region[] {
  const regions: Region[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== 'prose') return;
    let pos = offset + 1;
    let cur: { from: number; to: number; style: string } | null = null;
    const flush = () => {
      if (cur && MARK_DELIM[cur.style])
        regions.push({ from: cur.from, to: cur.to, delim: MARK_DELIM[cur.style]! });
      cur = null;
    };
    block.forEach((child) => {
      const m = child.isText ? child.marks.find((x) => x.type === STYLED) : undefined;
      const style = m ? (m.attrs.style as string) : null;
      if (style != null) {
        if (cur && cur.to === pos && cur.style === style) cur.to = pos + child.nodeSize;
        else {
          flush();
          cur = { from: pos, to: pos + child.nodeSize, style };
        }
      } else flush();
      pos += child.nodeSize;
    });
    flush();
  });
  return regions;
}

interface PluginState {
  regions: Region[];
}
const KEY = new PluginKey<PluginState>('markLivePreview');

export const markLivePreview = new Plugin<PluginState>({
  key: KEY,
  state: {
    init: (_config, state) => ({ regions: computeRegions(state.doc) }),
    apply: (tr, prev, _old, newState) =>
      tr.docChanged ? { regions: computeRegions(newState.doc) } : prev,
  },
  props: {
    decorations(state) {
      const ps = KEY.getState(state);
      if (!ps) return null;
      const { from: selFrom, to: selTo } = state.selection;
      const decos: Decoration[] = [];
      for (const r of ps.regions) {
        const n = r.delim.length;
        const start = r.from - n;
        const end = r.to + n;
        if (selFrom <= end && selTo >= start) continue; // selection touches the region → reveal the delimiters
        // GUARD: only ever hide actual delimiter text — never real content (e.g. a clean mark with no `**`).
        if (state.doc.textBetween(start, r.from) !== r.delim) continue;
        if (state.doc.textBetween(r.to, end) !== r.delim) continue;
        decos.push(Decoration.inline(start, r.from, { class: 'mark-delim-hidden' }));
        decos.push(Decoration.inline(r.to, end, { class: 'mark-delim-hidden' }));
      }
      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});
