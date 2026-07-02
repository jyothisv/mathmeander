// The §6.2 annotate GESTURE — TARGET-FIRST, modeless (NOT kind-first "pick a tool then place it", the
// free-canvas model we rejected: the SELECTION *is* the structural anchor). The flow:
//   (1) the user selects the target, snapping to structure — a prose PHRASE (a text selection), or a math
//       SUB-TERM (mathLivePreview's precise click already selects a sub-term's source range: single-click a
//       caret, double-click selects the whole sub-term). The selection carries the precise binding.
//   (2) a contextual POPOVER offers the brace kind (over / under for slice 1a); or a keymap applies the
//       last-used kind (the power path).
//   (3) `annotate(kind)` binds the annotation to the selection — minting a fresh annotation + target id, adding
//       the `annoRef` mark over the range with the derived EXTENT — then the overlay focuses its caption editor.
//
// The extent is the LOAD-BEARING part (§6.2): a brace binds a precise sub-term/phrase, never a free point. For
// a math selection we invert `surfacePaths` (the same map precise-click uses): a selection matching one node
// binds its structural `term_path` (`sub_term`); a structure-covering range that is NOT one node (an
// associative sub-chain) binds an `expression_span` char range; a drag inside one token snaps to the deepest
// enclosing node — so annotate always yields a precise, resolvable binding. A prose selection is a
// `prose_span` (its offsets are re-derived at flush from the live mark range).
import { v7 as uuidv7 } from 'uuid';
import { Plugin, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import type { AnnoExtentAttr } from './projection';
import { isMathRuntimeReady, surfacePaths } from './mathRuntime';
import { renderMathInto } from './renderMath';
import { hullSidesAt, unionRect, type PathBoxLike, type RectLike } from './braceGeom';
import { maximalCovered, spanGlyphRects, spanHullSides } from './exprSpanGeom';
import { splitSystemRows } from './mathSyntax';
import { suppressMathRevealAt } from './mathLivePreview';
import { annoOccurrences } from './annoRecognize';
import { tightRect } from './domGeom';

const ANNO = editorSchema.marks.annoRef;
const MATH = editorSchema.marks.mathExpr;

export type BraceKind = 'overbrace' | 'underbrace' | 'left_brace' | 'right_brace';

/** UTF-16 unit offset → code-point offset within `s` (surface `CharSpan`s are code points; doc positions are
 *  UTF-16 units — they coincide for ASCII math, diverge on a non-BMP glyph). */
const utf16ToCp = (s: string, u: number): number => Array.from(s.slice(0, u)).length;

/** The contiguous `mathExpr` run covering `[from, to]` in one prose block (with its expr + delimiter width),
 *  or null when the selection isn't wholly inside one inline/display math source. */
function mathRunAt(
  doc: PMNode,
  from: number,
  to: number,
): { runFrom: number; runTo: number; expr: MathExpression; display: boolean } | null {
  const $f = doc.resolve(from);
  if ($f.depth < 1 || $f.parent.type.name !== 'prose') return null;
  const parentStart = $f.start();
  let pos = parentStart;
  let runFrom = -1;
  let runExpr: MathExpression | null = null;
  let runDisplay = false;
  let found: {
    runFrom: number;
    runTo: number;
    expr: MathExpression;
    display: boolean;
  } | null = null;
  $f.parent.forEach((child) => {
    const m = child.isText ? child.marks.find((x) => x.type === MATH) : undefined;
    if (m) {
      if (runFrom < 0) {
        runFrom = pos;
        runExpr = m.attrs.expr as MathExpression;
        runDisplay = (m.attrs.display as boolean) ?? false;
      }
    } else if (runFrom >= 0) {
      if (found == null && from >= runFrom && to <= pos && runExpr)
        found = { runFrom, runTo: pos, expr: runExpr, display: runDisplay };
      runFrom = -1;
      runExpr = null;
    }
    pos += child.nodeSize;
  });
  if (found == null && runFrom >= 0 && from >= runFrom && to <= pos && runExpr)
    found = { runFrom, runTo: pos, expr: runExpr, display: runDisplay };
  return found;
}

/** What `extentForSelection` yields: the mark range + precise extent, plus (for math) the run's expression +
 *  display flag so the popover can HULL-check the target (P1) before offering brace kinds. */
export interface SelectionExtent {
  from: number;
  to: number;
  extent: AnnoExtentAttr;
  expr?: MathExpression;
  display?: boolean;
}

/** The PRECISE extent + the mark range for the current selection, or null when nothing annotatable is
 *  selected. A math selection → a `sub_term` (its `term_path` recovered by inverting `surfacePaths`, root
 *  fallback); a plain prose selection → a `prose_span`. Multi-line/system math is deferred to slice 1b. */
export function extentForSelection(state: EditorState): SelectionExtent | null {
  const { from, to } = state.selection;
  if (from >= to) return null; // need a real target range

  const run = mathRunAt(state.doc, from, to);
  const dbg = (globalThis as unknown as { __annoDebug?: unknown[] }).__annoDebug;
  if (Array.isArray(dbg))
    dbg.push({
      phase: 'extent',
      from,
      to,
      run: run ? { runFrom: run.runFrom, runTo: run.runTo, display: run.display } : null,
    });
  if (run) {
    // Gate SYSTEMS (≥2 co-equal rows — slice 1b needs row-scoped extents), NOT newlines: the display cue
    // authors a single equation as `$$⏎…⏎$$`, so its surface contains `\n` and a newline gate silently
    // blocked EVERY cue-created display equation (the reported "display can't be annotated"). A `\n` is one
    // char in the surface and one hard_break position in the doc, so the linear map below stays exact.
    const surface = run.expr.surface_text ?? '';
    if (splitSystemRows(surface).length >= 2) return null;
    const inner = surface;
    // SNAP TO STRUCTURE, structure-first: trim whitespace off the selected span, then take the MAXIMAL
    // nodes it fully covers — their char hull [hs, he) is what the hand actually selected, snapped to
    // structure. A node whose span IS the hull → `sub_term` (deepest such node — the precise, edit-stable
    // binding; the root results only when the selection genuinely spans the whole expression). NO such node
    // → an `expression_span` over the hull: a legitimate mathematical range that is not one AST node (an
    // associative sub-chain — `Sigma' times {L, S, R}` in the left-nested `Q times Sigma' times {L, S, R}`,
    // the reported can't-annotate). No covered node at all (a drag inside one token) → the DEEPEST node
    // ENCLOSING the trimmed span, as before. Trimming uses the doc text (identical to the surface between
    // the delimiters).
    let selFrom = from;
    let selTo = to;
    // leafText '\n': a hard_break is one leaf position ↔ one `\n` char in the surface, keeping this string
    // index-aligned with doc positions (the 3rd arg is the BLOCK separator, which never fires within a run).
    const docText = state.doc.textBetween(run.runFrom, run.runTo, '', '\n');
    while (selFrom < selTo && /\s/.test(docText[selFrom - run.runFrom] ?? '')) selFrom += 1;
    while (selTo > selFrom && /\s/.test(docText[selTo - 1 - run.runFrom] ?? '')) selTo -= 1;
    // The doc position of SURFACE CHAR 0 — derived by ALIGNING the run's doc text with the surface, never by
    // an assumed delimiter width: a single-line `$…$`/`$$…$$` run CONTAINS its fences (surface starts at
    // +1/+2), but a cue-authored display block's runs break at hard_breaks, so the clicked run is one bare
    // CONTENT row with NO fences while the surface still carries its `\n`s — the fixed `+2` shifted every
    // char offset two left and systematically bound the parent node (clicking `b` braced `(a+b)`, `a` the
    // group: the reported display mis-binding). Run-inside-surface uses the run's surrounding `\n`s to
    // disambiguate; a failed alignment (stale expr) falls back to the fence heuristic.
    let srcStart: number;
    const runInDoc = docText.indexOf(inner);
    if (runInDoc >= 0) {
      srcStart = run.runFrom + runInDoc; // the run contains the surface (fenced single-line form)
    } else {
      const docInSurface = inner.indexOf(docText);
      srcStart =
        docInSurface >= 0 ? run.runFrom - docInSurface : run.runFrom + (run.display ? 2 : 1);
    }
    const cpFrom = utf16ToCp(inner, Math.max(0, selFrom - srcStart));
    const cpTo = utf16ToCp(inner, Math.max(0, selTo - srcStart));
    // Root (whole expression) fallback when the runtime is down — annotate must always yield a binding.
    let extent: AnnoExtentAttr = { kind: 'sub_term', expressionId: run.expr.id, termPath: [] };
    if (isMathRuntimeReady()) {
      const paths = surfacePaths(inner);
      const covered = maximalCovered(paths, cpFrom, cpTo);
      if (covered.length > 0) {
        const hs = Math.min(...covered.map((p) => p.charSpan.start));
        const he = Math.max(...covered.map((p) => p.charSpan.end));
        let exact: (typeof paths)[number] | undefined;
        for (const p of paths) {
          if (p.charSpan.start !== hs || p.charSpan.end !== he) continue;
          if (!exact || p.path.length > exact.path.length) exact = p;
        }
        extent = exact
          ? { kind: 'sub_term', expressionId: run.expr.id, termPath: exact.path }
          : { kind: 'expression_span', expressionId: run.expr.id, start: hs, end: he };
      } else {
        const enclosing = paths.filter((p) => p.charSpan.start <= cpFrom && cpTo <= p.charSpan.end);
        let best: (typeof enclosing)[number] | undefined;
        for (const p of enclosing) {
          if (
            !best ||
            p.path.length > best.path.length ||
            (p.path.length === best.path.length &&
              p.charSpan.end - p.charSpan.start < best.charSpan.end - best.charSpan.start)
          )
            best = p;
        }
        if (best) extent = { kind: 'sub_term', expressionId: run.expr.id, termPath: best.path };
      }
    }
    if (Array.isArray(dbg)) dbg.push({ phase: 'extent-result', srcStart, extent });
    // The mark spans the WHOLE `$…$`/`$$…$$` run (runFrom..runTo), never a sub-range: an annoRef over only
    // PART of an inline `mathExpr` run would split that text node, and `blockToProse` emits one Math atom PER
    // mathExpr text node → TWO atoms for one expression → `save_content` 422. The bound target is named by
    // the extent (path or char span), not the mark range, so spanning the whole run loses nothing.
    return { from: run.runFrom, to: run.runTo, extent, expr: run.expr, display: run.display };
  }

  // A plain prose phrase: the selection must be a text range in ONE prose block (no cross-block spans).
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if ($from.depth < 1 || !$from.sameParent($to) || $from.parent.type.name !== 'prose') return null;
  if ($from.parent.attrs.heading as boolean) return null; // a heading title isn't an annotation target (v1)
  // SNAP the mark ends to WHOLE math runs: a prose_span whose edge lands inside a `$…$` run would mark only
  // part of the mathExpr text node, SPLITTING it — and the flush then emits two Math atoms for one
  // expression → a 422. Never split a run: widen the edge to the run's boundary.
  let pFrom = from;
  let pTo = to;
  const blockStart = $from.start();
  let pos = blockStart;
  $from.parent.forEach((child) => {
    const isMath = child.isText && child.marks.some((m) => m.type === MATH);
    if (isMath) {
      const rs = pos;
      const re = pos + child.nodeSize;
      if (pFrom > rs && pFrom < re) pFrom = rs;
      if (pTo > rs && pTo < re) pTo = re;
    }
    pos += child.nodeSize;
  });
  return { from: pFrom, to: pTo, extent: { kind: 'prose_span' } };
}

/** P1 (the outer-hull rule) at GESTURE time: which brace sides are valid for the selected target. A math
 *  sub-term is checked by rendering the expression OFF-SCREEN (tagged) and running `hullSides` on the
 *  target's rect vs its sibling `data-path` rects — off-screen because the LIVE inline render is hidden while
 *  the selection touches it (source revealed), and the check must not depend on that. Coordinates are only
 *  compared relatively, so the hidden container's frame is fine. Prose phrases are always hull (their line IS
 *  the hull); degraded environments (runtime down / zero-area rects, e.g. jsdom) stay permissive. */
const hullCache = new Map<string, { over: boolean; under: boolean }>();

export function validBraceSides(sel: SelectionExtent): { over: boolean; under: boolean } {
  if (sel.extent.kind === 'prose_span' || !sel.expr) return { over: true, under: true };
  if (sel.extent.kind === 'sub_term' && sel.extent.termPath.length === 0)
    return { over: true, under: true }; // the whole expression
  if (!isMathRuntimeReady()) return { over: true, under: true };
  // CACHED per (expr, target, surface, display): the check renders the expression OFF-SCREEN with KaTeX —
  // far too heavy to run per selection tick (the popover refreshes on every transaction of a drag).
  const targetKey =
    sel.extent.kind === 'sub_term'
      ? sel.extent.termPath.join('.')
      : `s${sel.extent.start}-${sel.extent.end}`;
  const cacheKey = `${sel.extent.expressionId}|${targetKey}|${sel.expr.surface_text ?? ''}|${sel.display ? 'd' : 'i'}`;
  const cached = hullCache.get(cacheKey);
  if (cached) return cached;
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.visibility = 'hidden';
  host.style.left = '-99999px';
  host.style.top = '0';
  document.body.appendChild(host);
  try {
    renderMathInto(sel.expr, host, { display: sel.display ?? false, tagged: true });
    let sides: { over: boolean; under: boolean };
    if (sel.extent.kind === 'expression_span') {
      sides = spanHullSides(host, sel.expr.surface_text ?? '', sel.extent.start, sel.extent.end);
    } else {
      const pathStr = sel.extent.termPath.join('.');
      const nodes: PathBoxLike[] = Array.from(
        host.querySelectorAll<HTMLElement>('[data-path]'),
      ).flatMap((el) => {
        const r = tightRect(el); // glyph-tight — vlist struts overlap neighbours and skew the hull
        if (!r) return [];
        return [
          {
            path: el.dataset.path ?? '',
            rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          },
        ];
      });
      if (!nodes.some((n) => n.path === pathStr)) return { over: true, under: true };
      sides = hullSidesAt(pathStr, nodes);
    }
    const dbg = (globalThis as unknown as { __annoDebug?: unknown[] }).__annoDebug;
    if (Array.isArray(dbg)) dbg.push({ phase: 'sides', cacheKey, ...sides });
    if (hullCache.size > 200) hullCache.clear(); // tiny bound; entries are per-target
    hullCache.set(cacheKey, sides);
    return sides;
  } finally {
    host.remove();
  }
}

/** Bind a brace annotation of `kind` to the current selection (target-first). Mints a fresh annotation +
 *  target id and stamps the `annoRef` mark carrying the whole slice-1a annotation over the selected range;
 *  the overlay then renders the brace and focuses its caption editor. No-op (returns false) when nothing
 *  annotatable is selected — so a bare keypress falls through. */
export function annotate(kind: BraceKind): Command {
  return (state, dispatch) => {
    const sel = extentForSelection(state);
    if (!sel) return false;
    if (!dispatch) return true;
    const mark = ANNO.create({
      annotationId: uuidv7(),
      targetId: uuidv7(),
      kind,
      gap: 'small',
      label: '',
      extent: sel.extent,
    });
    // COLLAPSE the selection after binding: the target is chosen, so the contextual popover must dismiss (an
    // uncollapsed selection would re-open it on the next update, overlapping the fresh brace/label). For a
    // math target, SUPPRESS the source reveal on this transaction: the collapsed caret still touches the
    // span's boundary, and without the suppressor the render would drop — the brace would only appear after
    // the caret moved away (the reported "appears only once the equation re-renders").
    let tr = state.tr.addMark(sel.from, sel.to, mark);
    tr.setSelection(TextSelection.create(tr.doc, sel.to));
    if (sel.extent.kind !== 'prose_span') tr = suppressMathRevealAt(tr, sel.from);
    dispatch(tr);
    return true;
  };
}

/** The RENDERED box of a math selection's target — the popover's anchor (the selection itself sits in hidden
 *  source text). A `sub_term` is its `[data-expr-id] [data-path]` element's tight box (the overlay's
 *  scoping); an `expression_span` is the union of its covered nodes' glyph boxes. Null when the render is
 *  absent. */
function mathTargetRectFor(view: EditorView, sel: SelectionExtent): DOMRect | null {
  if (sel.extent.kind === 'prose_span') return null;
  const $from = view.state.doc.resolve(sel.from);
  if ($from.depth < 1) return null;
  const blockDom = view.nodeDOM($from.before(1));
  if (!(blockDom instanceof HTMLElement)) return null;
  const exprEl = blockDom.querySelector<HTMLElement>(`[data-expr-id="${sel.extent.expressionId}"]`);
  if (!exprEl) return null;
  if (sel.extent.kind === 'expression_span') {
    const rects = spanGlyphRects(
      exprEl,
      sel.expr?.surface_text ?? '',
      sel.extent.start,
      sel.extent.end,
    ).filter((r) => r.width > 0 && r.height > 0);
    const u: RectLike | null = unionRect(
      rects.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })),
    );
    return u ? new DOMRect(u.left, u.top, u.right - u.left, u.bottom - u.top) : null;
  }
  const el = exprEl.querySelector<HTMLElement>(`[data-path="${sel.extent.termPath.join('.')}"]`);
  if (!el) return null;
  return tightRect(el); // glyph-tight (a vlist container's own box centers the menu off the target)
}

