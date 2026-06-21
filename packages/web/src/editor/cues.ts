// Type cues (slice 2c-2, §9.x InputEnvironment seed) — the editor-adapter recognition layer, pure enough
// to unit-test (prosemirror-state/model/inputrules run in node, no DOM). A leading cue at block start
// (`Thm. ` / `Def: `) makes that unit that type — "the way Markdown turns `#` into a heading" (§9.y).
// Recognition is a frontend adapter; the type is APPLIED by the canonical `set_unit_type` op (§6.0a) —
// the controller drains the node's `unitType` attr after the prose flush. Types are drawn from the
// generated `UnitType` union (never re-declared, §6.0a). Leading cue is the only gesture in 2c-2.
import { InputRule, inputRules } from 'prosemirror-inputrules';
import { type Command, type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { UnitType } from '@mathmeander/schema';
import { editorSchema } from './schema';

export const CUE_MAP: Record<string, UnitType> = {
  Thm: 'theorem',
  Lem: 'lemma',
  Prop: 'proposition',
  Cor: 'corollary',
  Def: 'definition',
  Conj: 'conjecture',
  Claim: 'claim',
  Q: 'question',
  Pf: 'proof',
  Ex: 'example',
  Rmk: 'remark',
  Idea: 'idea',
  Note: 'note',
};
export const CUE_RE = new RegExp(`^(${Object.keys(CUE_MAP).join('|')})[.:]\\s$`);

/** The InputRule transform: a leading cue the user just typed (the trailing space triggers it) → strip
 *  the cue text and set the block's `unitType`. Block-start only; returns null otherwise. Exported for
 *  unit tests. DELETE `[start, end]` — the doc range of the match EXCLUDING the trigger char, which the
 *  rule has not inserted yet and consumes. (Using `start + match[0].length` would overshoot by the trigger
 *  char's length and eat the first content character when a cue is typed BEFORE existing content.) */
export function applyCue(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const word = match[1];
  const type = word ? CUE_MAP[word] : undefined;
  if (!type) return null;
  const $start = state.doc.resolve(start);
  if ($start.parent.type.name !== 'prose' || $start.parentOffset !== 0) return null; // block start only
  const blockPos = $start.before();
  return state.tr.delete(start, end).setNodeAttribute(blockPos, 'unitType', type);
}

export const typeCueInputRules = inputRules({ rules: [new InputRule(CUE_RE, applyCue)] });

/** Backspace at the very start of a TYPED prose block clears its type back to plain (the reversibility
 *  gesture). Returns false otherwise so the normal (undo-input-rule / merge) backspace runs. NEVER deletes
 *  text. */
export const clearTypeAtStart: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if ($cursor.parentOffset !== 0 || $cursor.parent.attrs.unitType == null) return false;
  if (dispatch) dispatch(state.tr.setNodeAttribute($cursor.before(), 'unitType', null));
  return true;
};

/** Enter inside a TYPED block inserts a line break — the block stays ONE multi-line unit (owner choice:
 *  typed blocks never auto-split/exit). Returns false in a plain block so baseKeymap splits it (new unit). */
export const enterInTypedBlock: Command = (state, dispatch) => {
  const { $head, empty } = state.selection;
  if (!empty || $head.parent.type.name !== 'prose' || $head.parent.attrs.unitType == null)
    return false;
  if (dispatch)
    dispatch(
      state.tr.replaceSelectionWith(editorSchema.nodes.hard_break.create()).scrollIntoView(),
    );
  return true;
};

/** Shift-Enter: a soft line break anywhere (typed or plain). */
export const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch)
    dispatch(
      state.tr.replaceSelectionWith(editorSchema.nodes.hard_break.create()).scrollIntoView(),
    );
  return true;
};
