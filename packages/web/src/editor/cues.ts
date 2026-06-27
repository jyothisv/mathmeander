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
import type { Node, ResolvedPos } from 'prosemirror-model';
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
  // The new typed unit stays in the current block's section (inherit `parentId`; §B).
  const parentId = ($start.parent.attrs.parentId as string | null) ?? null;
  tr.split(start, 1, [{ type: proseType, attrs: { unitId: null, unitType: type, parentId } }]);
  const $after = tr.doc.resolve(tr.mapping.map(start, 1));
  return tr.setSelection(Selection.near($after, 1));
}

/** The cue rule, exported so the editor can compose it with other input rules into ONE `inputRules`
 *  plugin — ProseMirror invokes `handleTextInput` on only one inputRules plugin, so all rules must share. */
export const cueRule = new InputRule(CUE_RE, applyCue);
export const typeCueInputRules = inputRules({ rules: [cueRule] });

// ── §B section headings (the `# ` promote cue + flowing/dissolve gestures) ──

/** Index every block by its `unitId` (for `parentId`-chain walks). */
export function headingIndex(doc: Node): Map<string, Node> {
  const m = new Map<string, Node>();
  doc.forEach((b) => {
    const id = b.attrs.unitId as string | null;
    if (id) m.set(id, b);
  });
  return m;
}

/** A heading block's depth = 1 + the depth of its enclosing-heading chain (a top-level heading = 1). */
export function headingDepthOf(block: Node, byId: Map<string, Node>): number {
  let depth = 1;
  let pid = block.attrs.parentId as string | null;
  const guard = new Set<string>(); // a malformed cycle can't hang the walk
  while (pid && !guard.has(pid)) {
    guard.add(pid);
    const p = byId.get(pid);
    if (!p || !(p.attrs.heading as boolean)) break;
    depth += 1;
    pid = p.attrs.parentId as string | null;
  }
  return depth;
}

/** The `parentId` a NEW heading at `targetDepth` (the `#` count) should take, given its block index. Find
 *  the nearest PRECEDING heading: if it is shallower (`d < targetDepth`) the new heading is ITS child
 *  (clamped to `d+1` — levels can't be skipped, §13a Stage-3 rule); if it is `≥ targetDepth`, climb its
 *  ancestor chain to the heading at `targetDepth-1`. No preceding heading or depth 1 → top-level (`null`). */
export function parentForHeadingDepth(
  doc: Node,
  blockIndex: number,
  targetDepth: number,
): string | null {
  if (targetDepth <= 1) return null;
  const byId = headingIndex(doc);
  for (let i = blockIndex - 1; i >= 0; i -= 1) {
    const b = doc.child(i);
    if (!(b.attrs.heading as boolean)) continue;
    const d = headingDepthOf(b, byId);
    if (d < targetDepth) return (b.attrs.unitId as string | null) ?? null; // child of the shallower heading
    // d ≥ targetDepth: climb b's chain to the ancestor at depth targetDepth-1.
    let anc: Node | null = b;
    let ad = d;
    while (anc && ad > targetDepth - 1) {
      const pid = anc.attrs.parentId as string | null;
      anc = pid ? (byId.get(pid) ?? null) : null;
      ad -= 1;
    }
    return anc ? ((anc.attrs.unitId as string | null) ?? null) : null;
  }
  return null; // no preceding heading → top-level
}

// ── recognize headings (`# `) & display math (`$$…$$`) on ANY line, not just a block's first ──
//
// Headings, display math, and systems are PHYSICALLY whole-block (1 block = 1 unit; the recognizers,
// projection, idStamper all scan a WHOLE block). So `# `/`$$…$$` only "work" as a block's first line. To
// make them work on a SOFT-LINE (or block-start with trailing content) without reworking every consumer,
// we SPLIT the offending line into its OWN block at insertion time (typing → these input rules; paste →
// transformPasted). Downstream then sees a whole-block heading/display and works unchanged. The hashes/
// dollars are KEPT (Obsidian model); `headingRecognize`/`mathRecognize` reconcile identity afterward.

