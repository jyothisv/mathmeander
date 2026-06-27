// Paste re-segmentation (paste.ts). Locks: a pasted string with blank-line paragraphs, `# ` headings, and
// `$$…$$` runs (incl. a multi-line system) segments into the right blocks; a multi-block (same-app) paste
// round-trips to N closed blocks with stripped ids; a plain single-block paste is returned UNCHANGED so
// default inline merging is preserved; after idStamper + the recognizers, the blocks gain fresh ids + the
// heading/display identity (re-derived from the KEPT source text).
import { describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import {
  blocksFromText,
  transformPastedSlice,
  guardAtomicPaste,
  guardAtomicDrop,
} from './paste';
import { idStamper } from './idStamper';
import { headingRecognize } from './headingRecognize';
import { mathRecognize } from './mathRecognize';

const proseBlock = (text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create({ unitId: null, ...attrs }, text ? editorSchema.text(text) : undefined);

/** A block's source with `\n` per hard_break (text nodes drop breaks in `textContent`). */
const blockSrc = (block: Node): string => {
  let s = '';
  block.forEach((c) => {
    if (c.isText) s += c.text ?? '';
    else if (c.type.name === 'hard_break') s += '\n';
  });
  return s;
};

describe('blocksFromText — segment a pasted string into prose blocks', () => {
  it('splits paragraphs, headings, and $$…$$ runs (incl. a multi-line system) into the right blocks', () => {
    const blocks = blocksFromText('intro\n\n# H\n\nbody\n$$a+b$$\n\n$$x\ny$$');
    expect(blocks.map(blockSrc)).toEqual(['intro', '# H', 'body', '$$a+b$$', '$$x\ny$$']);
  });

  it('keeps soft-lines (single newlines) inside one paragraph block', () => {
    const blocks = blocksFromText('one\ntwo\nthree');
    expect(blocks).toHaveLength(1);
    expect(blockSrc(blocks[0]!)).toBe('one\ntwo\nthree');
  });

  it('an unterminated `$$` is ordinary paragraph text (no run)', () => {
    const blocks = blocksFromText('$$ not closed');
    expect(blocks).toHaveLength(1);
    expect(blockSrc(blocks[0]!)).toBe('$$ not closed');
  });
});

describe('transformPastedSlice', () => {
  it('re-segments a MULTI-BLOCK same-app paste into N closed blocks with stripped ids', () => {
    const slice = new Slice(
      Fragment.from([proseBlock('alpha', { unitId: 'a' }), proseBlock('beta', { unitId: 'b' })]),
      0,
      0,
    );
    const out = transformPastedSlice(slice);
    expect(out.openStart).toBe(0);
    expect(out.openEnd).toBe(0);
    expect(out.content.childCount).toBe(2);
    out.content.forEach((b) => expect(b.attrs.unitId).toBeNull()); // ids stripped (idStamper re-mints)
    expect(blockSrc(out.content.child(0))).toBe('alpha');
    expect(blockSrc(out.content.child(1))).toBe('beta');
  });

  it('blockifies a single `# H` inline paste into a (closed) heading block', () => {
    const slice = new Slice(Fragment.from([editorSchema.text('# H')]), 0, 0);
    const out = transformPastedSlice(slice);
    expect(out.content.childCount).toBe(1);
    expect(out.openStart).toBe(0);
    expect(blockSrc(out.content.child(0))).toBe('# H');
  });

  it('leaves a plain single-block paste UNCHANGED (default inline merge is preserved)', () => {
    const slice = new Slice(Fragment.from([proseBlock('just a word')]), 0, 0);
    expect(transformPastedSlice(slice)).toBe(slice); // same reference → no blockify
  });

  it('end-to-end: after idStamper + recognizers the pasted blocks gain ids + heading/display identity', () => {
    const out = transformPastedSlice(new Slice(Fragment.from(blocksFromText('# H\n\n$$x$$')), 0, 0));
    const doc = editorSchema.nodes.doc.create(null, out.content);
    let state = EditorState.create({
      schema: editorSchema,
      doc,
      plugins: [idStamper, headingRecognize, mathRecognize],
    });
    state = state.apply(state.tr); // run the appendTransaction plugins once

    const heading = state.doc.child(0);
    expect(heading.attrs.heading).toBe(true);
    expect(heading.attrs.unitId).not.toBeNull(); // idStamper minted a fresh id

    const eq = state.doc.child(1);
    const mark = eq.firstChild!.marks.find((m) => m.type.name === 'mathExpr');
    expect(mark?.attrs.display).toBe(true);
    expect(eq.attrs.unitId).not.toBeNull();
    // distinct fresh ids (copy-mints-fresh / no aliasing)
    expect(heading.attrs.unitId).not.toBe(eq.attrs.unitId);
  });
});

// A closed (block-level) slice — exactly what transformPastedSlice produces for a construct paste.
const closed = (text: string): Slice => new Slice(Fragment.from(blocksFromText(text)), 0, 0);

/** A doc state with the recognizer plugins; the caret is placed at `[i, o]` (block index, content offset).
 *  `attrsByBlock` maps each block index to its attrs; each block's text comes from `texts`. */
function docState(
  texts: string[],
  attrsByBlock: Record<number, Record<string, unknown>>,
  i: number,
  o: number,
): EditorState {
  const blocks = texts.map((t, idx) =>
    editorSchema.nodes.prose.create(
      { unitId: `u${idx}`, ...(attrsByBlock[idx] ?? {}) },
      t ? editorSchema.text(t) : undefined,
    ),
  );
  const doc = editorSchema.nodes.doc.create(null, blocks);
  const base = EditorState.create({
    schema: editorSchema,
    doc,
    plugins: [idStamper, headingRecognize, mathRecognize],
  });
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos + 1 + o)));
}

