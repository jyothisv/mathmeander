// `docBlocks` projects the doc → the core-numbering input: every prose block (typed or not — the §B
// section tree must be complete for reading-order numbering), each with a PER-PARENT `position`. (The
// wasm number-mapping itself is exercised manually / e2e — the runtime isn't loaded under vitest.)
import { describe, expect, it } from 'vitest';
import { editorSchema } from './schema';
import { docBlocks } from './referenceLivePreview';

function prose(attrs: { unitId: string; unitType?: string | null; parentId?: string | null }) {
  return editorSchema.nodes.prose.create(
    { unitId: attrs.unitId, unitType: attrs.unitType ?? null, parentId: attrs.parentId ?? null },
    editorSchema.text('x'),
  );
}

describe('docBlocks', () => {
  it('emits every prose block with its type and per-parent position', () => {
    const doc = editorSchema.nodes.doc.create(null, [
      prose({ unitId: 't1', unitType: 'theorem' }),
      prose({ unitId: 'p1', unitType: null }),
      prose({ unitId: 'd1', unitType: 'definition' }),
    ]);
    expect(docBlocks(doc)).toEqual([
      { id: 't1', type: 'theorem', parent_unit_id: null, position: 0 },
      { id: 'p1', type: null, parent_unit_id: null, position: 1 },
      { id: 'd1', type: 'definition', parent_unit_id: null, position: 2 },
    ]);
  });

  it('numbers positions PER PARENT (a §B section restarts at 0 under its heading)', () => {
    const doc = editorSchema.nodes.doc.create(null, [
      prose({ unitId: 'h1', unitType: null }), // a heading (section parent)
      prose({ unitId: 'a', unitType: 'theorem', parentId: 'h1' }),
      prose({ unitId: 'b', unitType: 'definition', parentId: 'h1' }),
      prose({ unitId: 'top', unitType: 'theorem' }), // back at top level
    ]);
    expect(docBlocks(doc)).toEqual([
      { id: 'h1', type: null, parent_unit_id: null, position: 0 },
      { id: 'a', type: 'theorem', parent_unit_id: 'h1', position: 0 },
      { id: 'b', type: 'definition', parent_unit_id: 'h1', position: 1 },
      { id: 'top', type: 'theorem', parent_unit_id: null, position: 1 },
    ]);
  });

  it('skips blocks without a stamped unitId', () => {
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create(
        { unitId: null, unitType: 'theorem' },
        editorSchema.text('x'),
      ),
      prose({ unitId: 't1', unitType: 'theorem' }),
    ]);
    expect(docBlocks(doc).map((b) => b.id)).toEqual(['t1']);
  });
});
