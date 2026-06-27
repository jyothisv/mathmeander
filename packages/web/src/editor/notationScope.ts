// Parse the NOTATION definitions in a config block's source into the registry the renderer applies
// (notation-as-register, §6.3a). The notation home is an explicit `config` block (UnitContent::Config,
// family `notation`); INSIDE it every line is a definition `TRIGGER := EXPANSION` (bare `mathmeander`
// surface — no `$…$`, and NO `notation` keyword: the block IS the context). It is RENDER-ONLY — the source
// stays literal; collecting these (in source order = definition order, the frozen-prior-scope rule) builds
// the scope passed to the scoped render so math elsewhere resolves against it. (Replaces N1's
// recognize-`notation … :=`-anywhere doc-scan — the "too risky" failure where any prose line could become a
// definition; the scope cascade — section/notebook/space — and a rendered legend come later.)
import type { NotationDef } from './mathRuntime';

// A definition line: `TRIGGER := EXPANSION`. The non-greedy trigger binds to the FIRST `:=`, so an expansion
// may itself contain a `:` (the NN-masking case `NN := : NN -> NN`). A line with no `:=` (blank, a note) is
// skipped — malformed lines are never rejected (lossless).
const NOTATION_DEF = /^\s*(.+?)\s*:=\s*(.+?)\s*$/;

/** Notation defs parsed from a config block's `source` (one per line, in source order). */
export function notationDefsFromSource(source: string): NotationDef[] {
  const defs: NotationDef[] = [];
  for (const line of source.split('\n')) {
    const m = NOTATION_DEF.exec(line);
    if (m) defs.push({ trigger: m[1]!, expansion: m[2]! });
  }
  return defs;
}

/** A stable fingerprint of a scope, for memo / decoration-cache keys (changes iff a definition changes,
 *  so dependent math re-renders when a definition is edited). */
export function notationScopeKey(defs: NotationDef[]): string {
  return defs.map((d) => `${d.trigger} ${d.expansion}`).join('');
}