/** Apply the guard; return the resulting blocks (text + heading + unitId) and whether it fired. */
function applyGuard(state: EditorState, slice: Slice) {
  const tr = guardAtomicPaste(state, slice);
  if (!tr) return { fired: false, blocks: [] as { text: string; heading: boolean }[] };
  const next = state.apply(tr);
  const blocks: { text: string; heading: boolean; unitId: string | null }[] = [];
  next.doc.forEach((b) =>
    blocks.push({
      text: b.textContent,
      heading: (b.attrs.heading as boolean) ?? false,
      unitId: b.attrs.unitId as string | null,
    }),
  );
  return { fired: true, blocks };
}

describe('guardAtomicPaste — a block-level paste never splits a heading / equation', () => {
  it('THE FIX: pasting `# Src` at the trapped offset 2 of `# Title2` does NOT split or demote it', () => {
    // caret at offset 2 (after the hidden "# " prefix) — the exact corruption trigger, next block a heading.
    const s = docState(['# Title2', '# Next'], { 0: { heading: true }, 1: { heading: true } }, 0, 2);
    const { fired, blocks } = applyGuard(s, closed('# Src'));
    expect(fired).toBe(true);
    // boundary insert AFTER the heading — no stray "# " empty heading, Title2 INTACT (still a heading), order kept
    expect(blocks.map((b) => ({ text: b.text, heading: b.heading }))).toEqual([
      { text: '# Title2', heading: true },
      { text: '# Src', heading: true },
      { text: '# Next', heading: true },
    ]);
  });

  it('a genuine offset-0 caret inserts BEFORE the heading', () => {
    const s = docState(['# Title2'], { 0: { heading: true } }, 0, 0);
    const { blocks } = applyGuard(s, closed('# Src'));
    expect(blocks.map((b) => b.text)).toEqual(['# Src', '# Title2']);
  });

  it('guards a whole-block `$$x$$` equation the same way (paste lands after, equation survives)', () => {
    const s = docState(['$$x$$'], {}, 0, 2); // caret mid-source
    const { fired, blocks } = applyGuard(s, closed('# Src'));
    expect(fired).toBe(true);
    expect(blocks.map((b) => b.text)).toEqual(['$$x$$', '# Src']);
  });

  it('a multi-block paste into a heading lands ALL blocks after it, in order', () => {
    const s = docState(['# Title2'], { 0: { heading: true } }, 0, 2);
    const { blocks } = applyGuard(s, closed('one\n\ntwo\n\n# Three'));
    expect(blocks.map((b) => b.text)).toEqual(['# Title2', 'one', 'two', '# Three']);
  });

  it('a PARTIAL range inside the title is NOT deleted (deleting would sever the prefix) — paste lands after', () => {
    const block = editorSchema.nodes.prose.create({ unitId: 'h', heading: true }, [
      editorSchema.text('# Title2'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({
      schema: editorSchema,
      doc,
      plugins: [idStamper, headingRecognize],
    });
    // select "Ti" (content offsets 2..4 → doc pos 3..5) — a partial selection
    const s = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 3, 5)));
    const next = s.apply(guardAtomicPaste(s, closed('# Src'))!);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).attrs.heading).toBe(true); // heading intact
    expect(next.doc.child(0).textContent).toBe('# Title2'); // content untouched (prefix safe → no demote)
    expect(next.doc.child(1).textContent).toBe('# Src');
  });

  it('a WHOLE-content selection defers to the default (a clean block REPLACE, no split)', () => {
    const block = editorSchema.nodes.prose.create({ unitId: 'h', heading: true }, [
      editorSchema.text('# Title2'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc, plugins: [headingRecognize] });
    // select the whole content (offsets 0..8 → doc 1..9)
    const s = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 9)));
    expect(guardAtomicPaste(s, closed('# Src'))).toBeNull(); // guard defers
    const replaced = s.apply(s.tr.replaceSelection(closed('# Src'))); // the default cleanly replaces
    expect(replaced.doc.childCount).toBe(1);
    expect(replaced.doc.child(0).textContent).toBe('# Src');
    expect(replaced.doc.child(0).attrs.heading).toBe(true);
  });

  it('returns null (defers to the default split) for a PLAIN paragraph target', () => {
    const s = docState(['plain text'], {}, 0, 3);
    expect(guardAtomicPaste(s, closed('# Src'))).toBeNull();
  });

  it('returns null for an INLINE paste (openStart ≥ 1) into a heading (it merges into the title)', () => {
    const s = docState(['# Title2'], { 0: { heading: true } }, 0, 2);
    const open = new Slice(closed('para').content, 1, 1); // an open (inline) slice
    expect(guardAtomicPaste(s, open)).toBeNull();
  });

  it('returns null when the selection escapes the atomic block (let the default handle it)', () => {
    const s = docState(['# Title2', 'body'], { 0: { heading: true } }, 0, 2);
    const escaped = s.apply(
      s.tr.setSelection(TextSelection.create(s.doc, s.selection.from, s.doc.content.size - 1)),
    );
    expect(guardAtomicPaste(escaped, closed('# Src'))).toBeNull();
  });
});

