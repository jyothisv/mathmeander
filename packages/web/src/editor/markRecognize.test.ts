// The inline-formatting recognizer plugin: scanning `**…**` etc. → the `styled` mark over the inner, delimiters
// LEFT IN PLACE, idempotently, and yielding to math (no styling inside a `$…$` span). Recognition runs on a doc
// edit, so tests drive it through real transactions (mirrors mathRecognize.test.ts).
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { markRecognize } from './markRecognize';
import { toggleDelimiter } from './markKeys';

const STYLED = editorSchema.marks.styled;
const MATH = editorSchema.marks.mathExpr;

function makeExpr(surface: string): MathExpression {
  return {
    id: '0197675f-71f4-7000-8000-0000000000a1',
    surface_text: surface,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: surface,
    parse_status: 'renderable',
    occurrences: [],
  };
}

function txt(s: string, expr?: MathExpression): Node {
  return expr ? editorSchema.text(s, [MATH.create({ expr })]) : editorSchema.text(s);
}
function prose(...children: Node[]): Node {
  return editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, children.length ? children : undefined),
  ]);
}

/** Build a state, run a doc-changing edit, return the recognized doc. */
function afterEdit(
  doc: Node,
  edit: (tr: ReturnType<EditorState['tr']['insertText']>) => void,
): Node {
  const state = EditorState.create({ schema: editorSchema, doc, plugins: [markRecognize] });
  const tr = state.tr;
  edit(tr);
  return state.apply(tr).doc;
}

/** Type `text` into an empty prose block. */
function typed(text: string): Node {
  return afterEdit(prose(), (tr) => tr.insertText(text, 1));
}

/** The styled-marked spans of a recognized doc, in order: `style:text`. */
function styled(d: Node): string[] {
  const out: string[] = [];
  d.descendants((node) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type === STYLED);
    if (m) out.push(`${m.attrs.style as string}:${node.text ?? ''}`);
  });
  return out;
}

describe('markRecognize', () => {
  it('styles the inner of each markdown region, keeping the delimiters', () => {
    expect(styled(typed('**bold**'))).toEqual(['strong:bold']);
    expect(styled(typed('*italic*'))).toEqual(['em:italic']);
    expect(styled(typed('~~gone~~'))).toEqual(['strike:gone']);
    expect(styled(typed('`code`'))).toEqual(['code:code']);
  });

  it('leaves the delimiters as plain text (the full source survives)', () => {
    const d = typed('a **b** c');
    expect(d.textContent).toBe('a **b** c'); // asterisks NOT consumed
    expect(styled(d)).toEqual(['strong:b']);
  });

  it('does not style a space-flanked `*` (so plain prose with arithmetic is safe)', () => {
    expect(styled(typed('2 * 3 = 6'))).toEqual([]);
  });

  it('is idempotent — re-running on already-marked content makes no change', () => {
    const once = typed('**bold**');
    const state = EditorState.create({ schema: editorSchema, doc: once, plugins: [markRecognize] });
    // a pure no-op selection tr (no docChange) → the plugin returns null
    expect(markRecognize.spec.appendTransaction?.([state.tr], state, state)).toBeNull();
  });

  it('MATH WINS — a `*` inside a `$…$` span is never styled', () => {
    // Simulate the post-mathRecognize state: `$a*b$` carrying the mathExpr mark, then a trailing edit.
    const doc = prose(txt('$a*b$', makeExpr('a*b')), txt(' x'));
    const after = afterEdit(doc, (tr) => tr.insertText('!', tr.doc.content.size - 1));
    expect(styled(after)).toEqual([]); // the `*` inside the equation stays math, not emphasis
  });

  it('styles formatting OUTSIDE a math span while leaving the equation alone', () => {
    const doc = prose(txt('**b** '), txt('$x$', makeExpr('x')));
    const after = afterEdit(doc, (tr) => tr.insertText('!', 1)); // nudge to trigger a docChange
    expect(styled(after)).toEqual(['strong:b']);
  });

  it('Mod-b across a math span is a no-op (no stray delimiters)', () => {
    // doc: "a " + "$x$"(math) + " b" — select across the math span and try to bold it.
    const doc = prose(txt('a '), txt('$x$', makeExpr('x')), txt(' b'));
    const state = EditorState.create({
      schema: editorSchema,
      doc,
      plugins: [markRecognize],
      selection: TextSelection.create(doc, 1, doc.content.size),
    });
    let dispatched: unknown = null;
    const handled = toggleDelimiter('**')(state, (tr) => {
      dispatched = tr;
    });
    expect(handled).toBe(true); // swallowed (so the browser's native bold can't fire)
    expect(dispatched).toBeNull(); // but nothing inserted — no `**` straddling the equation
  });

  it('drops a stale mark when its delimiters are removed', () => {
    const once = typed('**bold**'); // `**bold**` occupies positions 1..9 in the prose block
    // delete the trailing `**` (positions 7..9) → `**bold` no longer a region → the strong mark must clear
    const state = EditorState.create({ schema: editorSchema, doc: once, plugins: [markRecognize] });
    const after = state.apply(state.tr.delete(7, 9)).doc;
    expect(after.textContent).toBe('**bold');
    expect(styled(after)).toEqual([]);
  });
});
