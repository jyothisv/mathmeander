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
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { renderMathInto } from './renderMath';
import {
  type PathBox,
  deepestPathAt,
  docPosForSurfaceOffset,
  sameArray,
  singleClickCaretOffset,
  systemRowStarts,
} from './mathClickMap';
import { openRegionStart, splitSystemRows, wholeDisplaySource } from './mathSyntax';
import { isMathRuntimeReady, normalizeFresh, surfacePaths } from './mathRuntime';

const MARK = editorSchema.marks.mathExpr;

interface Span {
  from: number;
  to: number;
  expr: MathExpression;
  /** A whole-line `$$…$$` display equation (rendered centered, source revealed only on focus) vs inline `$…$`. */
  display: boolean;
  /** A co-equal SYSTEM (2-B): the per-row surfaces of a multi-line `$$…$$` (≥2 non-empty lines). When set,
   *  the widget renders an aligned stack of rows instead of one centered equation. */
  rows?: string[];
  /** Parallel to `rows`: the doc position of each row's first source char (F3 precise click), accounting for
   *  the skipped blank/leading lines so a clicked sub-term maps to the right row. Set iff `rows` is. */
  rowStarts?: number[];
}

/** A block's source with `\n` per hard_break (a system's `$$…$$` is multi-line); null if it has a
 *  non-text/non-hard_break inline. */