/** Isolate the line containing `pos` as its OWN prose block — peeling any preceding line (head) into the
 *  block before it AND any following line (tail) into the block after it (the two-way split that stops a
 *  heading title from absorbing the rest). The peeled head keeps the ORIGINAL block's id; the isolated
 *  line keeps it only when it was already block-start (no head). New blocks inherit the block's `parentId`/
 *  `unitType` and take a null id (idStamper mints); `heading` defaults false (the recognizer promotes).
 *  Returns false (no change) when the line is already the whole block — the caller then needs no split. */
export function splitLineOut(tr: Transaction, pos: number): boolean {
  const $pos = tr.doc.resolve(pos);
  if ($pos.parent.type.name !== 'prose') return false;
  const block = $pos.parent;
  const cStart = $pos.start();
  let headBreak = -1; // doc pos of the hard_break ending the PREVIOUS line (last break before `pos`)
  let tailBreak = -1; // doc pos of the hard_break ending THIS line (first break at/after `pos`)
  let p = cStart;
  block.forEach((child) => {
    if (child.type.name === 'hard_break') {
      if (p < pos) headBreak = p;
      else if (tailBreak < 0) tailBreak = p;
    }
    p += child.nodeSize;
  });
  if (headBreak < 0 && tailBreak < 0) return false; // the line IS the whole block — nothing to peel

  const parentId = (block.attrs.parentId as string | null) ?? null;
  const unitType = (block.attrs.unitType as UnitType | null) ?? null;
  const fresh = () => ({ type: proseType, attrs: { unitId: null, unitType, parentId } });
  // Tail first (higher positions stay valid while we then touch the lower head positions). Strip the
  // separating break so neither side keeps a dangling soft-line.
  if (tailBreak >= 0) {
    tr.delete(tailBreak, tailBreak + 1);
    tr.split(tailBreak, 1, [fresh()]);
  }
  if (headBreak >= 0) {
    tr.delete(headBreak, headBreak + 1);
    tr.split(headBreak, 1, [fresh()]);
  }
  return true;
}

/** A `#`×n + space heading on ANY line. At a block start with no trailing content → null (the default
 *  insertion runs; `headingRecognize` promotes the whole block, as it always has). Otherwise KEEP the
 *  `# ` (insert the trigger space — Obsidian model) and split the line into its own block; the recognizer
 *  promotes it. A typed unit's leading `#` is literal (no fire). Exported for unit tests. */
export function applyHeadingCue(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const $start = state.doc.resolve(start);
  if ($start.parent.type.name !== 'prose') return null;
  if ($start.parent.attrs.unitType != null) return null; // a typed unit → the `#` is literal text
  const softLine = match[0].charCodeAt(0) === 0xfffc;
  if (softLine) {
    if ($start.nodeAfter?.type.name !== 'hard_break') return null; // a leaf atom, not a line start
  } else if ($start.parentOffset !== 0) {
    return null; // `^` matched mid-block (a >MAX_MATCH-char line) → not a line start
  }
  const tr = state.tr.insertText(' ', end); // keep the `# ` prefix (hidden/dimmed by headingLivePreview)
  const caret = end + 1; // just after the inserted space
  const base = tr.mapping.maps.length;
  splitLineOut(tr, caret);
  return tr
    .setSelection(TextSelection.create(tr.doc, tr.mapping.slice(base).map(caret)))
    .scrollIntoView();
}

