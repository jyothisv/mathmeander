// Keyboard shortcuts for inline formatting (slice 2c-1+) — the no-mouse path the owner asked for. A shortcut
// only inserts/removes the markdown DELIMITERS; markRecognize applies the `styled` mark from them (single
// authority, like typing the delimiters by hand). So Mod-b on a selection wraps it in `**…**`; on an empty
// selection it drops `****` and parks the caret between, ready to type. A second press on a span the delimiters
// already wrap UNWRAPS it (toggle). Delimiters are never hidden, so this stays keyboard-navigable.
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import { isProseBlock } from './schema';

/** Would wrapping the selection in delimiters STRADDLE (or sit inside) a `$…$` math span — or cross an inline
 *  atom / line break? In any of those the inserted `**` can't pair (math/atoms break the recognizer's text run),
 *  so it would leave stray literal delimiters. We no-op instead. (Wrapping each plain sub-run is a possible
 *  future nicety; the common single-run case is unaffected.) */
export function crossesMathOrAtom(state: EditorState): boolean {
  const { from, to, empty } = state.selection;
  const isMath = (n: import('prosemirror-model').Node | null | undefined): boolean =>
    !!n && n.isText && n.marks.some((m) => m.type.name === 'mathExpr');
  if (empty) {
    // Inside a math RUN only if both neighbours are math-marked (a boundary is fine — `**` lands beside it).
    const $f = state.selection.$from;
    return isMath($f.nodeBefore) && isMath($f.nodeAfter);
  }
  let crosses = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      if (node.marks.some((m) => m.type.name === 'mathExpr')) crosses = true;
    } else if (node.isInline) {
      crosses = true; // a reference atom or hard_break in the range
    }
  });
  return crosses;
}

/** True when the text immediately around the selection is already `delim…delim` (so a toggle should UNWRAP). */
export function alreadyWrapped(
  doc: import('prosemirror-model').Node,
  from: number,
  to: number,
  delim: string,
): boolean {
  const n = delim.length;
  try {
    const before = doc.textBetween(from - n, from);
    const after = doc.textBetween(to, to + n);
    return before === delim && after === delim;
  } catch {
    return false;
  }
}

/** Toggle a markdown delimiter pair around the selection. `delim` is `**`/`*`/`~~`/`` ` ``. */
export function toggleDelimiter(delim: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    // Markup is a PROSE-block affordance only (plain prose + §B heading titles). A non-prose text block — the
    // `config` notation home, future code/spec blocks — also has `inlineContent`, so that check alone would let
    // Mod-b / `$` insert literal delimiters into its source. Gate on the prose-block contract (isProseBlock).
    if (!isProseBlock(state.selection.$from.parent) || !state.selection.$from.parent.inlineContent)
      return false;
    // Swallow (handled, no edit) rather than drop unpairable delimiters across/inside math or an atom.
    if (crossesMathOrAtom(state)) return true;
    const n = delim.length;
    if (dispatch) {
      const tr = state.tr;
      if (!empty && alreadyWrapped(state.doc, from, to, delim)) {
        // UNWRAP: drop the trailing then the leading delimiter (trailing first keeps the leading offset valid).
        tr.delete(to, to + n);
        tr.delete(from - n, from);
        tr.setSelection(TextSelection.create(tr.doc, from - n, to - n));
      } else if (empty) {
        // Empty: insert the pair, caret between — markRecognize styles once something is typed inside.
        tr.insertText(delim + delim, from);
        tr.setSelection(TextSelection.create(tr.doc, from + n));
      } else {
        // WRAP: closing first (positions before `to` stay valid), then opening; reselect the wrapped inner.
        tr.insertText(delim, to);
        tr.insertText(delim, from);
        tr.setSelection(TextSelection.create(tr.doc, from + n, to + n));
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** The default formatting keymap: bold / italic / strikethrough / inline code. */
export const formattingKeymap: Record<string, Command> = {
  'Mod-b': toggleDelimiter('**'),
  'Mod-i': toggleDelimiter('*'),
  'Mod-`': toggleDelimiter('`'),
  'Shift-Mod-x': toggleDelimiter('~~'),
};