function blockSource(block: PMNode): string | null {
  let text = '';
  let ok = true;
  block.forEach((child) => {
    if (child.isText) text += child.text ?? '';
    else if (child.type.name === 'hard_break') text += '\n';
    else ok = false;
  });
  return ok ? text : null;
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
      // A multi-line `$$…$$` with ≥2 non-empty lines is a co-equal SYSTEM (2-B): carry the per-row surfaces
      // so the widget renders an aligned stack. One line → a single centered equation (carry no rows).
      const src = blockSource(block);
      const inner = src != null ? wholeDisplaySource(src) : null;
      const rows = inner != null ? splitSystemRows(inner) : [];
      spans.push({
        from: contentStart,
        to: contentStart + block.content.size,
        expr: displayExpr,
        display: true,
        ...(rows.length >= 2 ? { rows, rowStarts: systemRowStarts(src!, contentStart) } : {}),
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

/** PRECISE CLICK (F3): if the click landed on a `data-path` sub-term (tagged by `toKatexDisplay`'s
 *  `\htmlData`), map it to the source via `surfacePaths(rowSurface)` and place a selection. The spans
 *  index the VERBATIM `rowSurface` the doc holds (each node carries its source range), so this is exact
 *  for ANY input — no canonical-form guard. Single-click → a caret at the sub-term (for an operator/
 *  structural node, just after its left operand — see `singleClickCaretOffset`); double-click → a
 *  selection over the whole sub-term. `rowStart` is the doc position of the row's first surface char
 *  (after `$$` for a single equation; `systemRowStarts[i]` for a system row). Returns false (caller
 *  falls back to reveal-at-start) when the runtime is down, the click missed a tagged node, or the path
 *  isn't found. */
function precisePlace(
  view: EditorView,
  e: MouseEvent,
  container: HTMLElement,
  rowSurface: string,
  rowStart: number,
): boolean {
  if (!isMathRuntimeReady()) return false;
  // Resolve the click by GEOMETRY (smallest `data-path` box containing the point), NOT by
  // `e.target.closest` — KaTeX script vlists stack an ancestor box over the script glyphs, so the
  // event target there is the enclosing node, not the deeper script sub-term (`deepestPathAt`).
  const boxes: PathBox[] = Array.from(
    container.querySelectorAll<HTMLElement>('[data-path]'),
    (el) => {
      const r = el.getBoundingClientRect();
      return {
        path: el.dataset.path ?? '',
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      };
    },
  );
  const hitPath = deepestPathAt(boxes, e.clientX, e.clientY);
  if (hitPath == null) return false;
  const want = hitPath.split('.').filter(Boolean).map(Number); // "" → [] (root)
  const paths = surfacePaths(rowSurface);
  const hit = paths.find((p) => sameArray(p.path, want));
  if (!hit) return false;
  const tr =
    e.detail >= 2
      ? view.state.tr.setSelection(
          TextSelection.create(
            view.state.doc,
            docPosForSurfaceOffset(rowStart, rowSurface, hit.charSpan.start),
            docPosForSurfaceOffset(rowStart, rowSurface, hit.charSpan.end),
          ),
        )
      : view.state.tr.setSelection(
          Selection.near(
            view.state.doc.resolve(
              docPosForSurfaceOffset(rowStart, rowSurface, singleClickCaretOffset(hit, paths)),
            ),
            1,
          ),
        );
  view.dispatch(tr); // the selection moving into the block reveals the hidden source
  view.focus();
  return true;
}

/** Build the KaTeX widget DOM for a rendered span. INLINE (`display:false`): single click → caret beside (stays
 *  rendered, suppress flag); double click → caret just inside (reveal). DISPLAY (`display:true`, centered): the
 *  render stays ALWAYS visible; a click maps to the precise sub-term (F3) — single → caret there, double →
 *  select it — falling back to reveal-at-start off a tagged node. `spanFrom` is the source start (the block
 *  content start, the position of the first `$`). */
function renderWidget(expr: MathExpression, display: boolean, spanFrom: number) {
  return (view: EditorView): HTMLElement => {
    const el = document.createElement('span');
    el.className = display ? 'math-render math-render-display' : 'math-render';
    el.contentEditable = 'false';
    renderMathInto(expr, el, { display });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (display) {
        // A single display equation's surface starts right after the opening `$$` (spanFrom is the first `$`).
        if (precisePlace(view, e, el, expr.surface_text ?? '', spanFrom + 2)) return;
        const pos = view.posAtDOM(el, 0); // fallback: reveal the source (caret near start)
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos), -1)));
        view.focus();
        return;
      }
      const pos = view.posAtDOM(el, 0);
      if (e.detail >= 2) {
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

/** A transient `MathExpression` for rendering ONE system row (id is irrelevant — this is render-only; the
 *  canonical row identity lives in the flush via `rowIds`). `parse_status` from the WASM when ready, so an
 *  invalid row shows its source rather than a KaTeX error. */
function transientRowExpr(surface: string): MathExpression {
  return {
    id: '',
    surface_text: surface,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: surface,
    parse_status: isMathRuntimeReady() ? normalizeFresh(surface).parseStatus : 'renderable',
    occurrences: [],
  };
}

/** Build the widget DOM for a co-equal SYSTEM (2-B): each row rendered (KaTeX) in a `[relation | body]` grid,
 *  reusing the 2-A read-only `.equations` layout for visual consistency (`row_relation` gutter empty for now —
 *  the `&`-alignment override is deferred). The render stays ALWAYS visible; a click maps to the precise
 *  sub-term of the clicked row (F3) — single → caret there, double → select it. Each row carries `data-row=i`
 *  so the handler locates the row (and its surface) without DOM-index math. `rowStarts[i]` is the doc position
 *  of `rows[i]`'s first char (from `systemRowStarts`, which accounts for skipped blank/leading lines). */
function renderSystemWidget(rows: string[], rowStarts: number[]) {
  return (view: EditorView): HTMLElement => {
    const el = document.createElement('span');
    el.className = 'math-render math-render-display equations';
    el.contentEditable = 'false';
    rows.forEach((surface, i) => {
      const row = document.createElement('span');
      row.className = 'row';
      row.dataset.row = String(i);
      const rel = document.createElement('span');
      rel.className = 'row-relation';
      const body = document.createElement('span');
      body.className = 'row-body';
      renderMathInto(transientRowExpr(surface), body, { display: true });
      row.append(rel, body);
      el.append(row);
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rowEl = (e.target as HTMLElement | null)?.closest('[data-row]') as HTMLElement | null;
      if (rowEl && el.contains(rowEl)) {
        const rowIndex = Number(rowEl.dataset.row);
        const rowStart = rowStarts[rowIndex];
        // Scope the geometry search to the ROW element (each row is pathed from its own root, so the
        // `data-path` values collide across rows — searching the whole widget would be ambiguous).
        if (rowStart != null && precisePlace(view, e, rowEl, rows[rowIndex] ?? '', rowStart))
          return;
      }
      const pos = view.posAtDOM(el, 0); // fallback: reveal the source (caret near start)
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos), -1)));
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
          // DISPLAY: the render is ALWAYS shown (a widget after the source); the `$$…$$` source is hidden
          // UNLESS the selection is in the block, where it appears ABOVE the render for editing. A SYSTEM
          // (≥2 rows) renders as an aligned stack; a single equation renders centered.
          const isSystem = !!span.rows && span.rows.length >= 2;
          decos.push(
            Decoration.widget(
              span.to,
              isSystem
                ? renderSystemWidget(span.rows!, span.rowStarts ?? [])
                : renderWidget(span.expr, true, span.from),
              {
                side: 1,
                marks: [],
                key: isSystem
                  ? `maths:${isMathRuntimeReady() ? 1 : 0}:${span.rows!.join('\n')}`
                  : `mathd:${span.expr.id}:${span.expr.surface_text}:${span.expr.parse_status}`,
                ignoreSelection: true,
              },
            ),
          );
          if (!touches) decos.push(Decoration.inline(span.from, span.to, { class: 'math-hidden' }));
          continue;
        }
        if (touches && ps.suppress !== span.from) continue; // inline: reveal raw on touch
        decos.push(Decoration.inline(span.from, span.to, { class: 'math-hidden' }));
        decos.push(
          Decoration.widget(span.from, renderWidget(span.expr, false, span.from), {
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
