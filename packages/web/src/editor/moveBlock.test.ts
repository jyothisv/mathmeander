// moveBlock: Alt-↑/↓ reorders the block/section under the caret. A body block or an UNFOLDED heading moves
// as a single block; a FOLDED heading moves with its whole subtree. Pure doc reorder (positions/parentId are
// reconciled by the flush + headingResection downstream).
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import { moveBlock, movableItems, levelSiblingItems } from './moveBlock';
import { headingRecognize } from './headingRecognize';
import { headingResection } from './headingResection';
import { headingFold, foldPluginKey } from './headingFold';

const prose = (unitId: string, text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create(
    { unitId, ...attrs },
    text ? [editorSchema.text(text)] : undefined,
  );
const heading = (unitId: string, text: string): Node => prose(unitId, text, { heading: true });
const docOf = (...blocks: Node[]): Node => editorSchema.nodes.doc.create(null, blocks);
const texts = (doc: Node): string[] => {
  const t: string[] = [];
  doc.forEach((b) => t.push(b.textContent));
  return t;
};

/** A state with the caret at the start of top-level block `i`. */
function caretAt(doc: Node, i: number, plugins: readonly never[] = []): EditorState {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  const base = EditorState.create({ schema: editorSchema, doc, plugins: plugins as never });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos + 1)));
}
function run(s: EditorState, cmd: Command): EditorState {
  let next = s;
  cmd(s, (tr) => {
    next = s.apply(tr);
  });
  return next;
}

describe('movableItems — folding-aware grouping', () => {
  it('unfolded: each top-level block is its own item', () => {
    const doc = docOf(heading('h', '# A'), prose('b', 'body'), prose('c', 'more'));
    expect(movableItems(doc, new Set()).length).toBe(3);
  });

  it('a FOLDED heading groups its whole subtree into one item', () => {
    const doc = docOf(
      heading('h', '# A'),
      prose('b1', 'x', { parentId: 'h' }),
      prose('b2', 'y', { parentId: 'h' }),
    );
    const its = movableItems(doc, new Set(['h']));
    expect(its.length).toBe(1);
    expect(its[0]!.from).toBe(0);
  });
});

describe('levelSiblingItems — section-aware grouping (config move)', () => {
  it('groups a heading with its subtree; a sibling config is its own item', () => {
    const config = editorSchema.nodes.config.create({ unitId: 'c', configFamily: 'notation' }, [
      editorSchema.text('Z'),
    ]);
    const doc = docOf(heading('h', '# A'), prose('a1', 'x', { parentId: 'h' }), config);
    const its = levelSiblingItems(doc, null);
    expect(its.length).toBe(2); // [# A + its child] and [config] — NOT three single blocks
    expect(its[0]!.from).toBe(0);
  });
});

describe('moveBlock — reorder', () => {
  it('moves a body block up (swaps with the previous block)', () => {
    const next = run(
      caretAt(docOf(prose('a', 'A'), prose('b', 'B'), prose('c', 'C')), 1),
      moveBlock('up'),
    );
    expect(texts(next.doc)).toEqual(['B', 'A', 'C']);
  });

  it('moves a body block down', () => {
    const next = run(
      caretAt(docOf(prose('a', 'A'), prose('b', 'B'), prose('c', 'C')), 1),
      moveBlock('down'),
    );
    expect(texts(next.doc)).toEqual(['A', 'C', 'B']);
  });

  it('is a no-op at the boundary (Alt-Up on the first block returns false)', () => {
    const s = caretAt(docOf(prose('a', 'A'), prose('b', 'B')), 0);
    expect(moveBlock('up')(s, () => {})).toBe(false);
  });

  it('an UNFOLDED heading moves as a SINGLE block (just the title line)', () => {
    const next = run(caretAt(docOf(heading('h', '# A'), prose('b', 'body')), 0), moveBlock('down'));
    expect(texts(next.doc)).toEqual(['body', '# A']);
  });

  it('a FOLDED heading moves with its WHOLE subtree', () => {
    const doc = docOf(
      heading('h', '# A'),
      prose('a1', 'x', { parentId: 'h' }),
      prose('p', 'plain'),
    );
    const base = EditorState.create({
      schema: editorSchema,
      doc,
      plugins: [headingRecognize, headingResection, headingFold],
    });
    const folded = base.apply(base.tr.setMeta(foldPluginKey, { toggle: 'h' }));
    const withCaret = folded.apply(folded.tr.setSelection(TextSelection.create(folded.doc, 1)));
    const next = run(withCaret, moveBlock('down')); // the section (# A + x) jumps past 'plain'
    expect(texts(next.doc)).toEqual(['plain', '# A', 'x']);
  });

  it('the config (notation) block steps OVER a whole section when moved up (not into it)', () => {
    const config = editorSchema.nodes.config.create({ unitId: 'c', configFamily: 'notation' }, [
      editorSchema.text('Z := ZZ'),
    ]);
    const doc = docOf(heading('h', '# A'), prose('a1', 'x', { parentId: 'h' }), config);
    const next = run(caretAt(doc, 2), moveBlock('up')); // caret in the config (index 2)
    expect(texts(next.doc)).toEqual(['Z := ZZ', '# A', 'x']); // jumped the whole # A section, not into it
  });
});