export const HEADING_CUE_RE = /(?:^|￼)(#+) $/;
export const headingCueRule = new InputRule(HEADING_CUE_RE, applyHeadingCue);

/** A whole-line `$$…$$` (display math / a system) on ANY line. Fires on the closing `$$` (the second
 *  `$` is the trigger). At a block start with no trailing content → null (the default insertion runs;
 *  `mathRecognize` marks the whole block display). Otherwise insert the closing `$` and split the
 *  `$$…$$` onto its own block; the whole-block display flow then applies unchanged. A typed unit (the
 *  `$$` is literal) and an empty/whitespace inner (`$$$$`) do not fire. Exported for unit tests. */
export function applyDisplayCue(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  if (!match[1] || match[1].trim() === '') return null; // `$$$$` / whitespace-only inner → not display
  const $start = state.doc.resolve(start);
  if ($start.parent.type.name !== 'prose') return null;
  if ($start.parent.attrs.unitType != null) return null; // a typed unit → the `$$` is literal text
  if ($start.parent.attrs.heading) return null; // a heading title → `$$` stays literal (no display)
  const softLine = match[0].charCodeAt(0) === 0xfffc;
  if (softLine) {
    if ($start.nodeAfter?.type.name !== 'hard_break') return null;
  } else if ($start.parentOffset !== 0) {
    return null;
  }
  const tr = state.tr.insertText('$', end); // complete the closing `$$`
  const caret = end + 1;
  const base = tr.mapping.maps.length;
  splitLineOut(tr, caret);
  // Land the caret at the END of the (now isolated) display block — ready to Enter past it.
  const lineEnd = tr.doc.resolve(tr.mapping.slice(base).map(caret)).end();
  return tr.setSelection(TextSelection.create(tr.doc, lineEnd)).scrollIntoView();
}

// The inner is `[^￼]+?` so the `$$…$$` stays on ONE line (a multi-line system authored from scratch
// closes per-line; PASTE carries multi-line systems whole — see paste.ts). Anchored at a line start.
export const DISPLAY_CUE_RE = /(?:^|￼)\$\$([^￼]+?)\$\$$/;
export const displayCueRule = new InputRule(DISPLAY_CUE_RE, applyDisplayCue);

/** Enter inside a section HEADING: a heading is a single-line title, so Enter (anywhere) does NOT soft-break
 *  — it splits off a new BODY unit that FLOWS UNDER the heading (`parentId` = the heading's id), the §B
 *  Option-A flow. Chained BEFORE `enterParagraph` so headings pre-empt the soft-break/paragraph model.
 *  Returns false for a non-heading block → the normal Enter chain runs. */
export const headingEnter: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  const block = $cursor.parent;
  if (!(block.attrs.heading as boolean)) return false;
  if (dispatch) {
    const parentId = (block.attrs.unitId as string | null) ?? null; // the body flows UNDER this heading
    const tr = state.tr;
    tr.split($cursor.pos, 1, [
      { type: proseType, attrs: { unitId: null, unitType: null, parentId } },
    ]);
    const $after = tr.doc.resolve(tr.mapping.map($cursor.pos, 1));
    dispatch(tr.setSelection(Selection.near($after, 1)).scrollIntoView());
  }
  return true;
};

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
  // §B: the new block stays in the CURRENT block's section (inherit its `parentId`) — a body split never
  // escapes to top-level. `heading` defaults false: a split is never a section title.
  const parentId = (state.selection.$head.parent.attrs.parentId as string | null) ?? null;
  let stripFrom = head;
  for (;;) {
    const before = state.doc.resolve(stripFrom).nodeBefore;
    if (before && before.type.name === 'hard_break') stripFrom -= before.nodeSize;
    else break;
  }
  const tr = state.tr;
  if (head > stripFrom) tr.delete(stripFrom, head);
  tr.split(stripFrom, 1, [{ type: proseType, attrs: { ...attrs, parentId } }]);
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
      // EXIT: a new plain unit below; the equation stays closed + rendered. Stays in the block's section.
      const tr = state.tr;
      const parentId = (block.attrs.parentId as string | null) ?? null;
      tr.split($cursor.pos, 1, [
        { type: proseType, attrs: { unitId: null, unitType: null, parentId } },
      ]);
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
export function isDisplayBlock(block: import('prosemirror-model').Node): boolean {
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

/** Delete at a block END: refuse a forward join that would merge a heading title with an adjacent block —
 *  a heading is ATOMIC for block joins (this block OR the next is a heading). The forward mirror of the
 *  backward heading guard in `mergeIntoPrevious`; without it `baseKeymap`'s `joinForward` would pull the next
 *  block up into the title (or the heading into a body), destroying the section — silently when folded.
 *  Lands the caret at the next block's start non-destructively; returns false (normal Delete) otherwise. */
export const guardHeadingMergeForward: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if ($cursor.parentOffset !== $cursor.parent.content.size) return false;
  const after = $cursor.after();
  const next = state.doc.resolve(after).nodeAfter;
  const curHeading = ($cursor.parent.attrs.heading as boolean) ?? false;
  const nextHeading =
    !!next && next.type.name === 'prose' && ((next.attrs.heading as boolean) ?? false);
  if (!curHeading && !nextHeading) return false;
  if (dispatch && next) {
    dispatch(
      state.tr.setSelection(Selection.near(state.doc.resolve(after + 1), 1)).scrollIntoView(),
    );
  }
  return true; // swallowed at the last block (nothing after to merge)
};

