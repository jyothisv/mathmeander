// Wrap a SELECTION in math by typing `$` (slice 2c-3, the owner's chosen gesture) — the no-delimiter-typing
// path for turning prose into math, mirroring the `Mod-b`/`Mod-i` wrap. A `$` typed over a NON-EMPTY plain
// selection wraps it in `$…$` (inline math; reusing the proven `toggleDelimiter`/`crossesMathOrAtom` logic);
// a `$` typed over a selection that is ALREADY one inline `$…$` equation upgrades it to `$$…$$` and splits it
// onto its own block (display). An EMPTY selection is left to type a literal `$` (the inline recognizer then
// handles a hand-typed `$…$`). The recognizers (mathRecognize) apply identity afterward — this only edits text.
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import { toggleDelimiter } from './markKeys';
import { splitLineOut } from './cues';

/** The `[from,to)` of a single contiguous INLINE (`display:false`) `mathExpr` run that fully contains the
 *  selection `[from,to]`, or null. Used to detect "the selection IS an inline equation" → upgrade to display. */
function inlineMathRegionAround(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const $from = state.doc.resolve(from);
  const block = $from.parent;
  if (!block.isTextblock) return null;
  const cStart = $from.start();
  const runs: { from: number; to: number; id: string }[] = [];
  let cur: { from: number; to: number; id: string } | null = null;
  let p = cStart;
  block.forEach((child) => {
    const m = child.isText
      ? child.marks.find((mk) => mk.type.name === 'mathExpr' && !(mk.attrs.display as boolean))
      : undefined;
    const id = m ? ((m.attrs.expr as { id: string }).id ?? '') : null;
    if (m && cur && cur.id === id && cur.to === p) {
      cur.to = p + child.nodeSize;
    } else {
      if (cur) runs.push(cur);
      cur = m ? { from: p, to: p + child.nodeSize, id: id! } : null;
    }
    p += child.nodeSize;
  });
  if (cur) runs.push(cur);
  return runs.find((r) => from >= r.from && to <= r.to) ?? null;
}

/** Does the run `[regionFrom, regionTo)` occupy its ENTIRE hard_break-delimited line? Only then can a
 *  display upgrade succeed (splitLineOut peels the line, and a whole-block `$$…$$` is recognized). A mid-line
 *  equation (`foo $x$ bar`) is NOT whole-line — upgrading it would leave stray `$` baked into the prose. */
function isWholeLineEquation(state: EditorState, regionFrom: number, regionTo: number): boolean {
  const $f = state.doc.resolve(regionFrom);
  const block = $f.parent;
  if (!block.isTextblock) return false;
  const cStart = $f.start();
  let lineStart = cStart;
  let lineEnd = cStart + block.content.size;
  let foundEnd = false;
  let p = cStart;
  block.forEach((child) => {
    if (child.type.name === 'hard_break') {
      if (p < regionFrom) lineStart = p + 1; // a break before the run → the line starts after it
      else if (!foundEnd) {
        lineEnd = p; // the first break at/after the run → the line ends here
        foundEnd = true;
      }
    }
    p += child.nodeSize;
  });
  return regionFrom === lineStart && regionTo === lineEnd;
}

/** Type `$` over a selection (see module header). Returns false for an empty selection (let `$` type
 *  normally); otherwise handles it (wrap to inline `$…$`, or upgrade an inline equation to display `$$…$$`). */
export const wrapSelectionAsMath: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  const region = inlineMathRegionAround(state, from, to);
  if (region) {
    // The selection is already one inline `$…$` equation. Upgrade to a `$$…$$` DISPLAY block ONLY when it's
    // the whole line and not in a heading title (a heading is never display; a mid-line equation can't be
    // isolated, so upgrading would leave stray `$` in the prose — M2). Otherwise leave the inline math as-is
    // (a swallowed no-op — never strip it).
    const canUpgrade =
      !(state.selection.$from.parent.attrs.heading as boolean) &&
      isWholeLineEquation(state, region.from, region.to);
    if (!canUpgrade) return true;
    if (dispatch) {
      const tr = state.tr;
      tr.insertText('$', region.to); // → `$…$$` (after the trailing `$`)
      tr.insertText('$', region.from); // → `$$…$$` (before the leading `$`)
      const base = tr.mapping.maps.length;
      splitLineOut(tr, region.from + 1); // isolate onto its own block (mathRecognize marks it display)
      const lineEnd = tr.doc.resolve(tr.mapping.slice(base).map(region.from + 1)).end();
      dispatch(tr.setSelection(TextSelection.create(tr.doc, lineEnd)).scrollIntoView());
    }
    return true;
  }
  // Plain selection → wrap in inline `$…$` (no-ops across a math span / atom, via crossesMathOrAtom).
  return toggleDelimiter('$')(state, dispatch);
};