describe('guardAtomicDrop — drag-drop into an atomic block uses the same boundary redirect', () => {
  it('an external drop of `# Src` inside a heading lands after it (no split)', () => {
    const s = docState(['# Title2'], { 0: { heading: true } }, 0, 0);
    const dropPos = 3; // mid-title (offset 2)
    const next = s.apply(guardAtomicDrop(s, closed('# Src'), dropPos, false)!);
    const texts: string[] = [];
    next.doc.forEach((b) => texts.push(b.textContent));
    expect(texts).toEqual(['# Title2', '# Src']);
  });

  it('an internal MOVE deletes the dragged source block and lands the blocks after the heading', () => {
    const src = editorSchema.nodes.prose.create({ unitId: 's' }, [editorSchema.text('dragme')]);
    const head = editorSchema.nodes.prose.create({ unitId: 'h', heading: true }, [
      editorSchema.text('# Title2'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [src, head]);
    const base = EditorState.create({
      schema: editorSchema,
      doc,
      plugins: [idStamper, headingRecognize],
    });
    const dropPos = src.nodeSize + 1 + 2; // mid-title of the heading
    // a whole-block drag = a NodeSelection of the source block (so the move removes it cleanly)
    const s = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, 0)));
    const next = s.apply(guardAtomicDrop(s, closed('# Src'), dropPos, true)!);
    const texts: string[] = [];
    next.doc.forEach((b) => texts.push(b.textContent));
    expect(texts).toEqual(['# Title2', '# Src']); // source removed, paste after the heading, heading intact
  });

  it('returns null for a drop into a PLAIN block (default split is fine) and for an inline drop', () => {
    const s = docState(['plain'], {}, 0, 0);
    expect(guardAtomicDrop(s, closed('# Src'), 3, false)).toBeNull();
    const h = docState(['# Title2'], { 0: { heading: true } }, 0, 0);
    expect(guardAtomicDrop(h, new Slice(closed('para').content, 1, 1), 3, false)).toBeNull();
  });

  it('a MOVE whose drop point is INSIDE the dragged source block does not crash or corrupt', () => {
    // drag the heading and drop within its own content: the move-delete removes the source, the drop point
    // re-maps through that deletion, and the fallback insert lands the blocks cleanly (no empty atomic shell).
    const head = editorSchema.nodes.prose.create({ unitId: 'h', heading: true }, [
      editorSchema.text('# Title'),
    ]);
    const body = editorSchema.nodes.prose.create({ unitId: 'b' }, [editorSchema.text('body')]);
    const doc = editorSchema.nodes.doc.create(null, [head, body]);
    const base = EditorState.create({
      schema: editorSchema,
      doc,
      plugins: [idStamper, headingRecognize],
    });
    const s = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, 0))); // drag the heading
    const next = s.apply(guardAtomicDrop(s, closed('# Title'), 3, true)!); // drop at offset 2 inside it
    const texts: string[] = [];
    next.doc.forEach((b) => texts.push(b.textContent));
    expect(texts).toEqual(['# Title', 'body']); // heading effectively stays put; body intact; no empty block
  });
});

describe('heading-prefix on paste — normalize the SEPARATOR, preserve the title (round-trips with flush)', () => {
  it('normalizes a tab/odd separator to a single space but PRESERVES the title verbatim', () => {
    expect(blocksFromText('##\tSub').map(blockSrc)).toEqual(['## Sub']); // tab separator → one space
    expect(blocksFromText('# Title').map(blockSrc)).toEqual(['# Title']); // single space unchanged
  });
  it('does NOT eat a legitimate leading title space (the flush strips exactly one separator) — m1', () => {
    // `#  x` = title ` x` (one separator + a space-prefixed title); paste must keep the space so it
    // round-trips with the flush (which strips exactly one `\s`). Over-stripping the run was the m1 bug.
    expect(blocksFromText('#  x').map(blockSrc)).toEqual(['#  x']);
    expect(blocksFromText('#   Title').map(blockSrc)).toEqual(['#   Title']); // title `  Title` preserved
  });
});
