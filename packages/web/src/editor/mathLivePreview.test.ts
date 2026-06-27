// mathLivePreview decoration logic: a marked `$…$` span is RENDERED (hidden text + KaTeX widget) when the
// selection is outside it and REVEALED (no decoration) when the selection touches it; and an UNCLOSED `$…`
// region under the caret is colored (`math-src`). The widget's KaTeX render is deferred (toDOM), so building
// the DecorationSet needs no DOM; katex + the WASM runtime are stubbed anyway. The double-click/suppress path
// needs real pointer events and is covered by the e2e suite.
import { describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import { DecorationSet } from 'prosemirror-view';

vi.mock('katex', () => ({ default: { render: () => {} } }));
vi.mock('./mathRuntime', () => ({ isMathRuntimeReady: () => true, toKatex: (s: string) => s }));

import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { hiddenMathLineAt, mathLivePreview } from './mathLivePreview';

const MARK = editorSchema.marks.mathExpr;

function expr(id: string, surface: string): MathExpression {
  return {
    id,
    surface_text: surface,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: surface,
    parse_status: 'renderable',
    occurrences: [],
  };
}

/** A prose doc from text nodes (a `$…$` node is marked when given an expr). */
function doc(...nodes: { text: string; expr?: MathExpression }[]): Node {
  const children = nodes.map((n) =>
    n.expr ? editorSchema.text(n.text, [MARK.create({ expr: n.expr })]) : editorSchema.text(n.text),
  );
  return editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, children),
  ]);
}

/** The decorations the plugin produces for `d` with the caret at `caret`, intersecting `[from, to)`. */
function decosIn(d: Node, caret: number, from: number, to: number) {
  const state = EditorState.create({
    schema: editorSchema,
    doc: d,
    plugins: [mathLivePreview],
    selection: TextSelection.create(d, caret),
  });
  const set = mathLivePreview.props.decorations!.call(mathLivePreview, state) as
    | DecorationSet
    | null
    | undefined;
  return set ? set.find(from, to) : [];
}

describe('mathLivePreview — render vs reveal by selection touch', () => {
  // doc: "$x$ ab" → marked $x$ at [1,4), " ab" at [4,7)
  const d = doc({ text: '$x$', expr: expr('m1', 'x') }, { text: ' ab' });

  it('renders (hidden text + widget) when the caret is outside the span', () => {
    expect(decosIn(d, 6, 1, 4).length).toBeGreaterThan(0); // caret in " ab"
  });

  it('reveals (no decoration over the span) when the caret is inside it', () => {
    expect(decosIn(d, 2, 1, 4)).toHaveLength(0);
  });

  it('reveals when the caret is at the closing-$ boundary (so keyboard entry is smooth)', () => {
    expect(decosIn(d, 4, 1, 4)).toHaveLength(0);
  });
});

describe('mathLivePreview — display math (render ALWAYS; source revealed on focus)', () => {
  // doc: prose "A" (block [0,3), text at [1,2)), then a display block "$$x$$" (block [3,10), span [4,9),
  // the render widget at 9). Display behaves unlike inline: the centered render persists even when the
  // selection is inside; only the `$$…$$` source is hidden (when blurred) / shown (when focused).
  function dispDoc(): Node {
    return editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'p' }, editorSchema.text('A')),
      editorSchema.nodes.prose.create({ unitId: 'm' }, [
        editorSchema.text('$$x$$', [MARK.create({ expr: expr('m-e', 'x'), display: true })]),
      ]),
    ]);
  }
  const d = dispDoc();

  it('renders the centered equation whether the caret is OUTSIDE or INSIDE the block', () => {
    expect(decosIn(d, 1, 3, 10).length).toBeGreaterThan(0); // caret in "A" (blurred) → render present
    expect(decosIn(d, 6, 3, 10).length).toBeGreaterThan(0); // caret inside $$x$$ (focused) → still present
  });

  it('hides the $$…$$ source when the caret is OUTSIDE the block', () => {
    expect(decosIn(d, 1, 4, 8).length).toBeGreaterThan(0); // a math-hidden decoration over the source
  });

  it('reveals the $$…$$ source (no hide) when the caret is INSIDE the block', () => {
    expect(decosIn(d, 6, 4, 8)).toHaveLength(0); // source shown for editing; render stays (widget at 9)
  });
});

