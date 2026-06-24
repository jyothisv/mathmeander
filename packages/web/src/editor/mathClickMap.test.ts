// The pure click→source-position mapping (F3). No DOM/ProseMirror, so it unit-tests in node — the in-browser
// half (data-path → CharSpan → selection) is covered by the e2e suite.
import { describe, expect, it } from 'vitest';
import {
  cpLen,
  deepestPathAt,
  sameArray,
  docPosForSurfaceOffset,
  singleClickCaretOffset,
  systemRowStarts,
} from './mathClickMap';

const box = (path: string, left: number, top: number, w: number, h: number) => ({
  path,
  rect: { left, top, right: left + w, bottom: top + h },
});

describe('cpLen', () => {
  it('counts CODE POINTS, not UTF-16 units', () => {
    expect(cpLen('')).toBe(0);
    expect(cpLen('x^2')).toBe(3);
    expect('𝕏'.length).toBe(2); // guard: the naive `.length` over-counts a non-BMP glyph
    expect(cpLen('𝕏')).toBe(1);
    expect(cpLen('a𝕏b')).toBe(3);
  });
});

describe('sameArray', () => {
  it('is element-wise path equality', () => {
    expect(sameArray([], [])).toBe(true); // root path
    expect(sameArray([0, 1], [0, 1])).toBe(true);
    expect(sameArray([0, 1], [0, 2])).toBe(false);
    expect(sameArray([0], [0, 1])).toBe(false); // length differs
    expect(sameArray([0, 1], [1, 0])).toBe(false); // order matters
  });
});

describe('docPosForSurfaceOffset', () => {
  it('adds the CODE-POINT offset to the row start (ASCII: 1:1)', () => {
    expect(docPosForSurfaceOffset(12, 'x^2', 0)).toBe(12); // row start
    expect(docPosForSurfaceOffset(12, 'x^2', 2)).toBe(14); // before the `2`
    expect(docPosForSurfaceOffset(12, 'x^2', 3)).toBe(15); // end
  });

  it('converts code points → UTF-16 units (ProseMirror positions) for a non-BMP glyph', () => {
    // '𝕏+y': '𝕏' is ONE code point but TWO UTF-16 units. A surface offset of 1 (past `𝕏`) is +2 doc units.
    expect(docPosForSurfaceOffset(12, '𝕏+y', 0)).toBe(12);
    expect(docPosForSurfaceOffset(12, '𝕏+y', 1)).toBe(14); // past `𝕏` → +2, NOT +1
    expect(docPosForSurfaceOffset(12, '𝕏+y', 2)).toBe(15); // past `𝕏+`
  });
});

describe('systemRowStarts', () => {
  // The typed/authored form: `$$` ⏎ row0 ⏎ row1 ⏎ `$$`. Doc pos of src[k] is contentStart + k (UTF-16, 1:1).
  it('locates each row past the leading `$$⏎` and each inter-line break', () => {
    // contentStart 100: `$`100 `$`101 `\n`102 a103=104 b105 `\n`106 c107=108 d109 `\n`110 `$`111 `$`112
    expect(systemRowStarts('$$\na=b\nc=d\n$$', 100)).toEqual([103, 107]);
  });

  it('steps over leading whitespace and skips blank lines (matches splitSystemRows)', () => {
    // `$`0 `$`1 `\n`2 ` `3 ` `4 a5=6 b7 `\n`8 `\n`9(blank) c10=11 d12 `$`13 `$`14
    expect(systemRowStarts('$$\n  a=b\n\nc=d$$', 0)).toEqual([5, 10]);
  });

  it('returns [] for a non-display source', () => {
    expect(systemRowStarts('not display', 0)).toEqual([]);
  });
});

describe('singleClickCaretOffset', () => {
  // `i=0` → Rel(i, =, 0): root [] span [0,3], child [0]=`i` span [0,1], child [1]=`0` span [2,3].
  const relPaths = [
    { path: [], charSpan: { start: 0, end: 3 } },
    { path: [0], charSpan: { start: 0, end: 1 } },
    { path: [1], charSpan: { start: 2, end: 3 } },
  ];

  it('a NON-leaf (operator) click carets just after its first child, not at the node start', () => {
    const root = relPaths[0]!;
    // clicking the `=` resolves to the root relation → caret at end of `i` (offset 1), NOT 0.
    expect(singleClickCaretOffset(root, relPaths)).toBe(1);
  });

  it('a LEAF click carets at the leaf start', () => {
    const leaf = relPaths[2]!; // `0`, no child [1,0] exists
    expect(singleClickCaretOffset(leaf, relPaths)).toBe(2);
  });

  it('a nested non-leaf uses ITS first child end', () => {
    // a^2 + b: Add(Sup(a,2), b). path [0]=`a^2`[0,3], [0,0]=`a`[0,1], [0,1]=`2`[2,3], [1]=`b`[6,7].
    const paths = [
      { path: [], charSpan: { start: 0, end: 7 } },
      { path: [0], charSpan: { start: 0, end: 3 } },
      { path: [0, 0], charSpan: { start: 0, end: 1 } },
      { path: [0, 1], charSpan: { start: 2, end: 3 } },
      { path: [1], charSpan: { start: 6, end: 7 } },
    ];
    expect(singleClickCaretOffset(paths[1]!, paths)).toBe(1); // Sup → after its base `a`
  });
});

describe('deepestPathAt', () => {
  // Nested boxes: root encloses a 22-wide relation, which encloses a 5-wide `i` and a 7-wide `0`.
  // (Mirrors the KaTeX subscript case: the click point is inside ALL of root/rel/i, and the smallest
  // containing box is the deepest sub-term — even though a stacked ancestor would win elementFromPoint.)
  const boxes = [
    box('1.0', 0, 0, 100, 40), // the enclosing Sub (big — the one that stole the click via stacking)
    box('1.0.1.0', 10, 20, 22, 16), // the relation `i=0`
    box('1.0.1.0.0', 10, 20, 5, 16), // `i`
    box('1.0.1.0.1', 25, 20, 7, 16), // `0`
  ];

  it('returns the SMALLEST box containing the point (deepest sub-term), not a stacked ancestor', () => {
    expect(deepestPathAt(boxes, 12, 28)).toBe('1.0.1.0.0'); // inside `i`
    expect(deepestPathAt(boxes, 28, 28)).toBe('1.0.1.0.1'); // inside `0`
  });

  it('falls to the relation when the point is on the operator gap (only rel + root contain it)', () => {
    expect(deepestPathAt(boxes, 21, 28)).toBe('1.0.1.0'); // between `i` and `0` → the `=` of the relation
  });

  it('returns null when the point is in no tagged box', () => {
    expect(deepestPathAt(boxes, 500, 500)).toBeNull();
  });

  it('skips zero-area boxes (empty `\\htmlData` for Empty nodes)', () => {
    const withEmpty = [box('', 0, 0, 50, 20), box('0', 10, 5, 0, 0)];
    expect(deepestPathAt(withEmpty, 10, 5)).toBe(''); // the zero-area `0` is skipped → root
  });

  it('on COINCIDENT (equal-area) boxes prefers the DEEPER path, not DOM-order ancestor', () => {
    // parent "1" and child "1.0" render to the exact same box (DOM order = parent first); the click
    // must resolve to the deeper "1.0", not the ancestor that comes first.
    const coincident = [box('1', 0, 0, 10, 16), box('1.0', 0, 0, 10, 16)];
    expect(deepestPathAt(coincident, 5, 8)).toBe('1.0');
  });
});
