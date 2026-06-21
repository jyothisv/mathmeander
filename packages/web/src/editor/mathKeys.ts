// Math-mode key rules (§9.x InputEnvironment — "math mode has its own rules for Enter etc."). The caret is
// inside an inline-math node when `$from.parent` is `inlineMath`; there these commands take over (Enter/Tab/
// Esc exit; arrows exit at the boundary; Backspace removes an empty node). Outside, when the caret sits in
// prose right next to a RENDERED equation, Backspace-after / Delete-before OPEN that equation (reveal its
// source) instead of deleting it — the Obsidian "delete the closing/opening `$`" gesture. Each command
// returns `false` when its context doesn't apply, so it falls through to the prose keymaps.
//
// The prose-mode commands self-disable inside math for free (they gate on `$from.parent.type.name ===
// 'prose'`), so the only ADDED surface is here + the `$`-exit text handler (a `$` typed inside math is text,
// not a keymap key, and input rules don't fire in a non-textblock parent).
import {
  type Command,
  type EditorState,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';

type Dispatch = ((tr: Transaction) => void) | undefined;

const inMath = ($pos: ResolvedPos): boolean => $pos.parent.type.name === 'inlineMath';

/** A FRESH expression (no anchors) is the only one we open for inline-source editing — the `normalizeFresh`
 *  path (mathSync) is valid only fresh; anchored exprs route to the core's `rewrite_surface` (a later slice).
 *  The §6.3a keystone guard, applied at every open gesture. */
export function isFreshMath(node: PMNode): boolean {
  if (node.type.name !== 'inlineMath') return false;
  return ((node.attrs.expr as MathExpression).occurrences?.length ?? 0) === 0;
}

const moveCaret = (state: EditorState, dispatch: Dispatch, pos: number, bias: 1 | -1): void => {
  if (dispatch)
    dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos), bias)).scrollIntoView());
};

/** Place the caret just AFTER the current math node (render + leave). */
function exitAfter(state: EditorState, dispatch: Dispatch): boolean {
  const $from = state.selection.$from;
  if (!inMath($from)) return false;
  moveCaret(state, dispatch, $from.after(), 1);
  return true;
}

/** Place the caret just BEFORE the current math node. */
function exitBefore(state: EditorState, dispatch: Dispatch): boolean {
  const $from = state.selection.$from;
  if (!inMath($from)) return false;
  moveCaret(state, dispatch, $from.before(), -1);
  return true;
}

/** Enter / Tab / Shift-Enter inside math → exit after the node (math has no in-flow line breaks here). */
export const mathExit: Command = (state, dispatch) => exitAfter(state, dispatch);

/** Escape inside math → exit; on an EMPTY node leave a literal `$` (the `$`-then-Esc escape hatch). */
export const mathEscape: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (!inMath($from)) return false;
  if ($from.parent.content.size === 0) {
    if (dispatch) {
      const tr = state.tr.replaceRangeWith($from.before(), $from.after(), editorSchema.text('$'));
      dispatch(
        tr.setSelection(Selection.near(tr.doc.resolve($from.before() + 1), 1)).scrollIntoView(),
      );
    }
    return true;
  }
  return exitAfter(state, dispatch);
};

/** ArrowRight at the END of the source → exit after the node (otherwise move within the source). */
export const mathArrowRight: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (!inMath($from) || !state.selection.empty) return false;
  if ($from.parentOffset < $from.parent.content.size) return false;
  return exitAfter(state, dispatch);
};

/** ArrowLeft at the START of the source → exit before the node (otherwise move within the source). */
export const mathArrowLeft: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (!inMath($from) || !state.selection.empty) return false;
  if ($from.parentOffset > 0) return false;
  return exitBefore(state, dispatch);
};

/** Backspace INSIDE math:
 *  - at the start of an EMPTY node → delete the node;
 *  - at the start of a non-empty node → step out before it (a 2nd Backspace then removes it);
 *  - deleting the LAST remaining char → leave an EMPTY-OPEN node with the caret inside (the born-open state),
 *    via a PM-controlled delete. A native delete would instead empty the atom and let PM collapse the caret
 *    into a NodeSelection (mathOpen drops → it re-renders the just-deleted char) — the reported bug;
 *  - otherwise (>1 char) → fall through to the native single-char delete. */
