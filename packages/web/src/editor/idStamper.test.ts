// The unit-identity stamper: it must fill a null id AND de-duplicate a repeated id (the split-copies-attrs
// bug class). Walking in document order, the FIRST occurrence keeps the id; later duplicates are re-minted.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { MathContent } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { idStamper } from './idStamper';
import { flushToContent } from './projection';

function build(ids: Array<string | null>): Node {
  const blocks = ids.map((id, i) =>
    editorSchema.nodes.prose.create({ unitId: id }, editorSchema.text(`block ${i}`)),
  );
  return editorSchema.nodes.doc.create(null, blocks);
}

/** Apply one (empty) transaction so the plugin's appendTransaction runs over the doc. */
function stamp(doc: Node): Node {
  const state = EditorState.create({ schema: editorSchema, doc, plugins: [idStamper] });
  return state.apply(state.tr).doc;
}

describe('idStamper', () => {
  it('re-mints a duplicate unitId; the FIRST occurrence keeps it', () => {
    const out = stamp(build(['dup', 'dup']));
    expect(out.child(0).attrs.unitId).toBe('dup');
    expect(out.child(1).attrs.unitId).not.toBe('dup');
    expect(out.child(1).attrs.unitId).toBeTruthy();
  });

  it('stamps a null unitId with a fresh id', () => {
    const out = stamp(build([null]));
    expect(out.child(0).attrs.unitId).toBeTruthy();
  });

  it('leaves already-distinct ids untouched', () => {
    const out = stamp(build(['a', 'b']));
    expect(out.child(0).attrs.unitId).toBe('a');
    expect(out.child(1).attrs.unitId).toBe('b');
  });

  it('three blocks all sharing one id → three distinct ids (first kept)', () => {
    const out = stamp(build(['x', 'x', 'x']));
    const ids = [out.child(0).attrs.unitId, out.child(1).attrs.unitId, out.child(2).attrs.unitId];
    expect(ids[0]).toBe('x');
    expect(new Set(ids).size).toBe(3);
  });

  it('a de-duplicated doc flushes to two DIFFERENT ids (no "appears twice in upserts")', () => {
    const doc = stamp(build(['dup', 'dup'])); // was the split-copies-attrs duplicate
    const prior: MathContent = {
      object_id: '0197675f-71f4-7000-8000-000000000001',
      revision: 1,
      units: [],
    };
    const { upserts } = flushToContent(doc, prior);
    expect(upserts).toHaveLength(2);
    expect(upserts[0]!.id).not.toBe(upserts[1]!.id);
  });
});
