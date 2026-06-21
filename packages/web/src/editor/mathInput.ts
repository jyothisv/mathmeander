// Math entry. Typing `$` in prose inserts an empty inline-math node and drops the caret INSIDE it — born
// OPEN, with the source revealed, so you just keep typing the math (the "as natural as a notebook" gesture).
// The trigger `$` is consumed. Exiting (caret past the closing delimiter, or `$`/Tab/Esc — see mathKeys)
// re-renders; an empty math left behind (`$` then Esc / immediate `$`) becomes a literal `$` or is cleaned
// up by mathSync. Display `$$` entry arrives with the display-math phase.
import { InputRule } from 'prosemirror-inputrules';
import { type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { editorSchema } from './schema';
import { emptyExpr } from './mathExpr';

const DOLLAR = /\$$/;

/** The `$`-in-prose transform: insert an empty inline-math node and drop the caret inside it (born open).
 *  Exported for unit tests. Returns null outside prose (math entry is a prose-mode gesture). */
export function applyMathRule(
  state: EditorState,
  _match: RegExpMatchArray,
  start: number,
): Transaction | null {
  const $start = state.doc.resolve(start);
  if ($start.parent.type.name !== 'prose') return null;
  const node = editorSchema.nodes.inlineMath.create({ expr: emptyExpr() });
  const tr = state.tr.replaceRangeWith(start, start, node);
  // `start` = before the new node, `start + 1` = inside its (empty) content → the mathOpen decoration marks
  // it open and the source is revealed for typing.
  return tr.setSelection(TextSelection.create(tr.doc, start + 1));
}

/** The `$` rule, exported so the editor composes it with the cue rule into ONE `inputRules` plugin
 *  (ProseMirror only runs `handleTextInput` on a single inputRules plugin). */
export const mathRule = new InputRule(DOLLAR, applyMathRule);
