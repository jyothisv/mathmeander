// The §6.2 brace-annotation OVERLAY engine — the uniform SVG render of every `annoRef` annotation (inline
// math, display math, prose — deliberately NOT KaTeX-native: one visual language, arbitrary future kinds +
// colors, and the P3 toggle). Three cooperating mechanisms, each pinned to a design principle:
//
//   P1 (outer-hull rule): a brace NEVER creates space inside an expression. At draw time a sub-term whose
//   braced edge no longer lies on its expression's outer hull (it moved interior when the math was edited)
//   is DEMOTED to the orphan caption instead of drawing an overlapping brace (braceGeom.hullSides; the
//   gesture in annoKeys offers only hull-valid sides up front).
//
//   P2 (outer-band-only, deficit-only reservation): space is reserved ONLY in the inter-line band at the
//   target's braced edge, and only by the DEFICIT after existing space. The mechanism is a FEEDBACK
//   CONTROLLER: each render pass measures the actual gap between the target's edge and the nearest content
//   band beyond it (line clustering of client rects), then adjusts a per-annotation SPACER height by the
//   error (band − gap). A zero-width inline-block spacer aligned `text-bottom` grows its LINE box upward
//   (`text-top` grows it downward) — so an INTERIOR line of a multi-line block gets its own space, which
//   block padding could never do. No font metrics needed: the loop converges on the observed gap (deadband
//   ±1px, monotone, clamped). A display equation owns its line, so its reserve is a margin applied to the
//   render element instead (same controller, linear → one-step convergence).
//
//   P3 (decoration-only, toggle-ready): the marks carry identity; EVERY visible artifact — brace, caption,
//   spacer, margin — is a decoration or overlay DOM. One `visible` flag (toggleAnnotations) drops them all
//   and the document reflows to PRISTINE (no placeholders), enabling future annotation-set cycling.
//
// PRECISION: a math sub-term resolves via `[data-expr-id="…"] [data-path="…"]` — the expr-id scope is what
// fixes the shipped wrong-expression bug (`data-path` values are per-expr-root, so they collide across the
// several `$…$` exprs of one block; an unscoped query grabbed the first). Prose resolves via a DOM Range.
// Geometry is browser-verified (jsdom returns zero rects); the pure parts live in braceGeom (node-tested).
import { Plugin, PluginKey, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { LayoutStep } from '@mathmeander/schema';
import { editorSchema } from './schema';
import type { AnnoExtentAttr, AnnoRefAttrs } from './projection';
import { annoOccurrences } from './annoRecognize';
import { suppressMathRevealAt } from './mathLivePreview';
import { glyphRects, tightRect } from './domGeom';
import { spanGlyphRects, spanHullSides } from './exprSpanGeom';
import { isMathRuntimeReady, surfacePaths } from './mathRuntime';
import {
  BRACE_DEPTH,
  LABEL_HEIGHT,
  type PathBoxLike,
  type RectLike,
  gapPx,
  horizontalBracePath,
  hullSidesAt,
  isHorizontalBrace,
  isLeadingBrace,
  reservedBand,
  unionRect,
} from './braceGeom';

const ANNO = editorSchema.marks.annoRef;
const SVG_NS = 'http://www.w3.org/2000/svg';
// Runaway clamp for the feedback loop: a band is ~31px, so anything past ~4× is pathological — the SAFETY
// VALVE (stall detection) should freeze a mis-measuring annotation long before this.
const MAX_SPACER = 120;

/** Per-annotation reserve heights (px) the feedback controller converged on: `top` grows the target's line
 *  upward (overbrace band), `bottom` downward (underbrace). `display` marks a display-equation target — its
 *  reserve rides the render element's MARGIN, so no spacer widget is emitted for it (a spacer would land in
 *  the hidden source line and double the space the moment the source is revealed). */
type Spacers = Map<string, { top: number; bottom: number; display?: boolean }>;

/** A spacer only grows its line once taller than the line's text box; this base keeps the feedback loop's
 *  first step from being a no-op. The exact value is irrelevant — the loop converges on the measured GAP. */
const SPACER_BASE = 16;

/** One STACKING level's extra offset (px): a brace at level N draws (and reserves) this much farther from
 *  the content than level N−1, so overlapping same-side braces never collide (inner nearest the content). */
const LEVEL_STEP = BRACE_DEPTH + LABEL_HEIGHT + 4;

interface PluginState {
  spacers: Spacers;
  /** P3: the master toggle. Off → no spacer decorations, no overlay drawing → pristine layout. */
  visible: boolean;
}

type Meta = { type: 'spacers'; spacers: Spacers } | { type: 'toggle' };

const KEY = new PluginKey<PluginState>('annoLivePreview');

/** Toggle all annotation presentation on/off (P3). Content is untouched — only decorations + overlay go. */
export const toggleAnnotations: Command = (state, dispatch) => {
  if (!KEY.getState(state)) return false;
  if (dispatch)
    dispatch(
      state.tr.setMeta(KEY, { type: 'toggle' } satisfies Meta).setMeta('addToHistory', false),
    );
  return true;
};

/** One annotation as the overlay needs it: identity + primitive (kind/gap/label), the structural extent, the
 *  enclosing block's before-position, and the marked doc range. One per annotationId. */
export interface AnnoView {
  id: string;
  targetId: string;
  kind: AnnoRefAttrs['kind'];
  gap: LayoutStep;
  label: string;
  extent: AnnoExtentAttr;
  blockPos: number;
  from: number;
  to: number;
}

/** Every annotation in the doc as an `AnnoView`, reusing annoRecognize's merged occurrences (a phrase split
 *  by a styled sub-range is one view). Pure. */
export function collectAnnoViews(doc: PMNode): AnnoView[] {
  const views: AnnoView[] = [];
  const seen = new Set<string>();
  for (const o of annoOccurrences(doc)) {
    if (seen.has(o.annotationId)) continue;
    const $from = doc.resolve(o.from);
    if ($from.depth < 1) continue;
    const attrs = o.attrs as unknown as AnnoRefAttrs;
    if (!attrs.extent) continue;
    seen.add(o.annotationId);
    views.push({
      id: o.annotationId,
      targetId: attrs.targetId,
      kind: attrs.kind,
      gap: attrs.gap,
      label: attrs.label ?? '',
      extent: attrs.extent,
      blockPos: $from.before(1),
      from: o.from,
      to: o.to,
    });
  }
  return views;
}

const toRectLike = (r: DOMRect): RectLike => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
});

/** The rendered element of the view's EXPRESSION (`[data-expr-id]`), scoped inside its block. Null when the
 *  render is absent (source revealed / not a math target). */
