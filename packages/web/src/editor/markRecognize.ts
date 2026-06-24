// The inline-FORMATTING recognizer (markdown marks) — the `styled`-mark analogue of mathRecognize. Runs as an
// appendTransaction after every doc edit: per prose block it applies the `styled` mark over the INNER of each
// `**bold**` / `*italic*` / `~~strike~~` / `` `code` `` region, leaving the delimiters as plain editable text
// (the keyboard-friendly, don't-consume decision — like the `$…$` math delimiters). A `styled` mark over the
// inner round-trips through the existing projection unchanged (blockToProse reads it as `Inline::Mark`), so
// there is no flush/project change.
//
//   • MATH WINS: only the text runs NOT carrying the `mathExpr` mark are scanned, so a `*` inside `$a*b$` is
//     never read as emphasis. Run this plugin AFTER mathRecognize so the math marks are already settled.
//   • IDEMPOTENT: a transaction is emitted only when the desired `styled` spans differ from the current ones,
//     so loading server content (already carrying the marks) produces no spurious edit and it converges.
//   • Only the `styled` mark is touched (mathExpr/others are preserved): we removeMark(styled) over the block
//     and re-add the desired spans.
import { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { editorSchema } from './schema';
import { findMarkRegions } from './markSyntax';

const STYLED = editorSchema.marks.styled;
const MATH = editorSchema.marks.mathExpr;

interface Span {
  from: number;
  to: number;
  style: string;
}

/** Contiguous runs of NON-math text in a block (absolute start + text), broken by math-marked text, atoms
 *  (`reference`) and `hard_break`s — a formatting region never spans them (and math wins). Text positions are
 *  char-aligned (a text node is one position per char), so a run offset maps to a doc position as `start + off`. */
function plainRuns(block: PMNode, contentStart: number): { start: number; text: string }[] {
  const runs: { start: number; text: string }[] = [];
  let start = -1;
  let text = '';
  let pos = contentStart;
  const flush = () => {
    if (text.length > 0) runs.push({ start, text });
    start = -1;
    text = '';
  };
  block.forEach((child) => {
    if (child.isText && !child.marks.some((m) => m.type === MATH)) {
      if (start < 0) start = pos;
      text += child.text ?? '';
    } else flush();
    pos += child.nodeSize;
  });
  flush();
  return runs;
}

/** The desired styled spans for a block: every formatting region's INNER, in document positions. */
function desiredSpans(block: PMNode, contentStart: number): Span[] {
  const spans: Span[] = [];
  for (const run of plainRuns(block, contentStart)) {
    for (const r of findMarkRegions(run.text)) {
      spans.push({ from: run.start + r.innerStart, to: run.start + r.innerEnd, style: r.style });
    }
  }
  return spans;
}

/** The styled spans currently on a block (absolute positions), adjacent same-style runs merged. */
function currentSpans(block: PMNode, contentStart: number): Span[] {
  const raw: Span[] = [];
  let pos = contentStart;
  block.forEach((child) => {
    if (child.isText) {
      const m = child.marks.find((x) => x.type === STYLED);
      if (m) raw.push({ from: pos, to: pos + child.nodeSize, style: m.attrs.style as string });
    }
    pos += child.nodeSize;
  });
  const merged: Span[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.to === s.from && prev.style === s.style) prev.to = s.to;
    else merged.push({ ...s });
  }
  return merged;
}

/** Do the desired styled spans already match the current ones (same range + style)? */
function inSync(desired: Span[], current: Span[]): boolean {
  if (desired.length !== current.length) return false;
  const d = [...desired].sort((a, b) => a.from - b.from);
  const c = [...current].sort((a, b) => a.from - b.from);
  for (let i = 0; i < d.length; i++) {
    if (d[i]!.from !== c[i]!.from || d[i]!.to !== c[i]!.to || d[i]!.style !== c[i]!.style)
      return false;
  }
  return true;
}

export const markRecognize = new Plugin({
  appendTransaction(transactions, _old, newState) {
    if (!transactions.some((t) => t.docChanged)) return null;
    let tr: ReturnType<typeof newState.tr.removeMark> | null = null;
    newState.doc.forEach((block, offset) => {
      if (block.type.name !== 'prose') return;
      const contentStart = offset + 1;
      const blockEnd = contentStart + block.content.size;
      const desired = desiredSpans(block, contentStart);
      if (inSync(desired, currentSpans(block, contentStart))) return;
      tr = tr ?? newState.tr;
      // LATENT (when import/seed/API land): this removes EVERY `styled` mark and re-adds only the
      // delimiter-derived ones, so a "clean" `Inline::Mark` (styled text with NO surrounding `**` in the prose)
      // would be stripped on the first edit — silent style loss, which the no-silent-loss rule (§2.2) forbids.
      // The editor never produces such a mark today (it always carries delimiters), so it's unreachable now.
      // Fix WITH import: have projection synthesize `**inner**` for every canonical Mark (so it round-trips as a
      // delimiter-wrapped, editor-representable region) and strip on flush — OR fail `isEditable` closed on a
      // delimiter-less mark. markLivePreview already guards clean marks; this site must match when import lands.
      tr.removeMark(contentStart, blockEnd, STYLED); // only `styled`; mathExpr/others preserved
      for (const s of desired) tr.addMark(s.from, s.to, STYLED.create({ style: s.style }));
    });
    return tr;
  },
});
