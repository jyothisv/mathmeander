// The pure inline-formatting scanner: `**bold**`/`*italic*`/`~~strike~~`/`` `code` `` regions, non-overlapping,
// longest-first, escape- and whitespace-aware, delimiters NEVER consumed (they stay in `text`).
import { describe, expect, it } from 'vitest';
import { findMarkRegions, type MarkRegion } from './markSyntax';

/** Compact `style:inner` view of the regions, for readable assertions. */
const shape = (text: string): string[] =>
  findMarkRegions(text).map(
    (r: MarkRegion) => `${r.style}:${text.slice(r.innerStart, r.innerEnd)}`,
  );

describe('findMarkRegions', () => {
  it('recognizes each delimiter, marking only the inner', () => {
    expect(shape('**bold**')).toEqual(['strong:bold']);
    expect(shape('*italic*')).toEqual(['em:italic']);
    expect(shape('~~gone~~')).toEqual(['strike:gone']);
    expect(shape('`code`')).toEqual(['code:code']);
  });

  it('keeps the delimiters in place (span covers them, inner excludes them)', () => {
    const [r] = findMarkRegions('**bold**');
    expect(r).toMatchObject({ start: 0, end: 8, innerStart: 2, innerEnd: 6, style: 'strong' });
  });

  it('reads `**` as one strong, never two ems (longest-first)', () => {
    expect(shape('**x**')).toEqual(['strong:x']);
    expect(shape('a **b** c')).toEqual(['strong:b']);
  });

  it('handles multiple and mid-text regions', () => {
    expect(shape('a **b** and *c* d')).toEqual(['strong:b', 'em:c']);
  });

  it('treats a `*` with no valid close as literal', () => {
    expect(shape('2 * 3')).toEqual([]); // space-flanked → not emphasis
    expect(shape('a * b')).toEqual([]);
    expect(shape('lone * star')).toEqual([]);
  });

  it('requires non-space immediately inside the delimiters', () => {
    expect(shape('** not bold **')).toEqual([]);
    expect(shape('*x *')).toEqual([]); // trailing space before close
  });

  it('skips an empty pair (a just-inserted `****`/` `` `)', () => {
    expect(shape('****')).toEqual([]);
    expect(shape('``')).toEqual([]);
    expect(shape('~~~~')).toEqual([]);
  });

  it('does not recognize escaped delimiters', () => {
    expect(shape('\\*not italic\\*')).toEqual([]);
    expect(shape('\\*\\*literal\\*\\*')).toEqual([]);
  });

  it('treats code content as literal (no nested marks inside)', () => {
    expect(shape('`a*b*c`')).toEqual(['code:a*b*c']);
    expect(shape('`x_i`')).toEqual(['code:x_i']);
  });

  it('is non-overlapping, resuming after each region', () => {
    expect(shape('*a* *b*')).toEqual(['em:a', 'em:b']);
    expect(shape('`a` `b`')).toEqual(['code:a', 'code:b']);
  });
});
