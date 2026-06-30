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

  it('reference linkIds: fills a null and re-mints a duplicate (copy-mints-fresh)', () => {
    const ref = (linkId: string | null) =>
      editorSchema.nodes.reference.create({ text: 'x', target: null, linkId });
    const block = editorSchema.nodes.prose.create({ unitId: 'u1' }, [
      ref('dup'),
      ref('dup'),
      ref(null),
    ]);
    const out = stamp(editorSchema.nodes.doc.create(null, [block]));
    const links: Array<string | null> = [];
    out.child(0).forEach((c) => {
      if (c.type.name === 'reference') links.push(c.attrs.linkId as string | null);
    });
    expect(links[0]).toBe('dup'); // first occurrence keeps its id
    expect(links[1]).not.toBe('dup'); // duplicate re-minted
    expect(links[2]).toBeTruthy(); // null filled
    expect(new Set(links).size).toBe(3); // all distinct
  });

  it('three blocks all sharing one id → three distinct ids (first kept)', () => {
    const out = stamp(build(['x', 'x', 'x']));
    const ids = [out.child(0).attrs.unitId, out.child(1).attrs.unitId, out.child(2).attrs.unitId];
    expect(ids[0]).toBe('x');
    expect(new Set(ids).size).toBe(3);
  });

  it('re-mints a duplicate unitId on a paste-cloned display equation (now a prose $$…$$ block)', () => {
    const e = {
      id: 'x-e',
      surface_text: 'x',
      surface_format: 'mathmeander' as const,
      input_syntax: 'mathmeander' as const,
      original_input: 'x',
      parse_status: 'renderable' as const,
      occurrences: [],
    };
    // A display equation is a prose block whose content is a `$$…$$` display span; a paste-clone aliases its id.
    const eq = () =>
      editorSchema.nodes.prose.create({ unitId: 'dup' }, [
        editorSchema.text('$$x$$', [
          editorSchema.marks.mathExpr.create({ expr: e, display: true }),
        ]),
      ]);
    const doc = editorSchema.nodes.doc.create(null, [eq(), eq()]);
    const out = stamp(doc);
    expect(out.child(0).attrs.unitId).toBe('dup'); // first keeps it
    expect(out.child(1).attrs.unitId).not.toBe('dup'); // clone re-minted → no duplicate-upsert 422
    expect(out.child(1).attrs.unitId).toBeTruthy();
  });

  it('stamps + de-dups a config (notation-home) block, like a prose block (A2/A3)', () => {
    const cfg = (id: string | null) =>
      editorSchema.nodes.config.create({ unitId: id, configFamily: 'notation' }, [
        editorSchema.text('Z* := ZZ^*'),
      ]);
    const doc = editorSchema.nodes.doc.create(null, [cfg(null), cfg('dup'), cfg('dup')]);
    const out = stamp(doc);
    expect(out.child(0).attrs.unitId).toBeTruthy(); // null → stamped (no churn-a-new-unit-every-save)
    expect(out.child(1).attrs.unitId).toBe('dup'); // first keeps it
    expect(out.child(2).attrs.unitId).not.toBe('dup'); // paste-clone re-minted → no id aliasing / def loss
    expect(new Set([0, 1, 2].map((i) => out.child(i).attrs.unitId)).size).toBe(3);
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