function exprElFor(view: EditorView, v: AnnoView): HTMLElement | null {
  if (v.extent.kind === 'prose_span') return null;
  const blockDom = view.nodeDOM(v.blockPos);
  if (!(blockDom instanceof HTMLElement)) return null;
  return blockDom.querySelector<HTMLElement>(`[data-expr-id="${v.extent.expressionId}"]`);
}

/** The CURRENT surface text of the view's annotated math run (the `mathExpr` mark at the mark range's start)
 *  — what an `expression_span`'s char offsets index. Null when the range no longer starts in math. */
function surfaceForView(view: EditorView, v: AnnoView): string | null {
  const node = view.state.doc.nodeAt(v.from);
  const m = node?.marks.find((mk) => mk.type.name === 'mathExpr');
  if (!m) return null;
  return (m.attrs.expr as { surface_text?: string }).surface_text ?? '';
}

/** Resolve one annotation's bound structure to on-screen client rects (empty = unresolved → orphan). A
 *  `sub_term` is the `data-path` element INSIDE the right expression's render (`data-expr-id`-scoped — the
 *  wrong-expression fix). A `prose_span` is walked CHILD BY CHILD over the marked doc range — per-text-node
 *  sub-ranges plus each covered math run's RENDER box — never one raw Range over everything: a raw range
 *  reports fragment boxes for every element it crosses (our own reserve spacers, foreign widgets), and one
 *  polluted rect pins the union's edge to the line top, which starves the reserve feedback loop into runaway
 *  growth (the reported 300px+ gaps). Never throws. */
function rectsFor(view: EditorView, v: AnnoView): DOMRect[] {
  try {
    if (v.extent.kind === 'prose_span') {
      const out: DOMRect[] = [];
      const $from = view.state.doc.resolve(v.from);
      if ($from.depth < 1) return [];
      const block = $from.parent;
      const blockDom0 = view.nodeDOM(v.blockPos);
      const blockDom = blockDom0 instanceof HTMLElement ? blockDom0 : null;
      let pos = $from.start();
      block.forEach((child) => {
        const cs = pos;
        const ce = pos + child.nodeSize;
        pos = ce;
        if (ce <= v.from || cs >= v.to) return;
        if (child.isText) {
          const mathMark = child.marks.find((m) => m.type.name === 'mathExpr');
          if (mathMark && blockDom) {
            // A covered math run: its geometry is the RENDER box (the source text may be display:none).
            const exprId = (mathMark.attrs.expr as { id: string }).id;
            const el = blockDom.querySelector<HTMLElement>(`[data-expr-id="${exprId}"]`);
            if (el) {
              out.push(el.getBoundingClientRect());
              return;
            }
          }
          const s = Math.max(cs, v.from);
          const e = Math.min(ce, v.to);
          if (e <= s) return;
          // Range over the DOM TEXT NODE itself, never element boundaries: `domAtPos(s)` at the annotation's
          // start resolves to an ELEMENT boundary when our own spacer widget sits at that position, and an
          // element-boundary Range reports line-fragment rects that INCLUDE the spacer — the union's edge
          // then never responds to the reserve and the feedback loop starves (the observed 300px+ runaway).
          // Probing at `s + 1` (inside the text) always lands in the text node.
          const probe = view.domAtPos(s + 1);
          const tn = probe.node;
          if (tn.nodeType !== Node.TEXT_NODE) return;
          const startOff = Math.max(0, probe.offset - 1);
          const endOff = Math.min(startOff + (e - s), (tn.nodeValue ?? '').length);
          const range = document.createRange();
          range.setStart(tn, startOff);
          range.setEnd(tn, endOff);
          out.push(...Array.from(range.getClientRects()));
        } else if (child.isAtom) {
          const dom = view.nodeDOM(cs);
          if (dom instanceof HTMLElement) out.push(dom.getBoundingClientRect());
        }
      });
      return out;
    }
    const exprEl = exprElFor(view, v);
    if (!exprEl) return [];
    if (v.extent.kind === 'expression_span') {
      const surface = surfaceForView(view, v);
      if (surface == null) return [];
      // The covered nodes' glyph boxes (structural resolution of the char range at render time).
      return spanGlyphRects(exprEl, surface, v.extent.start, v.extent.end);
    }
    const pathStr = v.extent.termPath.join('.');
    const el = exprEl.querySelector<HTMLElement>(`[data-path="${pathStr}"]`);
    if (!el) return [];
    // TIGHT boxes: the container's own rect carries KaTeX vlist strut/padding geometry (an exponent's
    // `msupsub` box extends far beyond the glyph, drawing the brace visibly off the `2`). Measure the
    // visible glyphs (shared with hit-testing/hull/popover via domGeom); container rect only as fallback.
    const glyphs = glyphRects(el);
    return glyphs.length > 0 ? glyphs : Array.from(el.getClientRects());
  } catch {
    return [];
  }
}

/** P1 at draw time: does the target's braced edge still lie on its expression's outer hull? (An edit can move
 *  a once-hull sub-term interior; then the brace must NOT draw into the expression.) Prose is always hull. */
function sideStillValid(view: EditorView, v: AnnoView): boolean {
  if (v.extent.kind === 'prose_span') return true;
  const exprEl = exprElFor(view, v);
  if (!exprEl) return false;
  if (v.extent.kind === 'expression_span') {
    const surface = surfaceForView(view, v);
    if (surface == null) return false;
    const sides = spanHullSides(exprEl, surface, v.extent.start, v.extent.end);
    return isLeadingBrace(v.kind) ? sides.over : sides.under;
  }
  const pathStr = v.extent.termPath.join('.');
  const nodes: PathBoxLike[] = [];
  for (const el of Array.from(exprEl.querySelectorAll<HTMLElement>('[data-path]'))) {
    const r = tightRect(el); // tight glyph boxes — vlist struts overlap neighbours and skew the hull
    if (r) nodes.push({ path: el.dataset.path ?? '', rect: toRectLike(r) });
  }
  const sides = hullSidesAt(pathStr, nodes);
  return isLeadingBrace(v.kind) ? sides.over : sides.under;
}

/** Cluster a block's content rects into vertical LINE bands (sorted top→bottom): rects whose vertical
 *  intervals overlap merge into one band. The inter-line gap measurement's coordinate system. */
export function lineBands(rects: RectLike[]): { top: number; bottom: number }[] {
  const sorted = rects
    .filter((r) => r.bottom - r.top > 0.5)
    .slice()
    .sort((a, b) => a.top - b.top);
  const bands: { top: number; bottom: number }[] = [];
  for (const r of sorted) {
    const last = bands[bands.length - 1];
    if (last && r.top < last.bottom) last.bottom = Math.max(last.bottom, r.bottom);
    else bands.push({ top: r.top, bottom: r.bottom });
  }
  return bands;
}

