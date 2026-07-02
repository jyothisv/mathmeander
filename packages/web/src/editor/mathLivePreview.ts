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
//   • NOTATION (§6.3a): the notebook-wide registry (the `config` notation-home block's defs, see notationScope.ts)
//     is applied at render time (notation-as-register) — the literal source is unchanged. It's cached in plugin
//     state with a fingerprint that's folded into each widget's decoration key, so editing a definition
//     re-renders the math that depends on it.
//   • Cost: the marked-span list + the scope are cached in plugin state and recomputed only on a doc edit, so a
//     pure caret move does O(#math spans) + an O(run) open-region scan — not a full-document walk.
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
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
import { tightRect } from './domGeom';
import { isMathRuntimeReady, normalizeFresh, surfacePaths, type NotationDef } from './mathRuntime';
import { notationDefsFromSource, notationScopeKey } from './notationScope';

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
  /** §6.2: this INLINE expression carries a brace annotation, so render it `\htmlData`-tagged (a `data-path`
   *  per sub-term) even though inline math is normally untagged — the annotation overlay needs the sub-term's
   *  rect. Lazy: only annotated inline exprs pay the tagging cost. Display is always tagged (ignored there). */
  tagged?: boolean;
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
  /** The notebook-wide notation registry (the config notation-home's defs), applied at render time. */
  scope: NotationDef[];
  /** A fingerprint of `scope` for decoration keys — changing a definition re-renders dependent math. */
  scopeKey: string;
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
          // §6.2: ALWAYS `\htmlData`-tag inline math (a `data-path` per sub-term) — precise sub-term SELECTION
          // needs the tags to exist BEFORE the expr is annotated (the chicken-and-egg the lazy gate created).
          // The `\htmlData` trust is scoped/safe (renderMath.ts); the extra DOM is marginal.
          const s: Span = {
            from: pos,
            to: pos + child.nodeSize,
            expr: m.attrs.expr as MathExpression,
            display: false,
            tagged: true,
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

/** The notebook-wide NOTATION registry: the defs of every `config` block of family `notation`, in document
 *  order (= definition order, the frozen-prior-scope rule). Render-only; the source stays literal content.
 *  ONE scope layer for now (the notebook home); a per-region cascade (section/space/global) layers on top
 *  later — that step needs the canonical units (the parent chain) in the plugin, not just the flat PM doc. */
function computeNotationScope(doc: PMNode): NotationDef[] {
  const defs: NotationDef[] = [];
  doc.forEach((block) => {
    if (block.type.name !== 'config') return;
    if ((block.attrs.configFamily as string | null) !== 'notation') return;
    defs.push(...notationDefsFromSource(block.textContent));
  });
  return defs;
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
  opts: { mode?: 'caret' | 'select'; suppressAt?: number } = {},
): boolean {
  const mode = opts.mode ?? (e.detail >= 2 ? 'select' : 'caret');
  const suppressAt = opts.suppressAt;
  if (!isMathRuntimeReady()) return false;
  // Resolve the click by GEOMETRY (smallest `data-path` box containing the point), NOT by
  // `e.target.closest` — KaTeX script vlists stack an ancestor box over the script glyphs, so the
  // event target there is the enclosing node, not the deeper script sub-term (`deepestPathAt`).
  // TIGHT boxes for hit resolution: a container's own box carries vlist strut geometry that overlaps its
  // neighbours (in display style, clicking the exponent `2` resolved to `b`) — the glyph union is the truth.
  const boxes: PathBox[] = [];
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-path]'))) {
    const r = tightRect(el);
    if (r) {
      boxes.push({
        path: el.dataset.path ?? '',
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      });
    }
  }
  const hitPath = deepestPathAt(boxes, e.clientX, e.clientY);
  const dbg = (globalThis as unknown as { __annoDebug?: unknown[] }).__annoDebug;
  if (Array.isArray(dbg))
    dbg.push({ phase: 'precisePlace', detail: e.detail, hitPath, rowStart, boxes: boxes.length });
  if (hitPath == null) return false;
  const want = hitPath.split('.').filter(Boolean).map(Number); // "" → [] (root)
  const paths = surfacePaths(rowSurface);
  const hit = paths.find((p) => sameArray(p.path, want));
  if (!hit) return false;
  const tr =
    mode === 'select'
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
  // §6.2 STRUCTURAL selection: when the caller passes `suppressAt` (the inline dblclick), the sub-term is
  // being selected AS A TARGET — keep the equation RENDERED (the annotate gesture runs entirely on the
  // render; the source never flashes). Without it, the selection reveals the source as before.
  if (suppressAt != null) tr.setMeta(KEY, suppressAt);
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Mark `tr` so the math span starting at `spanFrom` stays RENDERED even though the selection touches it —
 *  the §6.2 structural-selection/annotate suppressor (the same plugin meta the widget's single-click sets).
 *  The suppression persists across pure bookkeeping transactions (no doc/selection change) and lifts on the
 *  next real edit or caret move. */
export function suppressMathRevealAt(tr: Transaction, spanFrom: number): Transaction {
  return tr.setMeta(KEY, spanFrom);
}

/** Build the KaTeX widget DOM for a rendered span. INLINE (`display:false`): single click → caret beside (stays
 *  rendered, suppress flag); double click → caret just inside (reveal). DISPLAY (`display:true`, centered): the
 *  render stays ALWAYS visible; a click maps to the precise sub-term (F3) — single → caret there, double →
 *  select it — falling back to reveal-at-start off a tagged node. `spanFrom` is the source start (the block
 *  content start, the position of the first `$`). `scope` is the document notation registry applied at render. */
function renderWidget(
  expr: MathExpression,
  display: boolean,
  spanFrom: number,
  scope: NotationDef[],
  tagged = false,
) {
  return (view: EditorView): HTMLElement => {
    const el = document.createElement('span');
    el.className = display ? 'math-render math-render-display' : 'math-render';
    el.contentEditable = 'false';
    // §6.2 precision: the EXPRESSION ID on the render root. `data-path` values are per-expr-root, so they
    // COLLIDE across the several `$…$` exprs of one block — the annotation overlay scopes its sub-term lookup
    // to `[data-expr-id="…"] [data-path="…"]`, which is what pins a brace to the RIGHT expression.
    el.dataset.exprId = expr.id;
    renderMathInto(expr, el, { display, scope, tagged });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (display) {
        // RENDER-FIRST (§6.2). The invariant that makes a DOUBLE-click reliable: a click must never CHANGE
        // the source's reveal state (revealing OR hiding reflows the block, moving the widget out from
        // under the double-click's second click — the display-annotation bug, both directions). So a click
        // PRESERVES the current state: source hidden → precise caret/selection WITH suppress (stays
        // rendered-only); source revealed → the same WITHOUT suppress (stays revealed). Single click =
        // precise caret; dblclick = STRUCTURAL sub-term selection (the annotate popover); dblclick AGAIN
        // (already structurally selected) = explicit reveal for editing (a deliberate layout change).
        // A single display equation's surface starts right after the opening `$$` (spanFrom = the first `$`).
        const surface = expr.surface_text ?? '';
        const srcLen = surface.length + 4; // `$$` + surface + `$$`
        const { from: sf, to: st } = view.state.selection;
        const ps = KEY.getState(view.state);
        const touching = sf <= spanFrom + srcLen && st >= spanFrom;
        const revealed = touching && ps?.suppress !== spanFrom;
        const keep = revealed ? {} : { suppressAt: spanFrom };
        if (e.detail >= 2) {
          const alreadyStructural = st > sf && sf >= spanFrom && st <= spanFrom + srcLen;
          if (
            alreadyStructural &&
            precisePlace(view, e, el, surface, spanFrom + 2, { mode: 'caret' })
          )
            return; // second dblclick → caret at the sub-term, NO suppress → source reveals for editing
          if (
            !alreadyStructural &&
            precisePlace(view, e, el, surface, spanFrom + 2, { mode: 'select', ...keep })
          )
            return;
        } else {
          // Preserve an existing structural selection (see the inline branch note) — the second dblclick's
          // leading single click must not collapse it.
          if (st > sf && sf >= spanFrom && st <= spanFrom + srcLen) return;
          if (precisePlace(view, e, el, surface, spanFrom + 2, { mode: 'caret', ...keep })) return;
        }
        const pos = view.posAtDOM(el, 0); // fallback: reveal the source (caret near start)
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos), -1)));
        view.focus();
        return;
      }
      // §6.2 STRUCTURAL selection (inline is always `\htmlData`-tagged): the FIRST double-click precise-
      // selects the clicked SUB-TERM while KEEPING the render (suppress) — the annotate popover then works
      // entirely on the rendered equation. A SECOND double-click (the selection already sits inside this
      // span) REVEALS the source for editing — the guaranteed mouse path into the source (keyboard arrow
      // walk-in also still reveals). `spanFrom + 1` = past the opening `$` (display uses `+ 2`).
      if (e.detail >= 2) {
        const { from: sf, to: st } = view.state.selection;
        const srcLen = (expr.surface_text ?? '').length + 2; // `$` + surface + `$` (UTF-16 = doc positions)
        const alreadyStructural = st > sf && sf >= spanFrom && st <= spanFrom + srcLen;
        if (
          !alreadyStructural &&
          precisePlace(view, e, el, expr.surface_text ?? '', spanFrom + 1, {
            mode: 'select',
            suppressAt: spanFrom,
          })
        )
          return;
      }
      const pos = view.posAtDOM(el, 0);
      if (e.detail >= 2) {
        const sel = Selection.near(view.state.doc.resolve(pos + 1), 1); // just inside → reveal
        view.dispatch(view.state.tr.setSelection(sel));
      } else {
        // A single click PRESERVES an existing structural selection inside this span — the first click of
        // a SECOND double-click would otherwise collapse it to a caret, making `alreadyStructural` above
        // unreachable (the reveal gesture would never fire).
        const { from: sf1, to: st1 } = view.state.selection;
        const srcLen1 = (expr.surface_text ?? '').length + 2;
        if (st1 > sf1 && sf1 >= spanFrom && st1 <= spanFrom + srcLen1) return;
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
function renderSystemWidget(
  rows: string[],
  rowStarts: number[],
  scope: NotationDef[],
  exprId: string,
) {
  return (view: EditorView): HTMLElement => {
    const el = document.createElement('span');
    el.className = 'math-render math-render-display equations';
    el.contentEditable = 'false';
    // §6.2 precision: the block expression's id on the widget root (rows are `data-row`-scoped within it) —
    // same collision-proofing as renderWidget; row-scoped annotation lands in 1b.
    el.dataset.exprId = exprId;
    rows.forEach((surface, i) => {
      const row = document.createElement('span');
      row.className = 'row';
      row.dataset.row = String(i);
      const rel = document.createElement('span');
      rel.className = 'row-relation';
      const body = document.createElement('span');
      body.className = 'row-body';
      renderMathInto(transientRowExpr(surface), body, { display: true, scope });
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
    init: (_config, state) => {
      const scope = computeNotationScope(state.doc);
      return {
        spans: computeSpans(state.doc),
        suppress: null,
        scope,
        scopeKey: notationScopeKey(scope),
      };
    },
    apply: (tr, prev, _old, newState) => {
      const meta = tr.getMeta(KEY) as number | null | undefined;
      // Suppression lifecycle: set by a click/structural-select/annotate meta; PRESERVED across pure
      // bookkeeping transactions (no doc or selection change — e.g. the annotation overlay's reserve
      // updates, which would otherwise un-render the equation mid-gesture); cleared by any real edit or
      // caret move.
      const suppress =
        meta !== undefined ? meta : !tr.docChanged && !tr.selectionSet ? prev.suppress : null;
      if (!tr.docChanged) {
        return { spans: prev.spans, suppress, scope: prev.scope, scopeKey: prev.scopeKey };
      }
      const scope = computeNotationScope(newState.doc);
      return {
        spans: computeSpans(newState.doc),
        suppress,
        scope,
        scopeKey: notationScopeKey(scope),
      };
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
                ? renderSystemWidget(span.rows!, span.rowStarts ?? [], ps.scope, span.expr.id)
                : renderWidget(span.expr, true, span.from, ps.scope),
              {
                side: 1,
                marks: [],
                key: isSystem
                  ? `maths:${isMathRuntimeReady() ? 1 : 0}:${span.rows!.join('\n')}:${ps.scopeKey}`
                  : `mathd:${span.expr.id}:${span.expr.surface_text}:${span.expr.parse_status}:${ps.scopeKey}`,
                ignoreSelection: true,
              },
            ),
          );
          // The source stays hidden while SUPPRESSED even though the selection touches (a precise click /
          // structural selection / annotate keeps the equation rendered without the source line appearing —
          // which would reflow the block and, during a double-click, move the widget out from under the
          // second click). An unsuppressed touch reveals the source above the render, as before.
          if (!touches || ps.suppress === span.from)
            decos.push(Decoration.inline(span.from, span.to, { class: 'math-hidden' }));
          continue;
        }
        if (touches && ps.suppress !== span.from) continue; // inline: reveal raw on touch
        decos.push(Decoration.inline(span.from, span.to, { class: 'math-hidden' }));
        decos.push(
          Decoration.widget(
            span.from,
            renderWidget(span.expr, false, span.from, ps.scope, span.tagged ?? false),
            {
              side: -1,
              // No marks: a widget defaults to inheriting the marks at its position, so for two ADJACENT `$…$`
              // spans the second equation's KaTeX would render INSIDE the first's `mathExpr` (`.math-src`) span
              // and pick up the source font/color. `marks: []` keeps the rendered math a clean, unstyled sibling.
              marks: [],
              // `tagged` folded into the key so adding/removing an annotation re-renders the expr tagged/untagged.
              key: `math:${span.expr.id}:${span.expr.surface_text}:${span.expr.parse_status}:${span.tagged ? 't' : 'u'}:${ps.scopeKey}`,
              ignoreSelection: true,
            },
          ),
        );
      }
      const open = openRegionDeco(state);
      if (open) decos.push(open);
      return decos.length > 0 ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});

