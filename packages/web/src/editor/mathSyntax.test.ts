// The `$…$` recognition rule (docs/authoring-numbering-citations.md). Pure — no DOM, no WASM. The decisive
// behaviour: digit-leading math (`$3x$`) IS recognized (the digit guard is on the CLOSE) while currency
// (`$5 and $10`) is NOT, `\$` escapes a literal dollar, and `$$` (empty pair) is left for display math.
import { describe, expect, it } from 'vitest';
import { findMathRegions, openRegionStart, wholeDisplaySource } from './mathSyntax';

/** The inner sources of every recognized region (the part between the `$`), in order. */
function inners(text: string): string[] {
  return findMathRegions(text).map((r) => text.slice(r.start + 1, r.end - 1));
}

describe('findMathRegions — recognized as math', () => {
  it('a plain expression', () => {
    expect(inners('$x^2$')).toEqual(['x^2']);
  });
  it('digit-leading math (the decisive case — guard is on the close, not the open)', () => {
    expect(inners('$3x$')).toEqual(['3x']);
    expect(inners('$2\\pi$')).toEqual(['2\\pi']);
    expect(inners('$0$')).toEqual(['0']);
  });
  it('internal spaces are fine — only the char right before the closing $ matters', () => {
    expect(inners('$x = y$')).toEqual(['x = y']);
    expect(inners('$x =$')).toEqual(['x =']);
  });
  it('two inline expressions, including back-to-back $a$$b$', () => {
    expect(inners('$a$ and $b$')).toEqual(['a', 'b']);
    expect(inners('$a$$b$')).toEqual(['a', 'b']);
  });
  it('math embedded in prose', () => {
    expect(inners('let $x$ be ')).toEqual(['x']);
  });
});

describe('findMathRegions — NOT math (currency / escape / incomplete)', () => {
  it('currency stays plain text (closer is preceded by a space → no valid close)', () => {
    expect(inners('$5 and $10')).toEqual([]);
    expect(inners('$20,000 and $30,000')).toEqual([]);
    expect(inners('it costs $5')).toEqual([]);
  });
  it('a closing $ may not be immediately followed by a digit', () => {
    expect(inners('$x$5')).toEqual([]); // would-be closer is followed by `5`
  });
  it('a trailing space right before the closing $ does not close (write $x=$)', () => {
    expect(inners('$x = $')).toEqual([]);
  });
  it('\\$ is an escaped literal dollar, not a delimiter', () => {
    expect(inners('\\$5')).toEqual([]);
    expect(inners('\\$x\\$')).toEqual([]);
    expect(inners('cost is \\$5 today')).toEqual([]);
  });
  it('an unclosed opener is literal', () => {
    expect(inners('$x + y')).toEqual([]);
    expect(inners('a lone $ sign')).toEqual([]);
  });
  it('a $ at the very edge cannot open or close', () => {
    expect(inners('x$')).toEqual([]);
    expect(inners('$')).toEqual([]);
  });
});

describe('findMathRegions — $$ reserved for display math (Phase C)', () => {
  it('an empty pair is skipped, not recognized as empty inline math', () => {
    expect(inners('$$')).toEqual([]);
    expect(inners('$$x$$')).toEqual([]); // passes through as raw until display math lands
  });
});

describe('findMathRegions — spans cover the full $…$', () => {
  it('start/end include both delimiters', () => {
    expect(findMathRegions('ab $x$ cd')).toEqual([{ start: 3, end: 6 }]);
  });
});

describe('openRegionStart — the live "math mode" signal for an unclosed region', () => {
  it('engages once a non-digit follows the opening $ (caret inside)', () => {
    expect(openRegionStart('$x', 2)).toBe(0); // typed "$x", caret at end
    expect(openRegionStart('$x', 1)).toBe(0); // caret right after the $, x follows
    expect(openRegionStart('a $b', 4)).toBe(2); // open region mid-prose
  });
  it('stays prose for a lone $, a digit-leading $, or the caret before the $', () => {
    expect(openRegionStart('$', 1)).toBeNull(); // lone $ — mode-neutral
    expect(openRegionStart('$5x', 3)).toBeNull(); // digit-leading — currency-safe (recognized on close)
    expect(openRegionStart('x$y', 1)).toBeNull(); // caret before the $
  });
  it('returns null inside or after a COMPLETE region (the mark handles that)', () => {
    expect(openRegionStart('$x$', 2)).toBeNull(); // caret inside a closed $x$
    expect(openRegionStart('$x$ ', 4)).toBeNull(); // caret after a closed $x$
  });
});

describe('wholeDisplaySource — a whole-line $$…$$ display equation', () => {
  it('returns the inner source for an exact $$…$$', () => {
    expect(wholeDisplaySource('$$x^2$$')).toBe('x^2');
    expect(wholeDisplaySource('$$\\frac{a}{b}$$')).toBe('\\frac{a}{b}');
  });
  it('rejects partial, empty, inline, or surrounded forms', () => {
    expect(wholeDisplaySource('$$x$')).toBeNull(); // partial
    expect(wholeDisplaySource('$$$$')).toBeNull(); // empty inner
    expect(wholeDisplaySource('$x$')).toBeNull(); // inline (single $)
    expect(wholeDisplaySource('see $$x$$ here')).toBeNull(); // not the whole line
  });
  it('tolerates trailing HORIZONTAL whitespace, but NOT a trailing newline', () => {
    expect(wholeDisplaySource('$$x$$ ')).toBe('x'); // a stray trailing space doesn't demote it
    expect(wholeDisplaySource('$$a + b$$  \t')).toBe('a + b'); // spaces + tab tolerated
    expect(wholeDisplaySource('$$x$$\n')).toBeNull(); // a trailing newline (Shift-Enter) stays a real break
  });
});
