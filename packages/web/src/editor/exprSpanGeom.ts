// Geometry resolution for `expression_span` extents (§6.2) — an annotation bound to a contiguous CHAR RANGE
// of one expression's surface, used when a selection is mathematically legitimate but is NOT a single AST
// node (an associative sub-chain: `Sigma' times {L, S, R}` inside the left-nested product
// `Q times Sigma' times {L, S, R}`). The range is resolved to structure ON RENDER: the MAXIMAL nodes fully
// covered by the span give the target's glyph boxes, so the brace still hugs rendered structure — never free
// pixels. Shared by the gesture (annoKeys: hull check, popover anchor) and the overlay (annoLivePreview:
// draw rects, P1 demote), the same way domGeom/braceGeom are.
import { isMathRuntimeReady, surfacePaths, type SurfacePath } from './mathRuntime';
import { glyphRects, tightRect } from './domGeom';
import { hullSidesRect, unionRect, type RectLike } from './braceGeom';

const toRectLike = (r: DOMRect): RectLike => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
});

/** The nodes of `paths` fully covered by code-point span `[start, end)` that are MAXIMAL (no covered
 *  ancestor) — the structural content a hand-dragged source range actually contains. Empty when the range
 *  covers no whole node (a drag inside one token). Pure over the given paths. */
export function maximalCovered(paths: SurfacePath[], start: number, end: number): SurfacePath[] {
  const covered = paths.filter((p) => start <= p.charSpan.start && p.charSpan.end <= end);
  return covered.filter(
    (p) =>
      !covered.some(
        (q) => q.path.length < p.path.length && q.path.every((x, i) => x === p.path[i]),
      ),
  );
}

/** `maximalCovered` over a surface's own path map (empty when the math runtime isn't up). */
export function maximalCoveredPaths(surface: string, start: number, end: number): SurfacePath[] {
  if (!isMathRuntimeReady()) return [];
  return maximalCovered(surfacePaths(surface), start, end);
}

/** The tight glyph rects of the span's maximal covered nodes inside a rendered expression element — what an
 *  `expression_span` brace embraces (the union spans `Sigma'` through the closing `}` of the set, including
 *  the structural delimiters a leaf-only walk would miss). Empty when nothing resolves (hidden render). */
export function spanGlyphRects(
  exprEl: HTMLElement,
  surface: string,
  start: number,
  end: number,
): DOMRect[] {
  const out: DOMRect[] = [];
  for (const p of maximalCoveredPaths(surface, start, end)) {
    const el = exprEl.querySelector<HTMLElement>(`[data-path="${p.path.join('.')}"]`);
    if (!el) continue;
    const glyphs = glyphRects(el);
    if (glyphs.length > 0) out.push(...glyphs);
    else {
      const r = tightRect(el);
      if (r) out.push(r);
    }
  }
  return out;
}

/** P1 for an `expression_span` target: hull sides of the covered nodes' union against every node whose char
 *  span is DISJOINT from the span (an intersecting-but-not-contained node is an ancestor/enclosure of the
 *  target — a wrapper never vetoes, the same structural exclusion `hullSidesAt` applies by path prefix). */
export function spanHullSides(
  exprEl: HTMLElement,
  surface: string,
  start: number,
  end: number,
): { over: boolean; under: boolean } {
  if (!isMathRuntimeReady()) return { over: true, under: true };
  const paths = surfacePaths(surface);
  const byKey = new Map(paths.map((p) => [p.path.join('.'), p]));
  const coveredKeys = new Set(maximalCovered(paths, start, end).map((p) => p.path.join('.')));
  const targetRects: RectLike[] = [];
  const others: RectLike[] = [];
  for (const el of Array.from(exprEl.querySelectorAll<HTMLElement>('[data-path]'))) {
    const key = el.dataset.path ?? '';
    const info = byKey.get(key);
    if (!info) continue;
    const r = tightRect(el);
    if (!r) continue;
    if (coveredKeys.has(key)) targetRects.push(toRectLike(r));
    else if (info.charSpan.end <= start || info.charSpan.start >= end) others.push(toRectLike(r));
  }
  const target = unionRect(targetRects);
  if (!target) return { over: true, under: true }; // degraded environments stay permissive
  return hullSidesRect(target, others);
}
