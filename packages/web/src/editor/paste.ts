// Paste re-segmentation (slice 2c-3) — the paste-anywhere twin of the heading/display input rules. The
// constructs are PHYSICALLY whole-block, so a paste that lands `# heading`/`$$…$$` as inline text mid-block
// is never recognized, and a multi-block paste into the middle of a paragraph merges its first/last block
// into the target. `transformPastedSlice` re-segments the pasted content into clean, FULLY-CLOSED prose
// blocks: blank-line-separated paragraphs → blocks, each `# ` line → its own block, each `$$…$$` run (incl.
// a multi-line system) → one block. Attrs are stripped to defaults (null id, plain, no parent) — `idStamper`
// mints fresh ids (copy-mints-fresh, even for N pasted units) and the recognizers re-apply heading/math/mark
// identity from the KEPT source text (`#`, `$…$`, `**…**` all round-trip as literal text). A simple inline
// paste (a word, no constructs, one block) is returned UNCHANGED so it still merges inline as expected.
import { Fragment, Slice, type Node, type ResolvedPos } from 'prosemirror-model';
import { type EditorState, Selection, type Transaction } from 'prosemirror-state';
import { editorSchema } from './schema';
import { wholeDisplaySource } from './mathSyntax';
import { HEADING_PREFIX_RE, headingPrefix } from './headingSyntax';
import { isDisplayBlock } from './cues';

const proseType = editorSchema.nodes.prose;

/** The pasted slice as plain text: each top-level block separated by a BLANK line (so the segmenter starts
 *  a new unit), each within-block soft-line (`hard_break`) as a single `\n`, a `reference` atom as its text.
 *  Kept-source math (`$…$`/`$$…$$`) and marks (`**…**`) are already literal text, so they survive verbatim. */
function sliceText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n\n', (leaf) =>
    leaf.type.name === 'hard_break' ? '\n' : ((leaf.attrs.text as string | undefined) ?? ''),
  );
}

/** Text-node + hard_break nodes for a run of soft-lines (joined by `\n` ⇄ hard_breaks), the inline shape a
 *  prose block uses for a multi-line unit (projection.ts `inlineToNodes`). */
function inlineFromLines(lines: string[]): Node[] {
  const out: Node[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(editorSchema.nodes.hard_break.create());
    if (line.length > 0) out.push(editorSchema.text(line));
  });
  return out;
}

/** Segment `text` into prose blocks per the editor's paragraph + special-line model: a blank line ends the
 *  current paragraph; a `# ` line is its OWN block; a `$$…$$` RUN (one line, or multi-line until it closes)
 *  is one block; everything else accumulates into a paragraph (soft-lines joined by hard_breaks). */
