// The inline-math LIVE PREVIEW (slice 2d editable-syntax) — render-on-leave, reveal-on-enter. Every
// `mathExpr`-marked `$…$` span (the literal editable source; see mathRecognize.ts) is RENDERED with KaTeX while
// the caret/selection is outside it, and shown as RAW editable text once the selection touches it. Replaces the
// retired atom NodeView (MathNodeView) + `math-open` decoration (mathOpen).
//
//   • REVEAL on selection touch (inclusive of both delimiters) so the caret never has to occupy hidden text —
//     that boundary inclusivity is what keeps caret motion across the render↔raw transition robust by keyboard.
//   • DOUBLE-CLICK to edit (cross-mode-consistent with a future diagram mode): a SINGLE click places the caret
//     beside the equation and keeps it rendered (a `suppress` flag in plugin state, cleared by the next
//     transaction); a DOUBLE click drops the caret inside → reveals. Keyboard arrow-in still reveals normally.
//   • OPEN-REGION color: while the caret sits in an UNCLOSED `$…` region (still being typed), its source is
//     colored (`math-src`) via a caret-local decoration — the live "math mode" feedback before the closing `$`.
//   • Cost: the marked-span list is cached in plugin state and recomputed only on a doc edit, so a pure caret
//     move does O(#math spans) + an O(run) open-region scan — not a full-document walk.
import { Plugin, PluginKey, Selection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { renderMathInto } from './renderMath';
import { openRegionStart } from './mathSyntax';

const MARK = editorSchema.marks.mathExpr;

interface Span {
  from: number;
  to: number;
  expr: MathExpression;
  /** A whole-line `$$…$$` display equation (rendered centered, source revealed only on focus) vs inline `$…$`. */
  display: boolean;
}
interface PluginState {
  spans: Span[];
  /** The `from` of a span to keep RENDERED despite the caret touching it (set by a single click; cleared by
   *  the next transaction). `null` = normal reveal-on-touch. */
  suppress: number | null;
}

const KEY = new PluginKey<PluginState>('mathLivePreview');

/** All `mathExpr`-marked spans in the doc, computed PER BLOCK. A DISPLAY block (a whole-block `$$…$$`, possibly
 *  MULTI-LINE) yields ONE span over the entire block content (text + hard_breaks) — so a multi-line equation is
 *  a single rendered region. An inline block yields its `$…$` runs, adjacent same-expr runs merged (a span split
 *  by an overlapping `styled` mark is rejoined). Per-block so two consecutive display blocks never over-merge. */
function computeSpans(doc: PMNode): Span[] {
  const spans: Span[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== 'prose') return;
    const contentStart = offset + 1;
    // DISPLAY: if any text node carries a display mark, the whole block is one display equation.
    let displayExpr: MathExpression | undefined;
    block.forEach((child) => {
      if (!child.isText) return;
      const m = child.marks.find((x) => x.type === MARK);
      if (m && (m.attrs.display as boolean)) displayExpr = m.attrs.expr as MathExpression;
    });
    if (displayExpr) {
      spans.push({
        from: contentStart,
        to: contentStart + block.content.size,
        expr: displayExpr,
        display: true,
      });
      return;
    }
    // INLINE: marked text runs in this block, merging adjacent same-expr runs.
    const merged: Span[] = [];
    let pos = contentStart;
    block.forEach((child) => {
      if (child.isText) {
        const m = child.marks.find((x) => x.type === MARK);
        if (m) {
          const s: Span = {
            from: pos,
            to: pos + child.nodeSize,
            expr: m.attrs.expr as MathExpression,
            display: false,
          };
          const prev = merged[merged.length - 1];
          if (prev && prev.to === s.from && prev.expr.id === s.expr.id) prev.to = s.to;
          else merged.push(s);
        }
      }
      pos += child.nodeSize;
    });
    spans.push(...merged);
  });
  return spans;
}

/** Build the KaTeX widget DOM for a rendered span. INLINE (`display:false`): single click → caret beside (stays
 *  rendered, suppress flag); double click → caret just inside (reveal). DISPLAY (`display:true`, centered): the
 *  render stays ALWAYS visible, so a click just reveals the source for editing — caret at the source end
 *  (best-effort; precise click→sub-expression position is the deferred F3 capability). */
