// Type cues + the paragraph-model gestures (slice 2c-2, §9.x InputEnvironment seed) — the editor-adapter
// keystroke layer, pure enough to unit-test (prosemirror-state/model/inputrules run in node, no DOM).
//
// Two kinds of content behave differently ON PURPOSE (a unit is the smallest independently-meaningful
// chunk): plain journal prose is a FLOW (a blank line starts the next unit), while a TYPED object
// (Thm./Pf./Def.…) is a bounded MULTI-PARAGRAPH container (blank lines stay inside; you leave it with a
// deliberate gesture). A within-unit line break is a `hard_break` ↔ a single `\n` in the unit's prose text
// (projection.ts). Recognition is a frontend adapter; the TYPE is APPLIED by the canonical `set_unit_type`
// op (§6.0a) — the controller drains the node's `unitType` attr after the prose flush. Types are drawn from
// the generated `UnitType` union (never re-declared, §6.0a).
import { InputRule, inputRules } from 'prosemirror-inputrules';
import {
  type Command,
  type EditorState,
  Selection,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import type { ResolvedPos } from 'prosemirror-model';
import type { UnitType } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { wholeDisplaySource } from './mathSyntax';

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
// A cue fires at a LINE start: either the block start (`^`) or right after a within-unit break. In the text
// `prosemirror-inputrules` matches against, every leaf inline node (a `hard_break`, math/reference atom) is
// the object-replacement char `￼`; so `(?:^|￼)` = "at a line start". Mid-line `Def:` never fires.
export const CUE_RE = new RegExp(`(?:^|\\ufffc)(${Object.keys(CUE_MAP).join('|')})[.:]\\s$`);

const proseType = editorSchema.nodes.prose;
const hardBreak = () => editorSchema.nodes.hard_break.create();

/** The InputRule transform for a leading cue (the trailing space triggers it). Two effects by position:
 *  at a UNIT start (offset 0) → set/CHANGE the block's `unitType` (re-type); at a SOFT-LINE start (right
 *  after a `hard_break`) → SPLIT off a new typed unit from that line to the end of the block. `[start,end]`
 *  is the doc range of the match EXCLUDING the not-yet-inserted trigger char; for a line-start match it also
 *  spans the preceding `hard_break` (the `￼`). Exported for unit tests. */
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
  if ($start.parent.type.name !== 'prose') return null;

  // The match is anchored to a line start: `^` (block start) leaves match[0] beginning with the cue word;
  // a within-line leaf leaves it beginning with `￼` (the object-replacement char). Discriminate on that —
  // NOT on parentOffset, which is also 0 when a leaf ATOM sits at the block start (a mid-line cue, no rule).
  if (match[0].charCodeAt(0) !== 0xfffc) {
    if ($start.parentOffset !== 0) return null; // matched `^` mid-block (a >500-char line) → not a cue
    // unit start → set/re-type the whole unit; strip exactly the cue text (never the following content).
    const blockPos = $start.before();
    return state.tr.delete(start, end).setNodeAttribute(blockPos, 'unitType', type);
  }

  // preceded by a leaf → only a hard_break is a line start; an atom (math/reference) is mid-line → no cue.
  const lead = $start.nodeAfter;
  if (!lead || lead.type.name !== 'hard_break') return null;
  const tr = state.tr.delete(start, end); // remove the break + the cue text, rejoining at `start`
  tr.split(start, 1, [{ type: proseType, attrs: { unitId: null, unitType: type } }]);
  const $after = tr.doc.resolve(tr.mapping.map(start, 1));
  return tr.setSelection(Selection.near($after, 1));
}

/** The cue rule, exported so the editor can compose it with other input rules into ONE `inputRules`
 *  plugin — ProseMirror invokes `handleTextInput` on only one inputRules plugin, so all rules must share. */
export const cueRule = new InputRule(CUE_RE, applyCue);
export const typeCueInputRules = inputRules({ rules: [cueRule] });

// ── within-block line scan (lines = runs of inline content separated by hard_breaks) ──
type LineScan = { curEmpty: boolean; prevEmpty: boolean };

function scanLines($cursor: ResolvedPos): LineScan {
  const block = $cursor.parent;
  const at = $cursor.parentOffset; // content-offset of the cursor within the block
  let lineStart = 0; // content-offset where the line being accumulated starts
  let acc = 0; // running content-offset
  let curLen = 0; // length of the line being accumulated
  let prevLen = -1; // length of the previously-completed line (-1 = none yet)
  let foundCur: number | null = null; // length of the cursor's line, once located
  let foundPrev = -1; // length of the line before the cursor's line
  block.forEach((child) => {
    if (child.type.name === 'hard_break') {
      // the line [lineStart, acc] ends at this break; the cursor is in it if at ∈ [lineStart, acc]
      if (foundCur === null && at >= lineStart && at <= acc) {
        foundCur = curLen;
        foundPrev = prevLen;
      }
      prevLen = curLen;
      curLen = 0;
      lineStart = acc + child.nodeSize;
    } else {
      curLen += child.nodeSize;
    }
    acc += child.nodeSize;
  });
  if (foundCur === null) {
    foundCur = curLen; // the cursor is on the final line
    foundPrev = prevLen;
  }
  return { curEmpty: foundCur === 0, prevEmpty: foundPrev === 0 };
}