export function blocksFromText(text: string): Node[] {
  const lines = text.split('\n');
  const blocks: Node[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    blocks.push(proseType.create({ unitId: null }, inlineFromLines(para)));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    if (/^\$\$/.test(line.trim())) {
      // A display run: accumulate lines until the `$$…$$` closes (a single-line `$$x$$`, or a multi-line
      // system). An unterminated `$$` falls through as ordinary paragraph text.
      const run: string[] = [];
      let j = i;
      let closed = false;
      for (; j < lines.length; j++) {
        run.push(lines[j]!);
        if (wholeDisplaySource(run.join('\n')) != null) {
          closed = true;
          break;
        }
      }
      if (closed) {
        flushPara();
        blocks.push(proseType.create({ unitId: null }, inlineFromLines(run)));
        i = j;
        continue;
      }
      // not closed → treat this line as normal text
    }
    const hm = HEADING_PREFIX_RE.exec(line);
    if (hm) {
      flushPara();
      // Normalize the SEPARATOR to the canonical `#`×depth + single space (so a tab/odd separator becomes a
      // space), but preserve the title VERBATIM after that one separator — matching the flush, which strips
      // exactly one `\s` (HEADING_PREFIX_RE). Stripping the whole whitespace run here would eat a legitimate
      // leading title space (`#  x` = title ` x`) and desync paste from the flush. `hm[0]` already consumed
      // the `#`s + one separator char, so `line.slice(hm[0].length)` is the title with its own spaces intact.
      const rest = line.slice(hm[0].length);
      blocks.push(
        proseType.create({ unitId: null }, [editorSchema.text(headingPrefix(hm[1]!.length) + rest)]),
      );
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/** True when a built block reads as a heading or a whole-block display equation — the constructs that MUST
 *  occupy their own block (so a paste of one, even into a paragraph, becomes a unit rather than inline text). */
function isConstructBlock(block: Node): boolean {
  let src = '';
  let clean = true;
  block.forEach((c) => {
    if (c.isText) src += c.text ?? '';
    else if (c.type.name === 'hard_break') src += '\n';
    else clean = false;
  });
  if (HEADING_PREFIX_RE.test(src)) return true;
  return clean && wholeDisplaySource(src) != null;
}

/** Re-segment a pasted slice (see module header). Returns a FULLY-CLOSED slice of prose blocks when the
 *  paste is block-level (multiple units, or a heading/display construct); returns the slice UNCHANGED for a
 *  plain single-block inline paste (a word) so default inline merging is preserved. */
export function transformPastedSlice(slice: Slice): Slice {
  const blocks = blocksFromText(sliceText(slice));
  if (blocks.length === 0) return slice; // nothing recoverable (e.g. only atoms) → leave default behaviour
  const blockLevel = blocks.length > 1 || blocks.some(isConstructBlock);
  if (!blockLevel) return slice; // a single plain paragraph → keep the default (inline-friendly) paste
  return new Slice(Fragment.from(blocks), 0, 0); // closed: pasted blocks split the target, never merge
}

/** A block that must NEVER be split by a block-level paste: a HEADING (its leading `#`×depth + space is
 *  display:none when the caret is away, so a click at the visual title-start resolves the caret PAST the
 *  prefix — a split there severs the prefix into a stray empty heading and DEMOTES the title to plain prose),
 *  or a whole-block `$$…$$` display / system (a split severs the delimiters and destroys the equation). The
 *  block reads identity off its WHOLE source, so any interior split corrupts it. */
function isAtomicBlock(block: Node): boolean {
  if (block.type.name !== 'prose') return false;
  return ((block.attrs.heading as boolean) ?? false) || isDisplayBlock(block);
}

/** Insert a CLOSED (block-level) slice at the BOUNDARY of the atomic block that `$inside` resolves into,
 *  WITHOUT touching the block's content — so its `#` prefix / `$$` delimiters are never severed (which would
 *  itself demote/dissolve it). Before the block only when `atStart`; otherwise after. Caret lands after the
 *  inserted blocks. */
function insertAtAtomicBoundary(
  tr: Transaction,
  $inside: ResolvedPos,
  atStart: boolean,
  slice: Slice,
): Transaction {
  const boundary = atStart ? $inside.before() : $inside.after();
  tr.insert(boundary, slice.content);
  const caret = Math.min(boundary + slice.content.size, tr.doc.content.size);
  return tr.setSelection(Selection.near(tr.doc.resolve(caret), 1)).scrollIntoView();
}

/** The paste guard (wired as `handlePaste` — runs AFTER `transformPasted`, BEFORE the default
 *  `replaceSelection`). A BLOCK-LEVEL paste (a closed slice — `openStart === 0`, the shape that SPLITS a
 *  textblock) with the caret/selection inside an atomic block would split it through the hidden prefix/source.
 *  Redirect the insertion to the block BOUNDARY instead — AFTER the block (the common case: the hidden-prefix
 *  trap resolves a "visual start" click to a mid-block offset), or BEFORE it only for a genuine offset-0
 *  caret. The block's content is NEVER touched (deleting it would sever the prefix → demote/dissolve), so a
 *  PARTIAL selection is not consumed — only the SPLIT is prevented. Returns null (let the default run) for:
 *  an inline paste (merges harmlessly into the title/source); a non-atomic target (a split there is intended);
 *  or a WHOLE-content selection (a clean block REPLACE — the default swaps the block, no split). This fixes
 *  the SPLIT at its source; the recognizer is correct given a well-formed doc — we never feed it a bad split. */
export function guardAtomicPaste(state: EditorState, slice: Slice): Transaction | null {
  if (slice.openStart !== 0) return null; // an inline paste merges into the title/source — safe, no split
  const { $from, $to, empty } = state.selection;
  const block = $from.parent;
  if (!isAtomicBlock(block)) return null; // a plain paragraph is fine to split (the intended paste)
  if ($to.parent !== block) return null; // the selection escapes the block → let the default handle
  // A selection covering the WHOLE content is a clean whole-block REPLACE (the default swaps the block, no
  // split — verified), so let it through; only a cursor / PARTIAL selection causes the destructive split.
  if (!empty && $from.parentOffset === 0 && $to.parentOffset === block.content.size) return null;
  return insertAtAtomicBoundary(state.tr, $from, empty && $from.parentOffset === 0, slice);
}

/** The drop guard (wired as `handleDrop` — drag-drop reuses the same closed-slice path as paste and is
 *  equally able to split an atomic block, since `handleDrop` is otherwise unwired). The target is the DROP
 *  POINT (not the selection). When a block-level slice lands inside an atomic block, redirect to the boundary.
 *  For an internal MOVE (`moved`) the default would also delete the dragged source — replicate by dropping the
 *  current selection first (then re-resolve the drop point through that deletion). Returns null to defer to
 *  the default (inline drop, or a non-atomic / non-prose target). */
export function guardAtomicDrop(
  state: EditorState,
  slice: Slice,
  dropPos: number,
  moved: boolean,
): Transaction | null {
  if (slice.openStart !== 0) return null;
  if (!isAtomicBlock(state.doc.resolve(dropPos).parent)) return null;
  const tr = state.tr;
  if (moved && !state.selection.empty) tr.deleteSelection(); // internal move → remove the dragged source
  const $at = tr.doc.resolve(Math.min(tr.mapping.map(dropPos), tr.doc.content.size));
  // After a possible move-delete the target may no longer be atomic; fall back to a plain insert there.
  if ($at.parent.type.name !== 'prose' || !isAtomicBlock($at.parent)) {
    tr.insert($at.pos, slice.content);
    const caret = Math.min($at.pos + slice.content.size, tr.doc.content.size);
    return tr.setSelection(Selection.near(tr.doc.resolve(caret), 1)).scrollIntoView();
  }
  return insertAtAtomicBoundary(tr, $at, $at.parentOffset === 0, slice);
}