/** An EXISTING annotation with the same kind on the same target as `sel`, if any (same-target+same-kind →
 *  edit, never duplicate): a `sub_term` matches by expressionId+termPath; a `prose_span` by its occurrence
 *  range equalling the (snapped) selection range. */
function existingSameAnnotation(
  state: EditorState,
  sel: SelectionExtent,
  kind: BraceKind,
): string | null {
  for (const o of annoOccurrences(state.doc)) {
    const attrs = o.attrs as unknown as {
      kind: BraceKind;
      extent: AnnoExtentAttr | null;
      annotationId: string;
    };
    if (attrs.kind !== kind || !attrs.extent) continue;
    if (sel.extent.kind === 'sub_term' && attrs.extent.kind === 'sub_term') {
      if (
        attrs.extent.expressionId === sel.extent.expressionId &&
        attrs.extent.termPath.join('.') === sel.extent.termPath.join('.')
      )
        return o.annotationId;
    } else if (sel.extent.kind === 'expression_span' && attrs.extent.kind === 'expression_span') {
      if (
        attrs.extent.expressionId === sel.extent.expressionId &&
        attrs.extent.start === sel.extent.start &&
        attrs.extent.end === sel.extent.end
      )
        return o.annotationId;
    } else if (sel.extent.kind === 'prose_span' && attrs.extent.kind === 'prose_span') {
      if (o.from === sel.from && o.to === sel.to) return o.annotationId;
    }
  }
  return null;
}