/** Split the current block at the cursor into a NEW unit with `attrs`, after stripping the run of
 *  consecutive `hard_break`s immediately before the cursor (so neither unit keeps a dangling blank). The
 *  FIRST block keeps its original attrs (incl. `unitId`); the new SECOND block gets `attrs`. */
function splitInto(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  attrs: { unitId: null; unitType: UnitType | null },
): void {
  const head = state.selection.$head.pos;
  let stripFrom = head;
  for (;;) {
    const before = state.doc.resolve(stripFrom).nodeBefore;
    if (before && before.type.name === 'hard_break') stripFrom -= before.nodeSize;
    else break;
  }
  const tr = state.tr;
  if (head > stripFrom) tr.delete(stripFrom, head);
  tr.split(stripFrom, 1, [{ type: proseType, attrs }]);
  const $after = tr.doc.resolve(tr.mapping.map(stripFrom, 1));
  dispatch(tr.setSelection(Selection.near($after, 1)).scrollIntoView());
}

/** Enter — the paragraph model, uniform on a non-empty line, divergent on an empty line:
 *  - non-empty line → a soft line break, stay (plain AND typed);
 *  - empty line, PLAIN unit → a new plain unit (paragraph = unit);
 *  - empty line, TYPED unit, previous line non-empty → a paragraph break, STAY (multi-paragraph);
 *  - empty line, TYPED unit, previous line empty (2nd consecutive blank) → EXIT to a new plain unit. */
export const enterParagraph: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor) {
    // a range selection: replace it with a soft break (never a split — no duplicate-id path)
    if (dispatch)
      dispatch(state.tr.deleteSelection().replaceSelectionWith(hardBreak()).scrollIntoView());
    return true;
  }
  if ($cursor.parent.type.name !== 'prose') return false;
  const typed = $cursor.parent.attrs.unitType != null;
  const { curEmpty, prevEmpty } = scanLines($cursor);
  if (!curEmpty || (typed && !prevEmpty)) {
    // soft line break (plain/typed non-empty line) OR a typed paragraph break (single blank) → stay
    if (dispatch) dispatch(state.tr.replaceSelectionWith(hardBreak()).scrollIntoView());
    return true;
  }
  // plain empty line → new unit; typed 2nd-consecutive-blank → exit. Both → a new PLAIN unit.
  if (dispatch) splitInto(state, dispatch, { unitId: null, unitType: null });
  return true;
};

/** Enter inside a DISPLAY equation (`$$…$$`, possibly multi-line): a newline (`hard_break`) STAYS in the
 *  equation — even on a blank line — so its source can span multiple lines until the closing `$$`. The ONLY exit
 *  is Enter at the very END of a CLOSED `$$…$$`, which opens a new plain unit BELOW the (still-rendered)
 *  equation. Returns false for a non-display block → the normal paragraph Enter runs. Chained BEFORE
 *  `enterParagraph` so display blocks pre-empt the soft-break/split paragraph model. */
export const displayEnter: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  const block = $cursor.parent;
  // The block's source with `\n` per hard_break (a display equation may be multi-line).
  let src = '';
  let clean = true;
  block.forEach((child) => {
    if (child.isText) src += child.text ?? '';
    else if (child.type.name === 'hard_break') src += '\n';
    else clean = false; // a reference/atom → not a clean display block
  });
  if (!clean || !src.startsWith('$$')) return false;
  const closed = wholeDisplaySource(src) != null; // whole block is `$$…$$` (multi-line + trailing-ws tolerant)
  const open = !src.slice(2).includes('$$'); // no closing `$$` yet → still authoring
  if (!closed && !open) return false; // e.g. `$$a$$ trailing` — not a clean display block → normal Enter
  if (dispatch) {
    if (closed && $cursor.parentOffset === block.content.size) {
      // EXIT: a new plain unit below; the equation stays closed + rendered.
      const tr = state.tr;
      tr.split($cursor.pos, 1, [{ type: proseType, attrs: { unitId: null, unitType: null } }]);
      const $after = tr.doc.resolve(tr.mapping.map($cursor.pos, 1));
      dispatch(tr.setSelection(Selection.near($after, 1)).scrollIntoView());
    } else {
      // STAY: a newline within the equation source (multi-line authoring/editing).
      dispatch(state.tr.replaceSelectionWith(hardBreak()).scrollIntoView());
    }
  }
  return true;
};

/** A whole-block CLOSED display equation `$$…$$` (possibly multi-line). Joining another block into it — or it
 *  into another — would break the `$$…$$` form and DESTROY the rendered, identity-bearing equation (demote it to
 *  literal text + delete/recreate its Math unit), so the Backspace/Delete chains REFUSE such a join (the
 *  equation behaves atomically for block joins). */
