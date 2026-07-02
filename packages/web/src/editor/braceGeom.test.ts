import { describe, expect, it } from 'vitest';
import {
  BRACE_DEPTH,
  LABEL_HEIGHT,
  bandDeficit,
  gapPx,
  horizontalBracePath,
  hullSidesAt,
  isPathPrefix,
  isHorizontalBrace,
  isLeadingBrace,
  reservedBand,
  unionRect,
  type PathBoxLike,
} from './braceGeom';

describe('braceGeom (§6.2)', () => {
  it('maps the LayoutStep spacing vocabulary to a monotonic px scale', () => {
    expect(gapPx('none')).toBe(0);
    expect(gapPx('small')).toBeLessThan(gapPx('medium'));
    expect(gapPx('medium')).toBeLessThan(gapPx('large'));
  });

  it('reserves brace depth + label + both gaps for the band', () => {
    expect(reservedBand('none')).toBe(BRACE_DEPTH + LABEL_HEIGHT);
    expect(reservedBand('large')).toBe(BRACE_DEPTH + LABEL_HEIGHT + gapPx('large') * 2);
  });

  it('unions a set of rects into their bounding box (null when empty)', () => {
    expect(unionRect([])).toBeNull();
    const u = unionRect([
      { left: 10, top: 5, right: 30, bottom: 15 },
      { left: 20, top: 2, right: 50, bottom: 12 },
    ]);
    expect(u).toEqual({ left: 10, top: 2, right: 50, bottom: 15 });
  });

  it('builds a horizontal curly brace whose flat edge is y=0 and central tooth reaches full depth', () => {
    const d = horizontalBracePath(100, 8);
    // Starts at the left flat edge and ends at the right flat edge (both y=0).
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.trimEnd().endsWith('100 0')).toBe(true);
    // The central tooth (x = 50) reaches the full depth (y = 8) — the curly-brace silhouette, not an arch.
    expect(d).toContain('50 8');
  });

  it('clamps degenerate sizes so a zero-width/height span still yields a valid path', () => {
    const d = horizontalBracePath(0, 0);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d).not.toContain('NaN');
  });

  it('classifies brace orientation + side by kind', () => {
    expect(isHorizontalBrace('overbrace')).toBe(true);
    expect(isHorizontalBrace('underbrace')).toBe(true);
    expect(isHorizontalBrace('left_brace')).toBe(false);
    expect(isLeadingBrace('overbrace')).toBe(true);
    expect(isLeadingBrace('underbrace')).toBe(false);
    expect(isLeadingBrace('left_brace')).toBe(true);
    expect(isLeadingBrace('right_brace')).toBe(false);
  });
});

// ── The outer-hull rule (P1) — path-aware fixtures shaped like a rendered `(a+b)/(c+d)` ──
// Paths mirror the real `data-path` output: `""` root, `0.0` = the numerator content, `1.0` = the denominator
// content (leaf glyph boxes carry LEADING, so the numerator's box bottom grazes the denominator's top — the
// center-based test must be immune to that knife edge).
const nodesOf = (): PathBoxLike[] => [
  { path: '', rect: { left: 5, top: 0, right: 65, bottom: 50 } }, // the whole fraction (root)
  { path: '0.0', rect: { left: 10, top: 0, right: 60, bottom: 26 } }, // numerator (a+b) — bottom grazes below
  { path: '1.0', rect: { left: 12, top: 25, right: 58, bottom: 50 } }, // denominator (c+d) — top grazes above
];

describe('hullSidesAt (§6.2 P1 — braces never create intra-expression space)', () => {
  it('numerator: over only (the denominator mass sits below, despite the 1px box graze)', () => {
    expect(hullSidesAt('0.0', nodesOf())).toEqual({ over: true, under: false });
  });

  it('denominator: under only (the numerator mass sits above, despite the 1px box graze)', () => {
    expect(hullSidesAt('1.0', nodesOf())).toEqual({ over: false, under: true });
  });

  it('the whole expression (root): both sides — its descendants never veto it', () => {
    expect(hullSidesAt('', nodesOf())).toEqual({ over: true, under: true });
  });

  it('ancestors never veto: the root wrapper box does not block its denominator by itself', () => {
    const onlyAncestor: PathBoxLike[] = nodesOf().filter((n) => n.path !== '0.0');
    expect(hullSidesAt('1.0', onlyAncestor)).toEqual({ over: true, under: true });
  });

  it('content beside the target (no horizontal overlap) never blocks, however tall — x^2: over on the base is fine', () => {
    const nodes: PathBoxLike[] = [
      { path: '', rect: { left: 0, top: 0, right: 16, bottom: 20 } },
      { path: '0', rect: { left: 0, top: 8, right: 10, bottom: 20 } }, // the base x
      { path: '1', rect: { left: 10.5, top: 0, right: 16, bottom: 10 } }, // the exponent, up-right (no h-overlap)
    ];
    expect(hullSidesAt('0', nodes)).toEqual({ over: true, under: true });
  });

  it('a missing target path degrades permissive (never lock the gesture)', () => {
    expect(hullSidesAt('9.9', nodesOf())).toEqual({ over: true, under: true });
  });

  it('isPathPrefix: the root prefixes everything; dotted prefixes are segment-wise', () => {
    expect(isPathPrefix('', '1.0')).toBe(true);
    expect(isPathPrefix('1', '1.0')).toBe(true);
    expect(isPathPrefix('1.0', '1.0')).toBe(true);
    expect(isPathPrefix('1', '10')).toBe(false); // "1" is NOT a prefix of segment "10"
    expect(isPathPrefix('1.0', '1')).toBe(false);
  });
});

describe('bandDeficit (§6.2 P2 — reserve only what existing space cannot absorb)', () => {
  it('reserves the full band when there is no gap, the remainder for a partial gap, 0 when room exists', () => {
    expect(bandDeficit(30, 0)).toBe(30);
    expect(bandDeficit(30, 12)).toBe(18);
    expect(bandDeficit(30, 30)).toBe(0);
    expect(bandDeficit(30, 45)).toBe(0);
  });

  it('treats a negative measured gap as zero (never reserve extra for measurement noise)', () => {
    expect(bandDeficit(30, -5)).toBe(30);
  });
});
