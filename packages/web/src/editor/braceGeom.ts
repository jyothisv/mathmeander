// PURE brace geometry (§6.2 annotations) — no ProseMirror/DOM deps, so it unit-tests in node. The overlay
// engine (annoLivePreview) resolves a target's structural extent to on-screen rects, then hands the geometry
// here: it builds the SVG curly-brace `<path d>` and the layout numbers (reserved band, gap, label box). The
// brace binds to PRECISE structure — its width/height come from the bound span's rects, never free pixels
// (§6.2). Keeping the math here (vs inline in the plugin) is what lets it be tested without a browser; the
// remaining pixel polish (anchoring, crispness) is e2e/manual since jsdom returns zero-area rects.
import type { LayoutStep } from '@mathmeander/schema';

/** A rect in CLIENT coordinates (the shape `getBoundingClientRect`/`getClientRects` return, and what the
 *  overlay works in before converting to its mount-relative origin). */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The brace tooth's protrusion (px) — how far the central point reaches from the flat edge toward the span.
 *  A layout constant (not device-tuned); the style skin may scale it. */
export const BRACE_DEPTH = 7;
/** Reserved height (px) for the caption line above/below the brace. */
export const LABEL_HEIGHT = 18;

/** A closed spacing vocabulary → px (the `LayoutStep` skin, §2.1): the reserve between the brace and the span
 *  it embraces. `em`-relative in spirit; px here because the overlay works in client pixels. */
export function gapPx(step: LayoutStep): number {
  switch (step) {
    case 'none':
      return 0;
    case 'small':
      return 3;
    case 'medium':
      return 7;
    case 'large':
      return 12;
    default:
      return 3;
  }
}

/** The total vertical band an over/under brace + its label occupy (so the PM widget can reserve exactly this
 *  much layout space and the editor reflows around it): brace depth + label line + the gap on each side. */
export function reservedBand(gap: LayoutStep): number {
  return BRACE_DEPTH + LABEL_HEIGHT + gapPx(gap) * 2;
}

/** The union (bounding box) of a set of rects — the box an over/under brace spans horizontally, or a
 *  left/right brace spans vertically. `null` for an empty set (nothing to embrace → no brace drawn). */
export function unionRect(rects: RectLike[]): RectLike | null {
  if (rects.length === 0) return null;
  let { left, top, right, bottom } = rects[0]!;
  for (let i = 1; i < rects.length; i += 1) {
    const r = rects[i]!;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return { left, top, right, bottom };
}

/** A HORIZONTAL curly brace as an SVG `<path d>` string, drawn in a local box: the flat edge runs along
 *  `y = 0` from `x = 0` to `x = width`, and the central TOOTH protrudes to `y = depth` at the midpoint — the
 *  shape of `⏟` (an underbrace). It is the canonical brace; the overlay orients it by an SVG transform (an
 *  overbrace flips it vertically; left/right braces rotate it 90°), so ONE path serves all four kinds. Two
 *  symmetric arms bulge to half-depth and meet the tooth at full depth, giving the true curly-brace silhouette
 *  (not a plain arch). Stroke it with `vector-effect="non-scaling-stroke"` so it stays crisp at any width. */
export function horizontalBracePath(width: number, depth: number = BRACE_DEPTH): string {
  const w = Math.max(width, 1);
  const h = Math.max(depth, 1);
  const half = h / 2;
  return [
    `M 0 0`,
    `Q 0 ${half} ${w * 0.25} ${half}`, // left end eases down to mid-depth (the left arm bulges)
    `Q ${w * 0.5} ${half} ${w * 0.5} ${h}`, // continues to the central tooth at full depth
    `Q ${w * 0.5} ${half} ${w * 0.75} ${half}`, // mirror: tooth back up to mid-depth
    `Q ${w} ${half} ${w} 0`, // right arm eases back to the flat edge
  ].join(' ');
}

/** Whether a brace kind runs HORIZONTALLY over a span (over/under) vs vertically alongside rows (left/right).
 *  Slice 1a ships the horizontal pair; left/right (a vertical brace over an equation set) is slice 1b. */
export function isHorizontalBrace(kind: string): boolean {
  return kind === 'overbrace' || kind === 'underbrace';
}

/** Whether the brace sits on the FAR side (over/left) vs the NEAR side (under/right) of the span — the sign
 *  the overlay uses to place the reserved band + orient the tooth. */
export function isLeadingBrace(kind: string): boolean {
  return kind === 'overbrace' || kind === 'left_brace';
}

// ── The OUTER-HULL rule (P1) ─────────────────────────────────────────────────────────────────────
// A brace NEVER creates space inside an expression: a brace side is valid only when the target's edge on that
// side lies on its expression's outer hull — no NON-ancestral content horizontally overlapping the target
// sits beyond that edge. In `(a+b)/(c+d)`: the numerator (and its parts) is over-braceable only; the
// denominator under-braceable only; the whole fraction both. Judged on the RENDERED `data-path` boxes (the
// ground truth), with two robustness rules learned from KaTeX's box model:
//   • ancestors/descendants are excluded STRUCTURALLY (by path prefix) — a wrapper box encloses the target
//     and must never veto it;
//   • an unrelated node counts as "above"/"below" by its vertical CENTER, not its edges — KaTeX glyph boxes
//     carry leading, so a numerator's box overlaps the denominator's by a knife-edge pixel and an edge test
//     is unstable.

/** One rendered sub-term: its dot-joined `data-path` (`""` = root) + its client rect. */
export interface PathBoxLike {
  path: string;
  rect: RectLike;
}

/** Is dot-path `a` a (proper or equal) prefix of dot-path `b`? The root `""` prefixes everything. */
export function isPathPrefix(a: string, b: string): boolean {
  if (a === '') return true;
  return b === a || b.startsWith(`${a}.`);
}

/** Two rects overlap horizontally by more than `eps` px (a shared column of real width). */
function overlapsHorizontally(a: RectLike, b: RectLike, eps: number): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > eps;
}