/** The manager for the out-of-band overlay DOM + the reserve feedback controller (one per editor view). */
class AnnoOverlay {
  private container: HTMLDivElement;
  private editingLabel = false; // while a caption is focused, don't clobber it with a recompute
  private destroyed = false;
  /** Display render elements we set imperative reserve margins on (cleared on toggle-off/removal). */
  private margined = new Set<HTMLElement>();
  /** Per annotation+side controller telemetry for the SAFETY VALVES (stall/flip → freeze, never balloon
   *  or cycle on bad data). */
  private progress = new Map<
    string,
    { gap: number; h: number; stalls: number; flips: number; lastDelta: number }
  >();
  /** The rAF-coalesced reserve dispatch (freeze-proofing — see syncReserves). */
  private rafHandle: number | null = null;
  private pendingSpacers: Spacers | null = null;
  /** A rAF-coalesced re-RENDER (no dispatch): scheduled when the imperatively applied display padding
   *  CHANGED without the spacer map changing (e.g. deleting the annotation whose max held the shared
   *  padding while the survivor's height is 0) — the controller must re-measure the layout its own
   *  mutation produced, or the survivor's reserve stays wrong forever. */
  private renderRaf: number | null = null;
  /** Last pass's caption lifts (annotationId → px) — HYSTERESIS for the collision pass: a lift feeds the
   *  reserve band, the band moves the layout, and a knife-edge collision then flips on/off pass-to-pass —
   *  a slow limit cycle (pad breathing by one label step). A lift is kept until dropping one step clears
   *  every obstacle WITH margin. */
  private labelLifts = new Map<string, number>();
  private readonly onScroll = () => this.render();
  private readonly onResize = () => this.render();

  constructor(private view: EditorView) {
    this.container = document.createElement('div');
    this.container.className = 'mm-anno-overlay';
    document.body.appendChild(this.container);
    window.addEventListener('scroll', this.onScroll, true); // capture → inner scrollers too
    window.addEventListener('resize', this.onResize);
    if (typeof window.visualViewport !== 'undefined')
      window.visualViewport?.addEventListener('resize', this.onResize);
    this.render();
  }

  update(): void {
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
    if (this.renderRaf != null) cancelAnimationFrame(this.renderRaf);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.clearMargins();
    this.container.remove();
  }

  private clearMargins(): void {
    for (const el of this.margined) {
      el.style.paddingTop = '';
      el.style.paddingBottom = '';
    }
    this.margined.clear();
  }

  /** This view's exact mark instance (attrs-equal) — removeMark with an INSTANCE strips only this
   *  annotation; the bare TYPE would strip every coexisting annotation on the range (`excludes: ''`). */
  private markOf(v: AnnoView, label = v.label): ReturnType<typeof ANNO.create> {
    return ANNO.create({
      annotationId: v.id,
      targetId: v.targetId,
      kind: v.kind,
      gap: v.gap,
      label,
      extent: v.extent,
    });
  }

  /** Rewrite the annotation caption on the mark (blur-committed). A math target keeps its render SUPPRESSED
   *  through this doc-changing transaction — otherwise committing a caption while the caret still touches the
   *  span boundary would reveal the source and drop the brace mid-edit. */
  private commitLabel(v: AnnoView, text: string): void {
    if (text === v.label) return;
    let tr = this.view.state.tr
      .removeMark(v.from, v.to, this.markOf(v))
      .addMark(v.from, v.to, this.markOf(v, text));
    if (v.extent.kind === 'sub_term') tr = suppressMathRevealAt(tr, v.from);
    this.view.dispatch(tr);
  }

  /** Remove THIS annotation only (strip its mark instance → the drain deletes it server-side). A math
   *  target keeps its render SUPPRESSED through the removal (the commitLabel idiom): without it the
   *  doc-changing transaction REVEALED the `$…$`/`$$…$$` source — the block ballooned by the source rows,
   *  the surviving annotations' gap over-read against the source line, their reserve dropped, and the page
   *  bounced up and down until the caret left the span (the reported delete flicker). */
  private removeAnnotation(v: AnnoView): void {
    this.editingLabel = false;
    let tr = this.view.state.tr.removeMark(v.from, v.to, this.markOf(v));
    if (v.extent.kind !== 'prose_span') tr = suppressMathRevealAt(tr, v.from);
    this.view.dispatch(tr);
    this.view.focus();
  }