export const mathBackspace: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (!inMath($from) || !state.selection.empty) return false;
  const off = $from.parentOffset;
  const size = $from.parent.content.size;
  if (off === 0) {
    if (size === 0) {
      if (dispatch) dispatch(state.tr.delete($from.before(), $from.after()).scrollIntoView());
      return true;
    }
    return exitBefore(state, dispatch);
  }
  if (size === 1) {
    if (dispatch) {
      const inside = $from.before() + 1; // the single interior position (becomes the empty node's caret home)
      const tr = state.tr.delete(inside, inside + 1);
      tr.setSelection(TextSelection.create(tr.doc, inside));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  return false; // >1 char remaining → native single-char delete is fine
};

/** Delete (forward) INSIDE math — the mirror of mathBackspace:
 *  - at the END of the source → empty: delete the node; non-empty: step out after it;
 *  - before the ONLY char → leave an EMPTY-OPEN node with the caret inside (PM-controlled), avoiding the
 *    native delete-to-empty that collapses the atom into a NodeSelection and re-renders the just-deleted char
 *    (the same bug mathBackspace fixes);
 *  - otherwise (>1 char) → fall through to the native forward delete. */
export const mathDelete: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (!inMath($from) || !state.selection.empty) return false;
  const off = $from.parentOffset;
  const size = $from.parent.content.size;
  if (off === size) {
    if (size === 0) {
      if (dispatch) dispatch(state.tr.delete($from.before(), $from.after()).scrollIntoView());
      return true;
    }
    return exitAfter(state, dispatch);
  }
  if (size === 1) {
    if (dispatch) {
      const inside = $from.before() + 1;
      const tr = state.tr.delete(inside, inside + 1);
      tr.setSelection(TextSelection.create(tr.doc, inside));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  return false; // >1 char remaining → native forward delete is fine
};

/** Backspace in PROSE right after a rendered (fresh) equation → OPEN it with the caret at the source END
 *  ("delete the closing `$`"), instead of deleting the whole equation. */
export const openMathBackward: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (inMath($from) || !state.selection.empty) return false;
  const before = $from.nodeBefore;
  if (!before || !isFreshMath(before)) return false;
  if (dispatch) {
    const end = $from.pos - 1; // just inside the node's closing token = end of its source
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)).scrollIntoView());
  }
  return true;
};

/** Delete in PROSE right before a rendered (fresh) equation → OPEN it with the caret at the source START
 *  ("delete the opening `$`"), instead of deleting the whole equation. */
export const openMathForward: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if (inMath($from) || !state.selection.empty) return false;
  const after = $from.nodeAfter;
  if (!after || !isFreshMath(after)) return false;
  if (dispatch) {
    const start = $from.pos + 1; // just inside the node's opening token = start of its source
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, start)).scrollIntoView());
  }
  return true;
};

/** A `$` typed inside math exits (the closing delimiter); on an EMPTY node it leaves a literal `$` (the
 *  `$`-then-`$` escape hatch). Registered as `handleTextInput` because `$` is text, not a keymap key, and
 *  input rules don't fire when the parent (`inlineMath`) is not a textblock. */
export function dollarExit(view: EditorView, _from: number, _to: number, text: string): boolean {
  if (text !== '$') return false;
  const $from = view.state.selection.$from;
  if (!inMath($from)) return false;
  if ($from.parent.content.size === 0) {
    const tr = view.state.tr.replaceRangeWith(
      $from.before(),
      $from.after(),
      editorSchema.text('$'),
    );
    view.dispatch(
      tr.setSelection(Selection.near(tr.doc.resolve($from.before() + 1), 1)).scrollIntoView(),
    );
    return true;
  }
  view.dispatch(
    view.state.tr
      .setSelection(Selection.near(view.state.doc.resolve($from.after()), 1))
      .scrollIntoView(),
  );
  return true;
}

/** The `$`-exit text handler as a plugin, so it can be ordered before the inputRules plugin. */
export const mathDollarExit = new Plugin({
  props: { handleTextInput: dollarExit },
});