/** Backspace at a config (notation-home) boundary — the block is ATOMIC for joins, like a heading/display
 *  block. Two cases the default `joinBackward` would otherwise corrupt: (1) the caret at the START of a config
 *  block (joining it backward would merge its source up / destroy the home); (2) the caret at the START of a
 *  prose block whose PREVIOUS sibling is a config block (joining would absorb the prose text INTO the notation
 *  source — §2.2 loss, since config `content:'text*'` happily takes it). Swallow case 1; land the caret at the
 *  config's end for case 2 (non-destructive). Returns false otherwise (normal Backspace / mid-source delete). */
export const guardConfigMerge: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor) return false;
  if ($cursor.parent.type.name === 'config') {
    return $cursor.parentOffset === 0; // at start → swallow the join; mid-source → normal char delete
  }
  if ($cursor.parent.type.name !== 'prose' || $cursor.parentOffset !== 0) return false;
  const bPos = $cursor.before();
  const prev = state.doc.resolve(bPos).nodeBefore;
  if (!prev || prev.type.name !== 'config') return false;
  if (dispatch)
    dispatch(
      state.tr.setSelection(Selection.near(state.doc.resolve(bPos - 1), -1)).scrollIntoView(),
    );
  return true;
};

/** Delete at a config boundary — the forward mirror of `guardConfigMerge`. (1) the caret at the END of a
 *  config block (a forward join would pull the next block into the source); (2) the caret at the END of a
 *  prose block whose NEXT sibling is config (a forward join would merge the source up into the prose). Land
 *  the caret at the config's start for case 2; swallow case 1. Returns false otherwise (normal Delete). */
export const guardConfigMergeForward: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor) return false;
  if ($cursor.parent.type.name === 'config') {
    return $cursor.parentOffset === $cursor.parent.content.size;
  }
  if ($cursor.parent.type.name !== 'prose' || $cursor.parentOffset !== $cursor.parent.content.size)
    return false;
  const after = $cursor.after();
  const next = state.doc.resolve(after).nodeAfter;
  if (!next || next.type.name !== 'config') return false;
  if (dispatch)
    dispatch(
      state.tr.setSelection(Selection.near(state.doc.resolve(after + 1), 1)).scrollIntoView(),
    );
  return true;
};

/** ⌘/Ctrl+Enter — finish the current unit and start a new plain one, splitting at the cursor (content after
 *  the cursor moves down; at the end it's an empty new unit). The deliberate exit from a typed unit. */
export const exitTypedUnit: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
  if (dispatch) {
    const tr = state.tr;
    // The new plain unit stays in the current block's section (inherit `parentId`; §B).
    const parentId = ($cursor.parent.attrs.parentId as string | null) ?? null;
    tr.split($cursor.pos, 1, [
      { type: proseType, attrs: { unitId: null, unitType: null, parentId } },
    ]);
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
  // §B: a heading is ATOMIC for a backward block-join — never merge a section TITLE into the previous block
  // (offset 0 is reachable via Home, past the hidden `# ` prefix). Swallow: the caret stays at the title
  // start, no merge. (Demote first — delete the `#` — to then merge it as plain prose.)
  if ($cursor.parent.attrs.heading) return true;
  const bPos = $cursor.before(); // boundary just before this block (= previous block's end)
  const prev = state.doc.resolve(bPos).nodeBefore;
  if (!prev || prev.type.name !== 'prose') return false;
  // §B: never merge body text INTO a section TITLE (a heading owns its body as children, not as title text).
  // Like the display-block guard, refuse the join non-destructively — land the caret at the title's end.
  if (prev.attrs.heading) {
    if (dispatch)
      dispatch(
        state.tr.setSelection(Selection.near(state.doc.resolve(bPos - 1), -1)).scrollIntoView(),
      );
    return true;
  }
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