  private render(): void {
    if (this.editingLabel) return;
    const ps = KEY.getState(this.view.state);
    this.container.replaceChildren();
    if (!ps || !ps.visible) {
      this.clearMargins(); // P3: pristine — no braces, no reserved space
      return;
    }
    const doc = this.view.state.doc;
    const views = collectAnnoViews(doc).filter((v) => isHorizontalBrace(v.kind));
    // ONE geometry pass per annotation: rects → union, hull demote, and the braced edge's GAP to the nearest
    // content band beyond it (`bound`) — shared by the draw (as its overlap guard) and the reserve controller.
    const geos: {
      v: AnnoView;
      u: RectLike | null;
      blockDom: HTMLElement | null;
      gap: number | null;
      bound: number | null;
      lineEdge: number | null;
      level: number;
      /** Slab layout outputs (per-side group): the brace's cumulative outward offset + its caption ROW y. */
      off: number;
      rowY: number | null;
    }[] = [];
    const dbgDraw = (window as unknown as { __annoDebug?: unknown[] }).__annoDebug;
    for (const v of views) {
      const rects = rectsFor(this.view, v).filter((r) => r.width > 0 && r.height > 0);
      let u = unionRect(rects.map(toRectLike));
      const resolved = u != null;
      if (u && !sideStillValid(this.view, v)) u = null; // P1: gone interior → orphan, no brace
      if (Array.isArray(dbgDraw))
        dbgDraw.push({
          phase: 'draw',
          id: v.id,
          extent: v.extent,
          rects: rects.length,
          resolved,
          demoted: resolved && u == null,
        });
      const blockDom0 = this.view.nodeDOM(v.blockPos);
      const blockDom = blockDom0 instanceof HTMLElement ? blockDom0 : null;
      let gap: number | null = null;
      let bound: number | null = null;
      let lineEdge: number | null = null;
      if (u && blockDom) {
        // The nearest content beyond the braced edge: the adjacent content of the same block when there is
        // any, else the neighbouring block's edge, else the BLOCK'S OWN edge (never the editor's — measured
        // pre-reflow it reports a huge phantom gap, so nothing reserves and the brace crosses the block
        // border; against the block's own box the band must fit INSIDE it, growing block + container).
        // The edge is judged PER RECT (the hull idiom), never on merged line bands: a revealed source line
        // grazing the equation MERGES bands, which flipped the bound from the source line's bottom to the
        // block top — a discontinuity the feedback controller turned into a permanent grow/shrink limit
        // cycle (page flicker). Three rules make the per-rect edge both correct and CONTINUOUS in layout:
        //   • only rects HORIZONTALLY overlapping the target block its band (hull logic — a same-line
        //     neighbour off to the side, like the exponent beside `b`, never counts as "the line above");
        //   • a rect VERTICALLY CONTAINING the target is same-line context, never beyond-the-edge content:
        //     a text node's range rect next to a tall spacer inflates to the FULL line box, so its bottom
        //     rode the growing line and read gap 0 forever (the reserve ballooned to the stall valve);
        //   • a rect is beyond the edge by its vertical CENTER (grazing boxes don't flip classification);
        //   • its contribution clamps at the target's edge (an overlapping box reads gap 0, never negative
        //     — the controller then grows the reserve smoothly instead of ballooning).
        const blockRect = blockDom.getBoundingClientRect();
        const contentRects = this.blockContentRects(blockDom);
        // The LINE-protection edge for caption row 0 (a caption on a small target must never sit on
        // same-line glyphs — the exponent-covering bug): the annotated EXPRESSION's tight glyph box for a
        // math target, the phrase box itself for prose. NEVER the merged line bands — their text rects
        // inflate to the full grown line box and hoisted row 0 far above the braces (the swallowed
        // caption).
        const exprEl = v.extent.kind !== 'prose_span' ? exprElFor(this.view, v) : null;
        const exprTight = exprEl ? tightRect(exprEl) : null;
        const overlapsX = (r: RectLike): boolean =>
          Math.min(r.right, u!.right) - Math.max(r.left, u!.left) > 1;
        const containsU = (r: RectLike): boolean =>
          r.top <= u!.top + 1 && r.bottom >= u!.bottom - 1;
        if (isLeadingBrace(v.kind)) {
          const top = u.top;
          const above = contentRects.filter(
            (r) => overlapsX(r) && !containsU(r) && (r.top + r.bottom) / 2 < top,
          );
          const aboveEdge =
            above.length > 0
              ? Math.max(...above.map((r) => Math.min(r.bottom, top)))
              : (blockDom.previousElementSibling?.getBoundingClientRect().bottom ?? blockRect.top);
          // Clamp to the BLOCK'S OWN edge: an inter-block margin is outside the block's visible bounds
          // (typed blocks have a background), so it must never be credited as available band space.
          bound = Math.max(aboveEdge, blockRect.top);
          gap = u.top - bound;
          lineEdge = exprTight ? exprTight.top : u.top;
        } else {
          const bottom = u.bottom;
          const below = contentRects.filter(
            (r) => overlapsX(r) && !containsU(r) && (r.top + r.bottom) / 2 > bottom,
          );
          const belowEdge =
            below.length > 0
              ? Math.min(...below.map((r) => Math.max(r.top, bottom)))
              : (blockDom.nextElementSibling?.getBoundingClientRect().top ?? blockRect.bottom);
          bound = Math.min(belowEdge, blockRect.bottom);
          gap = bound - u.bottom;
          lineEdge = exprTight ? exprTight.bottom : u.bottom;
        }
      }
      geos.push({ v, u, blockDom, gap, bound, lineEdge, level: 0, off: 0, rowY: null });
    }

    // STACKING levels: same-block, same-side annotations that CONTAIN one another stack — the NARROWEST
    // brace sits nearest the content (level 0), wider/containing ones farther out. Containment is
    // STRUCTURAL for two math targets of the SAME expression (char-span superset — the truth), geometric
    // (box overlap on both axes) only across expressions/prose: pixel boxes GRAZE — an exponent's glyph
    // can horizontally overlap the neighbouring group's box by a hair at some zoom/DPR, which stacked an
    // UNRELATED annotation as if nested (its brace + caption hoisted above everything: the reported
    // regression).
    const exprSpanCache = new Map<string, Map<string, { start: number; end: number }> | null>();
    const structSpan = (
      g: (typeof geos)[number],
    ): { exprId: string; start: number; end: number } | null => {
      const ext = g.v.extent;
      if (ext.kind === 'prose_span') return null;
      if (ext.kind === 'expression_span')
        return { exprId: ext.expressionId, start: ext.start, end: ext.end };
      let spans = exprSpanCache.get(ext.expressionId);
      if (spans === undefined) {
        const surface = surfaceForView(this.view, g.v);
        spans =
          surface != null && isMathRuntimeReady()
            ? new Map(surfacePaths(surface).map((p) => [p.path.join('.'), p.charSpan]))
            : null;
        exprSpanCache.set(ext.expressionId, spans);
      }
      const span = spans?.get(ext.termPath.join('.'));
      return span ? { exprId: ext.expressionId, start: span.start, end: span.end } : null;
    };
    const groups = new Map<string, typeof geos>();
    geos.forEach((g, i) => {
      if (!g.u || !g.blockDom) return;
      const key = `${g.v.blockPos}:${isLeadingBrace(g.v.kind) ? 'top' : 'bottom'}`;
      const arr = groups.get(key) ?? [];
      arr.push(geos[i]!);
      groups.set(key, arr);
    });
    for (const arr of groups.values()) {
      const sorted = arr.slice().sort((a, b) => a.u!.right - a.u!.left - (b.u!.right - b.u!.left));
      for (let i = 0; i < sorted.length; i += 1) {
        const me = sorted[i]!;
        let level = 0;
        for (let j = 0; j < i; j += 1) {
          const other = sorted[j]!;
          const sMe = structSpan(me);
          const sOther = structSpan(other);
          let nested: boolean;
          if (sMe && sOther && sMe.exprId === sOther.exprId) {
            // `me` is the wider of the pair (width-sorted): it stacks OUTSIDE `other` only when it
            // structurally contains it as a PROPER superset of source chars.
            nested =
              sMe.start <= sOther.start &&
              sOther.end <= sMe.end &&
              (sMe.start < sOther.start || sOther.end < sMe.end);
          } else {
            const overlapsX =
              Math.min(me.u!.right, other.u!.right) - Math.max(me.u!.left, other.u!.left) > 1;
            const overlapsY =
              Math.min(me.u!.bottom, other.u!.bottom) - Math.max(me.u!.top, other.u!.top) > 1;
            nested = overlapsX && overlapsY;
          }
          if (nested) level = Math.max(level, other.level + 1);
        }
        me.level = level;
      }
    }

    // SLAB LAYOUT per (block, side, LINE) cluster — the "rows by NESTING" model: brace level N sits one
    // slab farther out than level N−1 (slab = LEVEL_STEP plus the SPREAD of level-(N−1) brace tops, so a
    // raised glyph's brace — an exponent — never pokes into the next slab), and CAPTION row N sits
    // directly beyond level-N's braces. Leaf captions read nearest the equation, containing annotations
    // above them ("outer = higher"). Row 0 additionally clamps past the line edge so a caption never sits
    // on same-line glyphs. The cluster is the annotation targets sharing a LINE (u rects chain-overlapping
    // vertically) — NEVER the whole block: a multi-line block's group spans lines, and a block-wide row
    // (max over ALL members' edges) laid line-1's caption at line-8's row while every band ballooned to
    // MAX_SPACER bridging the distance (the reported page-tall gaps).
    for (const groupArr of groups.values()) {
      const byTop = groupArr.slice().sort((a, b) => a.u!.top - b.u!.top);
      const clusters: (typeof geos)[] = [];
      // Targets of ONE expression share its line BY CONSTRUCTION (systems are gated to slice 1b) — never
      // let a knife-edge glyph gap split them across clusters (a raised exponent's box can miss its base
      // row's vertical range by a pixel at some zoom levels).
      const clusterByExpr = new Map<string, (typeof geos)[number][]>();
      for (const g of byTop) {
        const exprId = g.v.extent.kind !== 'prose_span' ? g.v.extent.expressionId : null;
        const structural = exprId ? clusterByExpr.get(exprId) : undefined;
        if (structural) {
          structural.push(g);
          continue;
        }
        const last = clusters[clusters.length - 1];
        const lastBottom = last ? Math.max(...last.map((m) => m.u!.bottom)) : -Infinity;
        let target: (typeof geos)[number][];
        if (last && g.u!.top < lastBottom) {
          last.push(g);
          target = last;
        } else {
          target = [g];
          clusters.push(target);
        }
        if (exprId) clusterByExpr.set(exprId, target);
      }
      for (const arr of clusters) this.layoutSlabs(arr);
    }

    const placed: { v: AnnoView; el: HTMLElement; svg: Element; leading: boolean }[] = [];
    for (const g of geos) {
      const p = this.drawHorizontal(g.v, g.u, g.bound, g.off, g.rowY);
      if (p) placed.push({ v: g.v, ...p });
    }
    const lifts = this.resolveLabelCollisions(placed);
    this.syncReserves(geos, ps.spacers, lifts);
  }

