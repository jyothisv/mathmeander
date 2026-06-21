// The `$` math-entry rule (mathInput.ts) — pure, no DOM. Locks: `$` in prose inserts an empty inline-math
// node with a fresh expr id and drops the caret INSIDE it (born open); it is inert outside prose.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { applyMathRule } from './mathInput';
import { emptyExpr } from './mathExpr';

const M = ['$'] as unknown as RegExpMatchArray; // the rule ignores match content

function proseState(text: string): EditorState {
  const block = editorSchema.nodes.prose.create(
    { unitId: 'u1' },
    text ? editorSchema.text(text) : undefined,
  );
  const doc = editorSchema.nodes.doc.create(null, [block]);
  const base = EditorState.create({ schema: editorSchema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1 + text.length)));
}

function firstMath(doc: Node): Node | null {
  let math: Node | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'inlineMath') {
      math = n;
      return false;
    }
    return undefined;
  });
  return math;
}

describe('mathInput ($ entry)', () => {
  it('inserts an empty inline-math node (fresh expr id) and lands the caret inside it', () => {
    const state = proseState('a '); // cursor at pos 3 (end of "a ")
    const tr = applyMathRule(state, M, 3);
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const math = firstMath(next.doc);
    expect(math).not.toBeNull();
    const expr = math!.attrs.expr as MathExpression;
    expect(expr.id).toBeTruthy();
    expect(expr.surface_text).toBe('');
    expect(math!.content.size).toBe(0); // empty, ready to type into
    // born OPEN: the caret is inside the math node's content
    expect(next.selection.$from.parent.type.name).toBe('inlineMath');
  });

  it('is inert when the caret is not in prose (returns null inside an existing math node)', () => {
    // a prose block holding a math node with the caret inside the math's source
    const math = editorSchema.nodes.inlineMath.create(
      { expr: emptyExpr() },
      editorSchema.text('x'),
    );
    const block = editorSchema.nodes.prose.create({ unitId: 'u1' }, math);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const insideMath = 2; // 0=before block,1=before math,2=inside math content
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, insideMath)));
    expect(state.selection.$from.parent.type.name).toBe('inlineMath');
    expect(applyMathRule(state, M, insideMath)).toBeNull();
  });
});
