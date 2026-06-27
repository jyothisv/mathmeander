// blockHandle: a ⋮⋮ handle widget per prose block (the gutter affordance). The menu interaction is DOM-level
// (manual/e2e); here we lock that exactly one handle is produced per prose block.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import { editorSchema } from './schema';
import { blockHandle } from './blockHandle';

const prose = (id: string, text: string) =>
  editorSchema.nodes.prose.create({ unitId: id }, text ? [editorSchema.text(text)] : undefined);

describe('blockHandle', () => {
  it('adds a handle widget to each prose block AND the config block', () => {
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.config.create({ unitId: 'c0', configFamily: 'notation' }, [
        editorSchema.text('Z* := ZZ^*'),
      ]),
      prose('a', 'A'),
      prose('b', 'B'),
    ]);
    const state = EditorState.create({ schema: editorSchema, doc, plugins: [blockHandle] });
    const decos = blockHandle.props.decorations!.call(blockHandle, state) as DecorationSet;
    expect(decos.find().length).toBe(3); // a handle on the config block + the two prose blocks
  });
});