/** The contextual annotate popover (target-first, modeless): a small floating menu shown whenever a
 *  non-empty ANNOTATABLE selection exists, positioned just below the TARGET — offering ONLY the brace
 *  kinds the outer-hull rule permits for that target (P1: a denominator gets Under only, a numerator Over
 *  only — a brace never creates space inside an expression). Choosing a kind runs `annotate`; the overlay
 *  renders the brace. A single out-of-band element in <body> (the blockHandle idiom) so it never perturbs
 *  the document or the caret. Left/right (equation-set) braces are slice 1b. */
export const annotationPopover = new Plugin({
  view(view) {
    const menu = document.createElement('div');
    menu.className = 'mm-anno-popover';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'annotate selection');
    menu.style.display = 'none';
    const addBtn = (label: string, kind: BraceKind): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep the selection; annotate acts on it, then hide
        // SAME target + SAME kind → don't duplicate: focus the EXISTING annotation's caption for editing
        // (the user's chosen semantics — a second identical brace is never what anyone means).
        const sel = extentForSelection(view.state);
        const existingId = sel ? existingSameAnnotation(view.state, sel, kind) : null;
        hide();
        if (existingId) {
          const caption = document.querySelector<HTMLElement>(
            `.mm-anno-overlay [data-anno-id="${existingId}"] .anno-caption`,
          );
          caption?.focus();
          return;
        }
        annotate(kind)(view.state, view.dispatch.bind(view));
      });
      menu.appendChild(b);
      return b;
    };
    const overBtn = addBtn('⏞ Over', 'overbrace');
    const underBtn = addBtn('⏟ Under', 'underbrace');
    // "✎ source" — the guaranteed mouse path INTO the source now that a dblclick structurally selects a
    // sub-term without revealing: reveals the `$…$`/`$$…$$` source and drops the caret inside (no suppress
    // meta → mathLivePreview un-renders as usual). Shown for math targets only.
    const sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.textContent = '✎ source';
    sourceBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const sel = extentForSelection(view.state);
      if (sel && sel.extent.kind !== 'prose_span') {
        const inside = TextSelection.create(
          view.state.doc,
          Math.min(view.state.selection.from, sel.to),
        );
        view.dispatch(view.state.tr.setSelection(inside)); // no suppress → source reveals for editing
        view.focus();
      }
      hide();
    });
    menu.appendChild(sourceBtn);
    document.body.appendChild(menu);

    const hide = (): void => {
      menu.style.display = 'none';
    };
    // While a mouse DRAG is in progress the popover stays hidden and NO expensive work runs (each drag step
    // is a selection transaction — hull checks/offscreen renders per tick swamp the main thread); one
    // refresh runs when the button is released.
    let mouseDown = false;
    const onDown = (e: MouseEvent): void => {
      if (e.button === 0) mouseDown = true;
    };
    const onUp = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      mouseDown = false;
      setTimeout(() => refresh(view), 0); // after PM applies the final selection
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    const refresh = (v: typeof view): void => {
      if (mouseDown) {
        hide();
        return;
      }
      const sel = extentForSelection(v.state);
      if (!sel) {
        hide();
        return;
      }
      const sides = validBraceSides(sel); // P1: only hull-valid kinds are offered
      if (!sides.over && !sides.under) {
        hide(); // an interior target — braces can't reach it (future non-reserving kinds will)
        return;
      }
      overBtn.style.display = sides.over ? '' : 'none';
      underBtn.style.display = sides.under ? '' : 'none';
      sourceBtn.style.display = sel.extent.kind !== 'prose_span' ? '' : 'none';
      // ANCHOR at the TARGET, not the selection: a math selection sits in `display:none` source text, whose
      // `coordsAtPos` is (0,0) — the popover used to fly to the top-left corner. For a sub_term, anchor to
      // the rendered target's box (the overlay's expr-scoped `data-path` resolution); prose keeps coordsAtPos.
      let left: number;
      let top: number;
      const target = sel.extent.kind !== 'prose_span' ? mathTargetRectFor(v, sel) : null;
      if (target) {
        left = target.left + target.width / 2 - 40;
        top = target.bottom + 8;
      } else {
        const coords = v.coordsAtPos(v.state.selection.to);
        left = coords.left;
        top = coords.bottom + 6;
      }
      menu.style.display = 'flex';
      menu.style.left = `${window.scrollX + left}px`;
      menu.style.top = `${window.scrollY + top}px`;
      // Clamp into the viewport (measure after display).
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth - 8)
        menu.style.left = `${window.scrollX + window.innerWidth - 8 - mr.width}px`;
      if (mr.left < 8) menu.style.left = `${window.scrollX + 8}px`;
      if (mr.bottom > window.innerHeight - 8)
        menu.style.top = `${window.scrollY + (target ? target.top : top) - mr.height - 8}px`;
    };
    refresh(view);

    return {
      update: (v) => refresh(v),
      destroy: () => {
        window.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('mouseup', onUp, true);
        menu.remove();
      },
    };
  },
});
