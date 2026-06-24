// markLivePreview decoration logic: the wrapping markdown delimiters of a styled span are HIDDEN when the
// selection is outside the region and REVEALED (no decoration) when it touches — inclusive of the delimiters,
// so keyboard entry across the boundary is smooth. The styled inner itself is never decorated (always shown).
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import { DecorationSet } from 'prosemirror-view';
import { editorSchema } from './schema';
import { markLivePreview } from './markLivePreview';

const strong = () => editorSchema.marks.styled.create({ style: 'strong' });

/** Doc `**bold** x`: `**`[1,3) · `bold`[3,7) styled · `** x`[7,11) (closing `**` at [7,9)). */
function boldDoc(): Node {
  return editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, [
      editorSchema.text('**'),
      editorSchema.text('bold', [strong()]),
      editorSchema.text('** x'),
    ]),
  ]);
}

/** The hide decorations the plugin produces for `d` with the caret at `caret`. */
function hideDecos(d: Node, caret: number) {
  const state = EditorState.create({
    schema: editorSchema,
    doc: d,
    plugins: [markLivePreview],
    selection: TextSelection.create(d, caret),
  });
  const set = markLivePreview.props.decorations!.call(markLivePreview, state) as
    | DecorationSet
    | null
    | undefined;
  return set ? set.find() : [];
}

describe('markLivePreview — hide delimiters on blur, reveal on touch', () => {
  it('hides both delimiters when the caret is outside the region', () => {
    const decos = hideDecos(boldDoc(), 10); // caret in the trailing " x"
    expect(decos).toHaveLength(2); // the opening `**` and the closing `**`
  });

  it('reveals (no decoration) when the caret is inside the styled inner', () => {
    expect(hideDecos(boldDoc(), 5)).toHaveLength(0); // caret in "bold"
  });

  it('reveals at the opening boundary (so arrowing in is smooth)', () => {
    expect(hideDecos(boldDoc(), 1)).toHaveLength(0); // caret just before the opening `**`
  });

  it('reveals at the closing boundary', () => {
    expect(hideDecos(boldDoc(), 9)).toHaveLength(0); // caret just after the closing `**`
  });

  it('hides exactly the delimiter ranges, never the inner', () => {
    const set = markLivePreview.props.decorations!.call(
      markLivePreview,
      EditorState.create({
        schema: editorSchema,
        doc: boldDoc(),
        plugins: [markLivePreview],
        selection: TextSelection.create(boldDoc(), 10),
      }),
    ) as DecorationSet;
    const ranges = set
      .find()
      .map((d) => [d.from, d.to])
      .sort((a, b) => a[0]! - b[0]!);
    expect(ranges).toEqual([
      [1, 3],
      [7, 9],
    ]); // opening + closing `**`, inner [3,7) untouched
  });

  it('does not hide a clean styled mark with no surrounding delimiters', () => {
    // A `strong` span over bare "bold" (no `**` in the text) must NOT have its content hidden.
    const clean = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'u1' }, [
        editorSchema.text('bold', [strong()]),
        editorSchema.text(' x'),
      ]),
    ]);
    expect(hideDecos(clean, 7)).toHaveLength(0);
  });
});
