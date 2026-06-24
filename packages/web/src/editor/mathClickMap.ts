// Pure helpers for precise click → source-position mapping (F3). No ProseMirror/DOM deps, so they
// unit-test in node. A click on a rendered sub-term (a `data-path` element) is resolved to its
// `CharSpan` (via `surfacePaths`), then mapped to a doc position in the `$$…$$` block source here.
//
// TWO offset spaces meet here and must NOT be conflated:
//   • surface `CharSpan`s count CODE POINTS (Rust `char`/scalar values).
//   • ProseMirror doc positions count UTF-16 CODE UNITS (`TextNode.nodeSize === text.length`), and each
//     hard_break is one position. For ASCII math the two coincide; a non-BMP glyph (e.g. `𝕏`) is 1 code
//     point but 2 UTF-16 units — `docPosForSurfaceOffset` converts so the caret never drifts.
import { wholeDisplaySource } from './mathSyntax';

/** Code-point length — NOT `String.length` (UTF-16 units). Surface `CharSpan`s are code points, so a
 *  non-BMP glyph must count as one. Used to check a row's canonical length against its `surfacePaths`. */
export const cpLen = (s: string): number => Array.from(s).length;

/** Path-array equality (the clicked `data-path` vs a `surfacePaths` entry). */
export const sameArray = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Minimal `surfacePaths` entry shape — structural, so this module needs no runtime dep on mathRuntime. */
type PathSpan = { path: number[]; charSpan: { start: number; end: number } };

/** A `data-path` element's tag + its client rect (for geometry-based hit resolution). */
export type PathBox = {
  path: string;
  rect: { left: number; right: number; top: number; bottom: number };
};

/** Resolve a click to the DEEPEST tagged sub-term by GEOMETRY: the SMALLEST `data-path` box that
 *  contains the point. We can't trust `document.elementFromPoint`/`e.target.closest` here — KaTeX's
 *  super/subscript vlists stack an ancestor's box on top of the script glyphs, so the topmost element
 *  at a subscript pixel belongs to the enclosing node, not the script's own (deeper) `data-path` span.
 *  Boxes nest structurally (a parent encloses its children), so smallest-area-containing = deepest.
 *  On a tie (coincident parent/child boxes — `\htmlData` wraps parent before child, so DOM order would
 *  otherwise keep the ANCESTOR), prefer the DEEPER path (more dot-segments) so the result is still the
 *  most specific sub-term. Zero-area boxes (empty `\htmlData` for `Empty` nodes) are skipped. Returns
 *  the path STRING (`""` = root) or null when the point is in no tagged box (→ caller falls back). */
export function deepestPathAt(boxes: PathBox[], x: number, y: number): string | null {
  const depth = (path: string): number => (path === '' ? 0 : path.split('.').length);
  let best: string | null = null;
  let bestArea = Infinity;
  let bestDepth = -1;
  for (const { path, rect } of boxes) {
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const area = w * h;
    const d = depth(path);
    if (area < bestArea || (area === bestArea && d > bestDepth)) {
      best = path;
      bestArea = area;
      bestDepth = d;
    }
  }
  return best;
}

/** Single-click caret offset (CODE POINTS) for a clicked node. A NON-LEAF node (one with a child
 *  `[...path, 0]` in `paths`) is an operator/structural node — clicking its glyph (`=`, `+`, the
 *  fraction bar) resolves to the node itself, so place the caret at its FIRST child's END (just after
 *  the left operand ≈ at the operator) rather than the node's start (which, for a root relation, is
 *  offset 0 → caret-at-the-beginning, the reported bug). A LEAF caret-at-start is unchanged. */
export function singleClickCaretOffset(hit: PathSpan, paths: PathSpan[]): number {
  const firstChild = paths.find((p) => sameArray(p.path, [...hit.path, 0]));
  return firstChild ? firstChild.charSpan.end : hit.charSpan.start;
}

/** Doc position of a CODE-POINT offset within a row's canonical surface. `rowStart` is the doc position of
 *  the row's first surface char (a UTF-16-based ProseMirror position; for a single equation that's the char
 *  right after the opening `$$`, for a system row it's `systemRowStarts`). Surface offsets are code points
 *  but doc positions are UTF-16 units, so the delta is the UTF-16 length of the surface's first `codePoint`
 *  code points (for ASCII math, just `codePoint`). */
export function docPosForSurfaceOffset(
  rowStart: number,
  rowSurface: string,
  codePoint: number,
): number {
  const utf16 = Array.from(rowSurface).slice(0, codePoint).join('').length;
  return rowStart + utf16;
}

/** Doc position of each SYSTEM row's first content char, indexed PARALLEL to `splitSystemRows` (so
 *  `rowStarts[i]` locates `rows[i]`). Walks the block source `src` (`$$`+inner+`$$`, `\n` per hard_break)
 *  selecting rows exactly as `splitSystemRows` does — non-empty, trimmed — so a leading `\n` (the
 *  `$$⏎…`), blank lines, and leading whitespace are all stepped over rather than mis-counted. `contentStart`
 *  is the doc position of the block's first char (the first `$`); the source maps 1:1 to doc positions (every
 *  char incl. `\n` is one UTF-16 position), so `src`'s index `k` sits at doc position `contentStart + k`. */
export function systemRowStarts(src: string, contentStart: number): number[] {
  const inner = wholeDisplaySource(src);
  if (inner == null) return [];
  const starts: number[] = [];
  let k = 2; // index in `src` just past the opening `$$`
  for (const line of inner.split('\n')) {
    if (line.trim().length > 0) {
      const lead = line.length - line.trimStart().length; // leading whitespace (always BMP)
      starts.push(contentStart + k + lead);
    }
    k += line.length + 1; // + the `\n` that split() removed (one hard_break position)
  }
  return starts;
}