  /** One line-cluster's slab layout (see render): cumulative brace offsets by nesting level + the caption
   *  row per level, written onto the cluster's geo entries. */
  private layoutSlabs(
    arr: {
      v: AnnoView;
      u: RectLike | null;
      lineEdge: number | null;
      level: number;
      off: number;
      rowY: number | null;
    }[],
  ): void {
    {
      const leading = isLeadingBrace(arr[0]!.v.kind);
      const naturalEdge = (g: (typeof arr)[number]): number =>
        leading ? g.u!.top - gapPx(g.v.gap) - BRACE_DEPTH : g.u!.bottom + gapPx(g.v.gap);
      const maxLevel = Math.max(...arr.map((g) => g.level));
      const lineEdge = leading
        ? Math.min(...arr.map((g) => g.lineEdge ?? Infinity))
        : Math.max(...arr.map((g) => g.lineEdge ?? -Infinity));
      let off = 0;
      for (let n = 0; n <= maxLevel; n += 1) {
        const members = arr.filter((g) => g.level === n);
        if (members.length === 0) {
          off += LEVEL_STEP;
          continue;
        }
        const edges = members.map(naturalEdge);
        // The row of captions for THIS level sits just beyond the level's farthest brace edge.
        let rowY: number;
        if (leading) {
          rowY = Math.min(...edges.map((e) => e - off)) - 2 - LABEL_HEIGHT;
          if (n === 0 && Number.isFinite(lineEdge))
            rowY = Math.min(rowY, lineEdge - LABEL_HEIGHT - 1);
        } else {
          rowY = Math.max(...edges.map((e) => e + off)) + BRACE_DEPTH + 2;
          if (n === 0 && Number.isFinite(lineEdge)) rowY = Math.max(rowY, lineEdge + 1);
        }
        for (const g of members) {
          g.off = off;
          g.rowY = rowY;
        }
        off += LEVEL_STEP + (Math.max(...edges) - Math.min(...edges));
      }
    }
  }

