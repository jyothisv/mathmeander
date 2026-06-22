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
import { mathLivePreview } from './mathLivePreview';

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