describe('mathLivePreview — open-region coloring', () => {
  it('colors an unclosed $x while the caret is inside it', () => {
    const d = doc({ text: '$x' }); // no mark — still being typed
    expect(decosIn(d, 3, 1, 3).length).toBeGreaterThan(0);
  });

  it('does not color when the caret is before the $', () => {
    const d = doc({ text: 'a $x' });
    expect(decosIn(d, 2, 1, 5)).toHaveLength(0); // caret at the space before "$x"
  });
});

describe('hiddenMathLineAt — the verticalNav bridge predicate (no-native-caret math lines)', () => {
  const br = (): Node => editorSchema.nodes.hard_break.create();
  const sysMark = MARK.create({ expr: expr('sys', '$$\na=b\nc=d\n$$'), display: true });
  const d = editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'a' }, editorSchema.text('plain')),
    editorSchema.nodes.prose.create({ unitId: 'd1' }, [
      editorSchema.text('$$x$$', [MARK.create({ expr: expr('m1', 'x'), display: true })]),
    ]),
    editorSchema.nodes.prose.create({ unitId: 'sys' }, [
      editorSchema.text('$$', [sysMark]),
      br(),
      editorSchema.text('a=b', [sysMark]),
      br(),
      editorSchema.text('c=d', [sysMark]),
      br(),
      editorSchema.text('$$', [sysMark]),
    ]),
    editorSchema.nodes.prose.create({ unitId: 'mix' }, [
      editorSchema.text('see '),
      editorSchema.text('$y$', [MARK.create({ expr: expr('m3', 'y') })]),
      editorSchema.text(' ok'),
    ]),
    editorSchema.nodes.prose.create({ unitId: 'sole' }, [
      editorSchema.text('$z$', [MARK.create({ expr: expr('m4', 'z') })]),
    ]),
  ]);
  const posOf = (id: string): number => {
    let p = -1;
    d.forEach((n, off) => {
      if (n.attrs.unitId === id) p = off;
    });
    return p;
  };
  const blockOf = (id: string): Node => d.nodeAt(posOf(id))!;
  const caretIn = (id: string): EditorState =>
    EditorState.create({
      schema: editorSchema,
      doc: d,
      plugins: [mathLivePreview],
      selection: TextSelection.create(d, posOf(id) + 1),
    });

  it('a single $$…$$ display block has no caret line when the caret is away', () => {
    expect(hiddenMathLineAt(caretIn('a'), posOf('d1'), blockOf('d1'))).toBe(true);
  });
  it('a MULTI-LINE system $$…$$ block has no caret line when away (the multi-line must-fix)', () => {
    expect(hiddenMathLineAt(caretIn('a'), posOf('sys'), blockOf('sys'))).toBe(true);
  });
  it('a block whose SOLE content is inline $…$ has no caret line when away', () => {
    expect(hiddenMathLineAt(caretIn('a'), posOf('sole'), blockOf('sole'))).toBe(true);
  });
  it('a MIXED text+math block keeps a caret line (not a trap)', () => {
    expect(hiddenMathLineAt(caretIn('a'), posOf('mix'), blockOf('mix'))).toBe(false);
  });
  it('a display block is navigable once the caret is INSIDE it (source revealed)', () => {
    expect(hiddenMathLineAt(caretIn('d1'), posOf('d1'), blockOf('d1'))).toBe(false);
  });
  it('a plain prose block is never a hidden math line', () => {
    expect(hiddenMathLineAt(caretIn('a'), posOf('a'), blockOf('a'))).toBe(false);
  });
});