function renderWidget(expr: MathExpression, display: boolean) {
  return (view: EditorView): HTMLElement => {
    const el = document.createElement('span');
    el.className = display ? 'math-render math-render-display' : 'math-render';
    el.contentEditable = 'false';
    renderMathInto(expr, el, { display });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(el, 0);
      if (display) {
        const sel = Selection.near(view.state.doc.resolve(pos), -1); // into the source (end) → reveal it
        view.dispatch(view.state.tr.setSelection(sel));
      } else if (e.detail >= 2) {
        const sel = Selection.near(view.state.doc.resolve(pos + 1), 1); // just inside → reveal
        view.dispatch(view.state.tr.setSelection(sel));
      } else {
        const sel = Selection.near(view.state.doc.resolve(pos), -1); // beside → stays rendered (suppressed)
        view.dispatch(view.state.tr.setSelection(sel).setMeta(KEY, pos));
      }
      view.focus();
    });
    return el;
  };
}

/** The caret-local "open region" decoration: while the caret is inside an UNCLOSED `$…`, color its source. */
function openRegionDeco(state: EditorState): Decoration | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $c = sel.$from;
  if ($c.parent.type.name !== 'prose') return null;
  const contentStart = $c.start();
  const caret = sel.from;
  const runs: { from: number; text: string }[] = [];
  let runFrom = -1;
  let runText = '';
  let pos = contentStart;
  const push = () => {
    if (runFrom >= 0) runs.push({ from: runFrom, text: runText });
    runFrom = -1;
    runText = '';
  };
  $c.parent.forEach((child) => {
    if (child.isText) {
      if (runFrom < 0) runFrom = pos;
      runText += child.text ?? '';
    } else push();
    pos += child.nodeSize;
  });
  push();
  const run = runs.find((r) => caret >= r.from && caret <= r.from + r.text.length);
  if (!run) return null;
  const start = openRegionStart(run.text, caret - run.from);
  if (start == null) return null;
  return Decoration.inline(run.from + start, run.from + run.text.length, { class: 'math-src' });
}

export const mathLivePreview = new Plugin<PluginState>({
  key: KEY,
  state: {
    init: (_config, state) => ({ spans: computeSpans(state.doc), suppress: null }),
    apply: (tr, prev, _old, newState) => {
      const meta = tr.getMeta(KEY) as number | null | undefined;
      const suppress = meta !== undefined ? meta : null; // set by a single click; any other tr clears it
      const spans = tr.docChanged ? computeSpans(newState.doc) : prev.spans;
      return { spans, suppress };
    },
  },
  props: {
    decorations(state) {
      const ps = KEY.getState(state);
      if (!ps) return null;
      const { from: selFrom, to: selTo } = state.selection;
      const decos: Decoration[] = [];
      for (const span of ps.spans) {
        const touches = selFrom <= span.to && selTo >= span.from;
        if (span.display) {
          // DISPLAY: the centered render is ALWAYS shown (a widget after the source); the `$$…$$` source is
          // hidden UNLESS the selection is in the block, where it appears ABOVE the render for editing.
          decos.push(
            Decoration.widget(span.to, renderWidget(span.expr, true), {
              side: 1,
              marks: [],
              key: `mathd:${span.expr.id}:${span.expr.surface_text}:${span.expr.parse_status}`,
              ignoreSelection: true,
            }),
          );
          if (!touches) decos.push(Decoration.inline(span.from, span.to, { class: 'math-hidden' }));
          continue;
        }
        if (touches && ps.suppress !== span.from) continue; // inline: reveal raw on touch
        decos.push(Decoration.inline(span.from, span.to, { class: 'math-hidden' }));
        decos.push(
          Decoration.widget(span.from, renderWidget(span.expr, false), {
            side: -1,
            // No marks: a widget defaults to inheriting the marks at its position, so for two ADJACENT `$…$`
            // spans the second equation's KaTeX would render INSIDE the first's `mathExpr` (`.math-src`) span
            // and pick up the source font/color. `marks: []` keeps the rendered math a clean, unstyled sibling.
            marks: [],
            key: `math:${span.expr.id}:${span.expr.surface_text}:${span.expr.parse_status}`,
            ignoreSelection: true,
          }),
        );
      }
      const open = openRegionDeco(state);
      if (open) decos.push(open);
      return decos.length > 0 ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});
