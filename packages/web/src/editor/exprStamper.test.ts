// The MathExpression-identity stamper (§6.3a): every math node carries a unique `expr.id` — a missing id is
// minted, and a DUPLICATE (e.g. an internal copy/paste of a math node) is re-minted so "copy mints fresh"
// holds and two nodes never claim one expression identity. First occurrence in document order keeps the id.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { exprStamper } from './exprStamper';

function mathNode(id: string | null): Node {
  const expr = {
    id, // may be null — exprStamper mints one
    surface_text: 'x',
    surface_format: 'mathmeander',
    original_input: 'x',
    parse_status: 'renderable',
    occurrences: [],
  };
  return editorSchema.nodes.inlineMath.create({ expr }, editorSchema.text('x'));
}

/** One prose block holding the math nodes (space-separated so they're valid inline siblings). */
function docWithMaths(ids: Array<string | null>): Node {
  const inline: Node[] = [];
  ids.forEach((id, i) => {
    if (i > 0) inline.push(editorSchema.text(' '));
    inline.push(mathNode(id));
  });
  return editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, inline),
  ]);
}

/** Apply one empty transaction so the plugin's appendTransaction runs over the doc. */
function stamp(doc: Node): Node {
  const state = EditorState.create({ schema: editorSchema, doc, plugins: [exprStamper] });
  return state.apply(state.tr).doc;
}

function exprIds(doc: Node): string[] {
  const ids: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'inlineMath') {
      ids.push((n.attrs.expr as MathExpression).id);
      return false;
    }
    return undefined;
  });
  return ids;
}

describe('exprStamper (MathExpression identity, §6.3a)', () => {
  it('mints an id for an expr missing one', () => {
    const [id] = exprIds(stamp(docWithMaths([null])));
    expect(id).toBeTruthy();
  });

  it('re-mints a duplicate expr id; the FIRST occurrence keeps it (copy-mints-fresh)', () => {
    const ids = exprIds(stamp(docWithMaths(['dup', 'dup'])));
    expect(ids[0]).toBe('dup');
    expect(ids[1]).not.toBe('dup');
    expect(ids[1]).toBeTruthy();
  });

  it('leaves already-distinct ids untouched', () => {
    expect(exprIds(stamp(docWithMaths(['a', 'b'])))).toEqual(['a', 'b']);
  });

  it('three math nodes sharing one id → three distinct ids (first kept)', () => {
    const ids = exprIds(stamp(docWithMaths(['x', 'x', 'x'])));
    expect(ids[0]).toBe('x');
    expect(new Set(ids).size).toBe(3);
  });
});