function isDisplayBlock(block: import('prosemirror-model').Node): boolean {
  if (block.type.name !== 'prose') return false;
  let src = '';
  let clean = true;
  block.forEach((c) => {
    if (c.isText) src += c.text ?? '';
    else if (c.type.name === 'hard_break') src += '\n';
    else clean = false;
  });
  return clean && wholeDisplaySource(src) != null; // a complete `$$…$$` (multi-line + trailing-ws tolerant)
}

/** Backspace at a block START, when a join would dissolve a display equation (the current block IS one, or the
 *  previous sibling is): refuse the join, but instead of a DEAD KEY, MOVE the caret to the end of the previous
 *  block — into the equation's source when that's the equation (revealing it), or up out of the equation
 *  otherwise. Non-destructive, with clear feedback; a deliberate delete is still a selection-then-delete or
 *  editing the source. Returns false for a normal (non-equation) merge → the usual Backspace chain. */
export const guardDisplayMerge: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose' || $cursor.parentOffset !== 0) return false;
  const before = $cursor.before();
  const prev = state.doc.resolve(before).nodeBefore;
  if (!isDisplayBlock($cursor.parent) && !(prev && isDisplayBlock(prev))) return false;
  if (dispatch && prev) {
    // end of the previous block's content (= `before - 1`, just inside its close token)
    dispatch(
      state.tr.setSelection(Selection.near(state.doc.resolve(before - 1), -1)).scrollIntoView(),
    );
  }
  return true; // handled (swallowed at the first block, where there is nothing above to move to)
};

/** Delete at a block END: the forward mirror of `guardDisplayMerge` — refuse a join that would dissolve a
 *  display equation (this block, or the next sibling), moving the caret to the start of the next block instead. */
export const guardDisplayMergeForward: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if ($cursor.parentOffset !== $cursor.parent.content.size) return false;
  const after = $cursor.after();
  const next = state.doc.resolve(after).nodeAfter;
  if (!isDisplayBlock($cursor.parent) && !(next && isDisplayBlock(next))) return false;
  if (dispatch && next) {
    dispatch(
      state.tr.setSelection(Selection.near(state.doc.resolve(after + 1), 1)).scrollIntoView(),
    );
  }
  return true;
};

/** ⌘/Ctrl+Enter — finish the current unit and start a new plain one, splitting at the cursor (content after
 *  the cursor moves down; at the end it's an empty new unit). The deliberate exit from a typed unit. */
export const exitTypedUnit: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if (dispatch) {
    const tr = state.tr;
    tr.split($cursor.pos, 1, [{ type: proseType, attrs: { unitId: null, unitType: null } }]);
    const $after = tr.doc.resolve(tr.mapping.map($cursor.pos, 1));
    dispatch(tr.setSelection(Selection.near($after, 1)).scrollIntoView());
  }
  return true;
};

/** Shift-Enter: ALWAYS a soft line break, never a split/exit (even on an empty line). (Inline math is editable
 *  `$…$` text now, not a node — a soft break inside it simply breaks the region back to raw text, like any
 *  other edit; there is no special math-mode case here.) */
export const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(hardBreak()).scrollIntoView());
  return true;
};

/** Backspace at the very start of a TYPED unit clears its type back to plain (the reversibility "peel" — a
 *  typed unit never merges in one press, so it can't silently dissolve into a neighbour). Returns false
 *  otherwise. NEVER deletes text. */
export const clearTypeAtStart: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if ($cursor.parentOffset !== 0 || $cursor.parent.attrs.unitType == null) return false;
  if (dispatch) dispatch(state.tr.setNodeAttribute($cursor.before(), 'unitType', null));
  return true;
};

/** Backspace at the very start of a PLAIN unit merges it into the previous unit with a SOFT line break (a
 *  "soft-break join" — the result is a unit you could have typed, never a jammed-together paragraph). The
 *  PREVIOUS unit's id survives; the absorbed unit drops out (a `deletes` on flush). Returns false at the
 *  first unit, in a typed unit (clearTypeAtStart peels first), or when the previous sibling isn't prose. */
export const mergeIntoPrevious: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if ($cursor.parentOffset !== 0 || $cursor.parent.attrs.unitType != null) return false;
  const bPos = $cursor.before(); // boundary just before this block (= previous block's end)
  const prev = state.doc.resolve(bPos).nodeBefore;
  if (!prev || prev.type.name !== 'prose') return false;
  if (dispatch) {
    const tr = state.tr;
    const prevEmpty = prev.content.size === 0;
    const aEnd = bPos - 1; // inside the previous block, before its close token
    if (!prevEmpty) tr.insert(aEnd, hardBreak()); // soft break at the junction (skip if prev is empty)
    tr.join(prevEmpty ? bPos : bPos + 1); // boundary shifts by the inserted break
    const caret = prevEmpty ? aEnd : aEnd + 1; // land after the previous content (and the break)
    dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView());
  }
  return true;
};
