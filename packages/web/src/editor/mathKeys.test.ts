// Controlled deletion at the inline-math boundary: Backspace/Delete next to a `$…$` (mathExpr) span delete
// exactly one character at the document level (pre-empting flaky native deletion next to the rendered math's
// hidden source), while plain prose falls through to native. Pure prosemirror-model — no DOM.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { mathBackspace, mathDelete } from './mathKeys';

const MARK = editorSchema.marks.mathExpr;

function makeExpr(id: string, surface: string): MathExpression {
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
function txt(s: string, expr?: MathExpression): Node {
  return expr ? editorSchema.text(s, [MARK.create({ expr })]) : editorSchema.text(s);
}
function prose(...children: Node[]): Node {
  return editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, children),
  ]);
}

/** Run `cmd` with the caret at `caret`; return whether it handled and the resulting doc. */
function run(cmd: Command, doc: Node, caret: number): { handled: boolean; doc: Node } {
  const state = EditorState.create({
    schema: editorSchema,
    doc,
    selection: TextSelection.create(doc, caret),
  });
  let out = doc;
  const handled = cmd(state, (tr) => {
    out = state.apply(tr).doc;
  });
  return { handled, doc: out };
}

/** The first prose block's text + whether it still carries a mathExpr mark anywhere. */
function read(doc: Node): { text: string; hasMath: boolean } {
  let text = '';
  let hasMath = false;
  doc.firstChild!.forEach((n) => {
    if (n.isText) {
      text += n.text ?? '';
      if (n.marks.some((m) => m.type === MARK)) hasMath = true;
    }
  });
  return { text, hasMath };
}

describe('mathBackspace', () => {
  it('deletes only the trailing space after a rendered $x$ (the reported bug)', () => {
    const r = run(mathBackspace, prose(txt('$x$', makeExpr('a', 'x')), txt(' ')), 5);
    expect(r.handled).toBe(true);
    expect(read(r.doc)).toEqual({ text: '$x$', hasMath: true }); // equation intact, mark preserved
  });

  it('deletes the closing $ when the caret is right after the equation (a delimiter edit)', () => {
    const r = run(mathBackspace, prose(txt('$x$', makeExpr('a', 'x'))), 4);
    expect(r.handled).toBe(true);
    expect(read(r.doc).text).toBe('$x'); // one char removed, not the whole span
  });

  it('returns false for plain prose so native deletion handles normal text', () => {
    const r = run(mathBackspace, prose(txt('ab')), 3);
    expect(r.handled).toBe(false);
    expect(read(r.doc).text).toBe('ab'); // untouched
  });

  it('returns false at the start of the block (clearType/merge own that)', () => {
    expect(run(mathBackspace, prose(txt('$x$', makeExpr('a', 'x'))), 1).handled).toBe(false);
  });
});

describe('mathDelete', () => {
  it('deletes only the space before an equation (forward mirror)', () => {
    const r = run(mathDelete, prose(txt(' '), txt('$x$', makeExpr('a', 'x'))), 1);
    expect(r.handled).toBe(true);
    expect(read(r.doc)).toEqual({ text: '$x$', hasMath: true });
  });

  it('returns false for plain prose', () => {
    expect(run(mathDelete, prose(txt('ab')), 1).handled).toBe(false);
  });
});