/** Is the top-level block at doc position `blockPos` currently a HIDDEN math line — one whose ENTIRE on-screen
 *  content is a rendered math region right now (source `display:none`, only a contentEditable=false widget),
 *  so it has NO native text caret target? True for a whole-block `$$…$$` equation OR multi-line SYSTEM (one
 *  display span over the block — multi-line is handled by computeSpans, not re-derived here), AND the
 *  degenerate case of a block whose sole content is inline `$…$` spans — in BOTH only while the selection is
 *  AWAY (so mathLivePreview applies `math-hidden`). Reuses the plugin's CACHED spans + the SAME `touches` test
 *  as decorations(), so the two can't drift. `verticalNav` uses this to bridge the caret across such a block,
 *  which the browser's geometry-based vertical nav cannot land on (the intermittent Up/Down stall). */
export function hiddenMathLineAt(state: EditorState, blockPos: number, block: PMNode): boolean {
  if (block.type.name !== 'prose' || block.content.size === 0) return false;
  const ps = KEY.getState(state);
  if (!ps) return false;
  const contentStart = blockPos + 1;
  const contentEnd = contentStart + block.content.size;
  const { from: selFrom, to: selTo } = state.selection;
  const touches = (from: number, to: number): boolean => selFrom <= to && selTo >= from;
  // A display equation / system is ONE span over the whole block content. A SUPPRESSED touch keeps the
  // source hidden (matches decorations() exactly, so the two can't drift).
  const display = ps.spans.find((s) => s.display && s.from === contentStart && s.to === contentEnd);
  if (display) return !touches(display.from, display.to) || ps.suppress === display.from;
  // Degenerate: a block whose ENTIRE content is inline math spans (a sole `$x$` line), all currently hidden.
  // A gap (plain text) or any touched span ⇒ a real caret line exists ⇒ NOT a trap.
  const inline = ps.spans
    .filter((s) => !s.display && s.from >= contentStart && s.to <= contentEnd)
    .sort((a, b) => a.from - b.from);
  if (inline.length === 0) return false;
  let cursor = contentStart;
  for (const s of inline) {
    if (s.from !== cursor || touches(s.from, s.to)) return false;
    cursor = s.to;
  }
  return cursor === contentEnd;
}
