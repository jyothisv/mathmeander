// TIGHT glyph geometry for rendered math (§6.2) — shared by the annotation overlay (brace placement), the
// precise-click hit-testing (mathLivePreview), the hull checks, and the popover anchor. A KaTeX `\htmlData`
// container's own box carries vlist STRUT/padding geometry: an exponent's `msupsub` wrapper extends far
// beyond the `2` glyph and can overlap its neighbours' boxes, which shifts smallest-containing-box hit
// resolution one node off and centers braces off the glyph. The visible truth is the union of the
// DESCENDANT TEXT rects; the container box is only the fallback for text-less nodes (rules, struts).

/** The client rects of an element's visible glyphs (descendant text nodes), zero-area rects dropped.
 *  KaTeX's ACCESSIBILITY MathML (`.katex-mathml`) is skipped: it is clip-rect'ed to ~1px at the render's
 *  top-left (not display:none), so its text rects have area and would pin a "tight" union's corner to the
 *  container top — hoisting everything measured against it (caption rows, line edges). */
export function glyphRects(el: HTMLElement): DOMRect[] {
  const out: DOMRect[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement?.closest('.katex-mathml') ?? null) !== null) continue;
    const range = document.createRange();
    range.selectNode(n);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width > 0 && r.height > 0) out.push(r);
    }
  }
  return out;
}

/** The element's TIGHT bounding box — the union of its glyph rects, falling back to its own border box when
 *  it contains no visible text (e.g. a fraction bar). Null when even the fallback has no area. */
export function tightRect(el: HTMLElement): DOMRect | null {
  const rects = glyphRects(el);
  if (rects.length === 0) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }
  let { left, top, right, bottom } = rects[0]!;
  for (let i = 1; i < rects.length; i += 1) {
    const r = rects[i]!;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}
