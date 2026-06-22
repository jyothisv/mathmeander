// Controlled deletion at the inline-math boundary (slice 2d editable-syntax). Inline math is `$…$` TEXT, and a
// RENDERED equation hides its source via a `display:none` inline decoration + a KaTeX widget (mathLivePreview).
// The BROWSER's native single-character delete misbehaves next to that invisible adjacent content — e.g.
// `$x$ ` + Backspace deletes the whole equation instead of just the space. These commands intercept Backspace/
// Delete when the caret is adjacent to (or inside) a `mathExpr` span and perform the delete at the DOCUMENT
// level (`tr.delete`), pre-empting the flaky native deletion. Off the math boundary they return false, so
// normal prose editing falls through to the native fast path untouched.
import { type Command, TextSelection } from 'prosemirror-state';
import { editorSchema } from './schema';

const MARK = editorSchema.marks.mathExpr;

/** Backspace: when the character to delete is in a `$…$` span or sits immediately after one, delete exactly
 *  that one character at the PM level (pre-empting native). Returns false for plain text → native handles it. */
export const mathBackspace: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty) return false; // a non-empty selection deletes normally
  const $c = sel.$from;
  if ($c.parent.type.name !== 'prose') return false;
  const p = $c.pos;
  const start = $c.start();
  if (p <= start) return false; // block start → clearType/merge (and native joins) own it
  const delIsMath = state.doc.rangeHasMark(p - 1, p, MARK); // the char being deleted is math
  const afterMath = p - 1 > start && state.doc.rangeHasMark(p - 2, p - 1, MARK); // it sits right after math
  if (!delIsMath && !afterMath) return false; // not at a math boundary → let native delete plain text
  if (dispatch) {
    const tr = state.tr.delete(p - 1, p);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, p - 1)).scrollIntoView());
  }
  return true;
};

/** Delete (forward): the mirror of mathBackspace — the char at `[p, p+1]` is math or is immediately followed
 *  by one → delete that one character at the PM level. */
export const mathDelete: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty) return false;
  const $c = sel.$from;
  if ($c.parent.type.name !== 'prose') return false;
  const p = $c.pos;
  const end = $c.end();
  if (p >= end) return false;
  const delIsMath = state.doc.rangeHasMark(p, p + 1, MARK);
  const beforeMath = p + 1 < end && state.doc.rangeHasMark(p + 1, p + 2, MARK);
  if (!delIsMath && !beforeMath) return false;
  if (dispatch) {
    const tr = state.tr.delete(p, p + 1);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, p)).scrollIntoView());
  }
  return true;
};