  /** Post-draw caption de-collision: same-side captions that landed on overlapping spots (two level-0
   *  annotations on NEARBY targets clamp to overlapping rows — the reported "b two" merge). The group's
   *  BRACES are immovable obstacles (they pin to structure). Resolution is HORIZONTAL-FIRST: a colliding
   *  caption is nudged sideways to a free slot at its NATURAL height, so it stays directly above its own
   *  brace (side-by-side targets like `b` and `^2`); vertical staggering is only the FALLBACK for captions
   *  that can't move sideways (nested/stacked targets sharing the same x) — stacking builds a caption tower
   *  whose every level feeds the reserve, detaching captions ever farther from their braces (the reported
   *  floating captions). A vertical lift feeds the reserve band in syncReserves so the staggered caption
   *  still fits inside the reserved space. Returns annotationId → vertical lift px (horizontal nudges
   *  reserve nothing). */
  private resolveLabelCollisions(
    placed: { v: AnnoView; el: HTMLElement; svg: Element; leading: boolean }[],
  ): Map<string, number> {
    const lifts = new Map<string, number>();
    const groups = new Map<string, typeof placed>();
    for (const p of placed) {
      const key = `${p.v.blockPos}:${p.leading ? 'top' : 'bottom'}`;
      const arr = groups.get(key) ?? [];
      arr.push(p);
      groups.set(key, arr);
    }
    const GAP = 4;
    const step = LABEL_HEIGHT + 2;
    const intersects = (a: RectLike, b: RectLike): boolean =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const items = group
        .map((p) => ({ p, r: toRectLike(p.el.getBoundingClientRect()) }))
        .sort((a, b) => a.r.left - b.r.left);
      // Labels only — braces are NOT obstacles: the slab layout derives caption rows FROM the brace
      // geometry (row N above every level-N brace, 2px clear of level-N+1's by the LEVEL_STEP arithmetic),
      // so rows and braces are disjoint by construction; testing braces with the hysteresis margin made
      // the deliberately-tight rows read as collisions and parked captions rows too high.
      const settled: RectLike[] = [];
      for (const it of items) {
        const at = (lift: number): RectLike => {
          const dy = it.p.leading ? -lift : lift;
          return {
            left: it.r.left,
            right: it.r.right,
            top: it.r.top + dy,
            bottom: it.r.bottom + dy,
          };
        };
        const hits = (r: RectLike): boolean => settled.some((q) => intersects(q, r));
        const prev = this.labelLifts.get(it.p.v.id) ?? 0;
        if (prev === 0) {
          if (!hits(it.r)) {
            settled.push(it.r);
            continue;
          }
          // Horizontal try: the minimal sideways shift (either direction) that clears every settled rect,
          // capped so the caption never strays far from its brace.
          const width = it.r.right - it.r.left;
          const cap = Math.max(48, width);
          const shiftX = (r: RectLike, dx: number): RectLike => ({
            left: r.left + dx,
            right: r.right + dx,
            top: r.top,
            bottom: r.bottom,
          });
          const tryDir = (dir: -1 | 1): number | null => {
            let dx = 0;
            for (let i = 0; i < 8; i += 1) {
              const r = shiftX(it.r, dx);
              const hit = settled.find((q) => intersects(q, r));
              if (!hit) return Math.abs(dx) <= cap ? dx : null;
              dx = dir === 1 ? hit.right + GAP - it.r.left : hit.left - GAP - it.r.right;
            }
            return null;
          };
          const dxL = tryDir(-1);
          const dxR = tryDir(1);
          const dx =
            dxL != null && (dxR == null || Math.abs(dxL) < Math.abs(dxR)) ? dxL : (dxR ?? null);
          if (dx != null) {
            // style.left is the caption's CENTER (translateX(-50%)) — shifting it shifts the box by dx.
            it.p.el.style.left = `${parseFloat(it.p.el.style.left) + dx}px`;
            settled.push(shiftX(it.r, dx));
            continue;
          }
        }
        // Vertical path with HYSTERESIS: prefer the SMALLEST lift (from 0 up) that clears every obstacle
        // WITH margin — a global scan, not a step-wise descent from last pass's lift, which got trapped
        // above an intermediate obstacle (the caption stuck two rows high because stepping down passed
        // THROUGH another label even though its natural spot was clear: the swallowed/hoisted caption).
        // The margin is the hysteresis: a knife-edge clearance would flip back next pass (the lift feeds
        // the reserve band, the band moves the layout, the collision re-appears — a slow breathing cycle).
        // Failing all candidates ≤ prev, keep prev if clear, else GROW until clear.
        const clearWithMargin = (r: RectLike): boolean =>
          !hits({ left: r.left, right: r.right, top: r.top - GAP, bottom: r.bottom + GAP });
        let lift = prev;
        for (let cand = 0; cand < prev; cand += step) {
          if (clearWithMargin(at(cand))) {
            lift = cand;
            break;
          }
        }
        while (hits(at(lift)) && lift < prev + 4 * step) lift += step;
        if (lift > 0) {
          const top = parseFloat(it.p.el.style.top);
          it.p.el.style.top = `${top + (it.p.leading ? -lift : lift)}px`;
          lifts.set(it.p.v.id, lift);
        }
        settled.push(at(lift));
      }
    }
    this.labelLifts = lifts;
    return lifts;
  }

  /** P2 — the reserve FEEDBACK controller. For each resolvable annotation, take the measured gap between the
   *  target's braced edge and the nearest content band beyond it (its own grown line included in the target's
   *  position, so the measurement already reflects the applied reserve), then adjust the stored height by the
   *  error `band − gap` (deadband ±1px; clamped). Text-line targets get the height as a line SPACER widget
   *  (decorations below); a display equation (which owns its line) gets it as a render-element MARGIN, applied
   *  imperatively here. SAFETY VALVE: if a height keeps growing while its measured gap does not respond
   *  (a mis-measurement), the annotation FREEZES after 3 stalled attempts instead of ballooning the document.
   *  Set `window.__annoDebug = []` in the console to record per-pass controller telemetry. */
  private syncReserves(
    geos: {
      v: AnnoView;
      u: RectLike | null;
      blockDom: HTMLElement | null;
      gap: number | null;
      bound: number | null;
      off: number;
      rowY: number | null;
    }[],
    current: Spacers,
    lifts: Map<string, number>,
  ): void {
    const next: Spacers = new Map();
    const applyMargins: { el: HTMLElement; top: number; bottom: number }[] = [];
    const dbg = (window as unknown as { __annoDebug?: unknown[] }).__annoDebug;
    for (const { v, u, blockDom, gap, bound, off, rowY } of geos) {
      if (!u || !blockDom || gap == null) continue; // unresolved/demoted → the orphan caption reserves nothing
      // A STACKED brace needs its band its slab OFFSET farther out, and a collision-LIFTED caption its
      // lift on top. The band must also cover the annotation's actual CAPTION ROW: a shared row aligns to
      // the group's highest brace (a raised exponent sibling), pulling a low-glyph annotation's caption
      // farther from ITS OWN edge than reservedBand+off — without this the caption gets bound-clamped
      // back down onto the sibling's brace. Each controller drives the same line's gap, so it converges
      // to the DEEPEST requirement.
      const leading = isLeadingBrace(v.kind);
      const rowNeed =
        rowY != null ? (leading ? u.top - rowY : rowY + LABEL_HEIGHT - u.bottom) + 2 : 0;
      const band = Math.max(reservedBand(v.gap) + off, rowNeed) + (lifts.get(v.id) ?? 0);
      const cur = current.get(v.id) ?? { top: 0, bottom: 0 };
      const displayEl = this.displayRenderFor(v, blockDom);
      const acc = next.get(v.id) ?? { ...cur, display: displayEl != null };
      const side = leading ? ('top' as const) : ('bottom' as const);
      const err = band - gap;
      const key = `${v.id}:${side}`;
      const prevP = this.progress.get(key);
      // HALF-STEP integrator (`h += err/2`): provably cycle-free for any plant gain below 4× — the classic
      // damping for a plant whose true gain is uncertain. Layout responds to a reserve px with slightly
      // more than one px in places (line-box interplay around spacers), and a FULL-step integrator turns
      // any gain above 2 into a permanent grow/shrink limit cycle (the reported page flicker); an adaptive
      // gain estimate was tried and dropped (external layout changes contaminate it and turn convergence
      // into a seconds-long slide). Half-steps converge from a full band's error in ~4 rAF passes (~70ms).
      // Deadband ±2px: layout measurements jitter by ±1px pass-to-pass (sub-pixel rounding of KaTeX
      // geometry), and a ±1 deadband let that jitter re-trigger endless ±1 adjustments — a long soft tail
      // of dispatches after every real change. 2px of band tolerance is visually nothing.
      if (Math.abs(err) > 2) {
        // Stall detection: we grew last time, the growth is LIVE in the DOM (cur reached the last target),
        // yet the gap did not respond — a mis-measurement somewhere. Freeze after 3 stalled attempts.
        const stalled =
          err > 0 && prevP != null && prevP.h > 0 && cur[side] >= prevP.h && gap <= prevP.gap + 2;
        const stalls = stalled ? prevP.stalls + 1 : 0;
        // OSCILLATION damper (the stall valve's twin): a sign-FLIPPING adjustment (grow, shrink, grow …)
        // means the measurement disagrees with itself — after 3 consecutive flips, FREEZE at the current
        // height rather than cycling forever (with the rAF coalescing this could no longer freeze the page,
        // but it would still churn a re-layout every frame). The gain-adaptive step makes this a true
        // backstop rather than the steady state.
        const delta = err;
        const flipped =
          prevP != null &&
          prevP.lastDelta !== 0 &&
          Math.sign(delta) === -Math.sign(prevP.lastDelta);
        const flips = flipped ? prevP.flips + 1 : 0;
        if (stalls < 3 && flips < 3)
          acc[side] = Math.min(MAX_SPACER, Math.max(0, cur[side] + Math.round(err / 2)));
        else acc[side] = cur[side]; // FROZEN — never balloon or cycle on bad data
        this.progress.set(key, { gap, h: acc[side], stalls, flips, lastDelta: delta });
      } else {
        this.progress.set(key, { gap, h: acc[side], stalls: 0, flips: 0, lastDelta: 0 });
      }
      if (Array.isArray(dbg))
        dbg.push({ id: v.id, kind: v.kind, u, gap, bound, band, h: acc[side], side });
      next.set(v.id, acc);

      // A display equation owns its line → its reserve is a MARGIN on the render element (linear feedback).
      if (displayEl) applyMargins.push({ el: displayEl, top: acc.top, bottom: acc.bottom });
    }

    // Imperative display reserves as PADDING (re-applied every pass; cleared when gone). Padding, never
    // margin: a block-level child's top margin COLLAPSES through the paragraph and moves the whole block
    // down — the measured gap never grows, the feedback loop stalls at the valve, and the draw guard piles
    // the brace/label onto the equation (the display mis-draw bug). Padding creates interior space.
    // Several annotations on ONE display equation share this element: apply the MAX per side — a
    // last-writer-wins would be doc-order-dependent (the smaller write starves the deeper annotation's
    // band, which then stall-freezes underprovisioned and the caption clamps onto content).
    const byEl = new Map<HTMLElement, { top: number; bottom: number }>();
    for (const { el, top, bottom } of applyMargins) {
      const cur = byEl.get(el) ?? { top: 0, bottom: 0 };
      byEl.set(el, { top: Math.max(cur.top, top), bottom: Math.max(cur.bottom, bottom) });
    }
    const nextMargined = new Set<HTMLElement>();
    let padChanged = false;
    for (const [el, { top, bottom }] of byEl) {
      const pt = top > 0 ? `${top}px` : '';
      const pb = bottom > 0 ? `${bottom}px` : '';
      if (el.style.paddingTop !== pt || el.style.paddingBottom !== pb) {
        el.style.paddingTop = pt;
        el.style.paddingBottom = pb;
        padChanged = true;
      }
      nextMargined.add(el);
    }
    for (const el of this.margined) {
      if (!nextMargined.has(el) && (el.style.paddingTop !== '' || el.style.paddingBottom !== '')) {
        el.style.paddingTop = '';
        el.style.paddingBottom = '';
        padChanged = true;
      }
    }
    this.margined = nextMargined;
    // The applied padding moved the layout: re-measure next frame even when the spacer map is unchanged
    // (converged heights stop the chain — a changed measurement flows into the normal dispatch path).
    if (padChanged && this.renderRaf == null) {
      this.renderRaf = requestAnimationFrame(() => {
        this.renderRaf = null;
        if (!this.destroyed) this.render();
      });
    }

    if (spacersKey(next) === spacersKey(current)) return;
    // rAF-COALESCED dispatch (freeze-proofing): the reserve feedback re-dispatch is scheduled on an
    // animation frame with at most ONE pending — if a measurement ever OSCILLATES (dispatch → re-measure →
    // change → dispatch…), the loop runs once per frame and the page stays responsive, instead of the
    // unbounded microtask cycle that hard-froze the tab. Convergent cases still settle in a few frames.
    this.pendingSpacers = next;
    if (this.rafHandle != null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      if (this.destroyed || !this.pendingSpacers) return;
      const spacers = this.pendingSpacers;
      this.pendingSpacers = null;
      this.view.dispatch(
        this.view.state.tr
          .setMeta(KEY, { type: 'spacers', spacers } satisfies Meta)
          .setMeta('addToHistory', false),
      );
    });
  }

  /** The block's CONTENT rects for line clustering — text-node rects + non-spacer element rects, walked
   *  recursively. Our own `.anno-spacer` elements are EXCLUDED: a spacer's tall rect vertically bridges its
   *  line to the neighbouring one, which would merge their bands and collapse the ceiling/floor reference the
   *  feedback loop measures against (the gap would over-read → shrink → under-read → grow: a limit cycle).
   *  The bands must describe the CONTENT the brace needs distance from, never the reserve itself. */
  private blockContentRects(blockDom: HTMLElement): RectLike[] {
    const out: RectLike[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        try {
          const range = document.createRange();
          range.selectNode(node);
          for (const r of Array.from(range.getClientRects())) out.push(toRectLike(r));
        } catch {
          /* detached/degenerate node — skip */
        }
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.classList.contains('anno-spacer')) return; // the reserve itself is not content
      // A KaTeX render contributes its TIGHT glyph box, never its border box: the display reserve is
      // PADDING inside this very element, and a border-box band would include the reserved space as
      // "content" — the target's own line band then reaches the padded top and the label clamp hoists every
      // caption to the top of the reserve, detached from its brace (the reported floating "b two" row).
      if (node.classList.contains('math-render')) {
        const r = tightRect(node);
        if (r && r.width > 0 && r.height > 0) out.push(toRectLike(r));
        return;
      }
      // A leaf-ish rendered element (chrome) contributes its own box; otherwise recurse.
      if (node.childNodes.length === 0) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push(toRectLike(r));
        return;
      }
      node.childNodes.forEach(walk);
    };
    blockDom.childNodes.forEach(walk);
    return out;
  }

  /** The display render element for a sub_term view whose expression renders as a DISPLAY block (it owns its
   *  line, so reserves apply as margins on it); null for inline math / prose. */
  private displayRenderFor(v: AnnoView, blockDom: HTMLElement): HTMLElement | null {
    if (v.extent.kind === 'prose_span') return null;
    const el = blockDom.querySelector<HTMLElement>(
      `[data-expr-id="${v.extent.expressionId}"].math-render-display`,
    );
    return el;
  }

  /** Draw an over/under brace + caption over the union box `u` (client coords). `u` null ⇒ ORPHAN (target
   *  unresolved, or P1-demoted): draw only the dimmed caption near the block. `bound` is the measured content
   *  edge beyond the braced side (the reserve ceiling/floor) — the DRAW GUARD: mid-convergence (or frozen by
   *  the safety valve) the band may not fully exist yet, so the brace/label are CLAMPED into the available
   *  gap rather than ever drawing over the neighbouring content. Returns the placed caption (for the
   *  post-draw collision pass); null for an orphan. */
  private drawHorizontal(
    v: AnnoView,
    u: RectLike | null,
    bound: number | null = null,
    off = 0,
    rowY: number | null = null,
  ): { el: HTMLElement; svg: Element; leading: boolean } | null {
    const gpx = gapPx(v.gap) + off; // a stacked brace sits one SLAB farther out per nesting level
    const leading = isLeadingBrace(v.kind);
    const sx = window.scrollX;
    const sy = window.scrollY;

    if (!u) {
      const label = this.makeLabel(v, true);
      const blockDom = this.view.nodeDOM(v.blockPos);
      const r = blockDom instanceof HTMLElement ? blockDom.getBoundingClientRect() : null;
      if (r) {
        label.style.left = `${sx + r.left}px`;
        label.style.top = `${sy + (leading ? r.top - 20 : r.bottom + 2)}px`;
        this.container.appendChild(label);
      }
      return null;
    }

    const width = Math.max(u.right - u.left, 1);
    let svgTop = leading ? u.top - gpx - BRACE_DEPTH : u.bottom + gpx;
    // The caption sits in its nesting-level's ROW (computed in the slab layout — directly beyond this
    // level's braces, row 0 clamped past the line edge so it never covers same-line glyphs); brace-adjacent
    // fallback when no row was computed (degenerate geometry).
    let labelTop = rowY ?? (leading ? svgTop - 18 : svgTop + BRACE_DEPTH + 2);
    if (bound != null) {
      if (leading) {
        svgTop = Math.max(svgTop, bound + 1);
        labelTop = Math.max(labelTop, bound + 1);
      } else {
        svgTop = Math.min(svgTop, bound - 1 - BRACE_DEPTH);
        labelTop = Math.min(labelTop, bound - 1 - 16);
      }
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(BRACE_DEPTH));
    svg.setAttribute('class', 'anno-brace');
    svg.style.position = 'absolute';
    svg.style.left = `${sx + u.left}px`;
    svg.style.top = `${sy + svgTop}px`;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', horizontalBracePath(width, BRACE_DEPTH));
    path.setAttribute('class', 'anno-brace-path');
    path.setAttribute('fill', 'none');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    if (leading) path.setAttribute('transform', `scale(1,-1) translate(0,-${BRACE_DEPTH})`);
    svg.appendChild(path);
    this.container.appendChild(svg);

    const label = this.makeLabel(v, false);
    label.style.left = `${sx + u.left + width / 2}px`;
    label.style.transform = 'translateX(-50%)';
    label.style.top = `${sy + labelTop}px`;
    this.container.appendChild(label);
    return { el: label, svg, leading };
  }

  private makeLabel(v: AnnoView, orphan: boolean): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = orphan ? 'anno-label anno-orphan' : 'anno-label';
    wrap.setAttribute('data-anno-id', v.id);

    const caption = document.createElement('span');
    caption.className = 'anno-caption';
    caption.contentEditable = 'true';
    caption.textContent = v.label;
    if (orphan) caption.title = 'this annotation’s target no longer resolves';
    caption.addEventListener('focus', () => {
      this.editingLabel = true;
    });
    caption.addEventListener('blur', () => {
      this.editingLabel = false;
      this.commitLabel(v, caption.textContent ?? '');
    });
    caption.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        caption.blur();
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'anno-remove';
    remove.textContent = '×';
    remove.title = 'remove annotation';
    remove.setAttribute('aria-label', 'remove annotation');
    remove.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeAnnotation(v);
    });

    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) {
        e.preventDefault();
        caption.focus();
      }
    });

    wrap.append(caption, remove);
    return wrap;
  }
}