/** Which brace sides the hull rule permits for the node at `targetPath` among the expression's rendered
 *  `nodes` (every `data-path` box, the target included). Ancestors/descendants of the target are ignored
 *  (a wrapper never vetoes); any other node that horizontally overlaps the target blocks `over` when its
 *  vertical center is above the target's top, `under` when below the target's bottom. Missing target →
 *  permissive (degraded environments must not lock the gesture). */
export function hullSidesAt(
  targetPath: string,
  nodes: PathBoxLike[],
  eps = 1,
): { over: boolean; under: boolean } {
  const target = nodes.find((n) => n.path === targetPath)?.rect;
  if (!target) return { over: true, under: true };
  let over = true;
  let under = true;
  for (const n of nodes) {
    if (n.path === targetPath) continue;
    if (isPathPrefix(n.path, targetPath) || isPathPrefix(targetPath, n.path)) continue;
    if (!overlapsHorizontally(target, n.rect, eps)) continue;
    const center = (n.rect.top + n.rect.bottom) / 2;
    if (center < target.top) over = false;
    if (center > target.bottom) under = false;
  }
  return { over, under };
}

/** The rect-level hull test `hullSidesAt` reduces to once structure is resolved: which sides of `target` lie
 *  on the outer hull given the OTHER rendered boxes. The caller must already have excluded the target's own
 *  constituents and enclosures (for an `expression_span` target: every node whose char span INTERSECTS the
 *  span — contained nodes are the target, overlapping ones its ancestors; only DISJOINT nodes can veto). */
export function hullSidesRect(
  target: RectLike,
  others: RectLike[],
  eps = 1,
): { over: boolean; under: boolean } {
  let over = true;
  let under = true;
  for (const r of others) {
    if (!overlapsHorizontally(target, r, eps)) continue;
    const center = (r.top + r.bottom) / 2;
    if (center < target.top) over = false;
    if (center > target.bottom) under = false;
  }
  return { over, under };
}

/** The additional space (px) still needed for a band of `band` px when `naturalGap` px of empty space already
 *  exists on that side (P2: deficit-only — pre-existing room is used before anything reflows). */
export function bandDeficit(band: number, naturalGap: number): number {
  return Math.max(0, Math.ceil(band - Math.max(0, naturalGap)));
}
