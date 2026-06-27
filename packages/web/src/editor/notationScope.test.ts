import { describe, expect, it } from 'vitest';
import { notationDefsFromSource, notationScopeKey } from './notationScope';

describe('notationDefsFromSource', () => {
  it('parses a `TRIGGER := EXPANSION` line (no keyword — the config block is the context)', () => {
    expect(notationDefsFromSource('Z* := ZZ^*')).toEqual([{ trigger: 'Z*', expansion: 'ZZ^*' }]);
  });

  it('keeps the whole expansion, including a leading `:` (the NN-masking case)', () => {
    expect(notationDefsFromSource('NN := : NN -> NN')).toEqual([
      { trigger: 'NN', expansion: ': NN -> NN' },
    ]);
  });

  it('collects multiple defs in source order; skips blank/non-def lines (lossless)', () => {
    const src = 'Z* := ZZ^*\n\na note with no separator\nN2NN := NN -> NN x NN';
    expect(notationDefsFromSource(src)).toEqual([
      { trigger: 'Z*', expansion: 'ZZ^*' },
      { trigger: 'N2NN', expansion: 'NN -> NN x NN' },
    ]);
  });

  it('tolerates surrounding whitespace; requires `:=` (a bare `=` is not a definition)', () => {
    expect(notationDefsFromSource('   eps  :=  epsilon   ')).toEqual([
      { trigger: 'eps', expansion: 'epsilon' },
    ]);
    expect(notationDefsFromSource('Z* = ZZ^*')).toEqual([]);
  });

  it('scopeKey is stable for equal scopes and changes when a definition changes', () => {
    const a = notationDefsFromSource('Z* := ZZ^*');
    const b = notationDefsFromSource('Z* := ZZ^*');
    const c = notationDefsFromSource('Z* := ZZ^**');
    expect(notationScopeKey(a)).toBe(notationScopeKey(b));
    expect(notationScopeKey(a)).not.toBe(notationScopeKey(c));
  });
});