/** A stable signature of the spacer map (change detection — don't re-dispatch identical measurements). */
function spacersKey(s: Spacers): string {
  return [...s.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, v]) => `${id}:${v.top}:${v.bottom}`)
    .join('|');
}

/** The spacer WIDGET decorations (P2/P3): for each annotation with a non-zero reserve, a zero-width
 *  inline-block spacer AT the annotated position — `text-bottom`-aligned to grow the line upward (over) and/or
 *  `text-top`-aligned to grow it downward (under). Decoration-only, so the P3 toggle (or removing the
 *  annotation) reflows the document back to pristine. In a display block the source line is hidden, so the
 *  spacer contributes nothing there — the display reserve rides the render-element margin instead. */
function spacerDecorations(doc: PMNode, ps: PluginState): DecorationSet | null {
  if (!ps.visible || ps.spacers.size === 0) return null;
  const decos: Decoration[] = [];
  const seen = new Set<string>();
  for (const o of annoOccurrences(doc)) {
    if (seen.has(o.annotationId)) continue;
    seen.add(o.annotationId);
    const h = ps.spacers.get(o.annotationId);
    if (!h || h.display || (h.top === 0 && h.bottom === 0)) continue;
    const { top, bottom } = h;
    decos.push(
      Decoration.widget(
        o.from,
        () => {
          const wrap = document.createElement('span');
          wrap.className = 'anno-spacer';
          wrap.contentEditable = 'false';
          if (top > 0) {
            const up = document.createElement('span');
            up.className = 'anno-spacer-up';
            up.style.height = `${top + SPACER_BASE}px`;
            wrap.appendChild(up);
          }
          if (bottom > 0) {
            const down = document.createElement('span');
            down.className = 'anno-spacer-down';
            down.style.height = `${bottom + SPACER_BASE}px`;
            wrap.appendChild(down);
          }
          return wrap;
        },
        {
          side: -1,
          marks: [],
          key: `annosp:${o.annotationId}:${top}:${bottom}`,
          ignoreSelection: true,
        },
      ),
    );
  }
  return decos.length > 0 ? DecorationSet.create(doc, decos) : null;
}

export const annoLivePreview = new Plugin<PluginState>({
  key: KEY,
  state: {
    init: () => ({ spacers: new Map(), visible: true }),
    apply: (tr, prev) => {
      const meta = tr.getMeta(KEY) as Meta | undefined;
      if (meta?.type === 'toggle') return { ...prev, visible: !prev.visible };
      if (meta?.type === 'spacers') return { ...prev, spacers: meta.spacers };
      if (!tr.docChanged) return prev;
      // Drop reserves for annotations gone from the doc so stale space can't linger.
      const live = new Set<string>();
      for (const o of annoOccurrences(tr.doc)) live.add(o.annotationId);
      let changed = false;
      const spacers: Spacers = new Map();
      for (const [id, h] of prev.spacers) {
        if (live.has(id)) spacers.set(id, h);
        else changed = true;
      }
      return changed ? { ...prev, spacers } : prev;
    },
  },
  props: {
    decorations(state) {
      const ps = KEY.getState(state);
      return ps ? spacerDecorations(state.doc, ps) : null;
    },
  },
  view(view) {
    return new AnnoOverlay(view);
  },
});
