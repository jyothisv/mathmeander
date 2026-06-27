// headingResection: derives EVERY block's `parentId` from the flat heading `#`-depth sequence, so adding /
// re-depthing / demoting a heading re-sections the document. Tests run the REAL pair [headingRecognize,
// headingResection] (recognize sets the flag, resection sets parentId) and assert the resulting parentIds —
// this is the "adding a heading nests the following blocks under it" fix.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import { headingRecognize } from './headingRecognize';
import { headingResection } from './headingResection';

const prose = (unitId: string, text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create(
    { unitId, ...attrs },
    text ? [editorSchema.text(text)] : undefined,
  );
const heading = (unitId: string, text: string): Node => prose(unitId, text, { heading: true });
const docOf = (...blocks: Node[]): Node => editorSchema.nodes.doc.create(null, blocks);
const editor = (doc: Node): EditorState =>
  EditorState.create({ schema: editorSchema, doc, plugins: [headingRecognize, headingResection] });

describe('headingResection — section membership from the `#` sequence', () => {
  it('adding a heading adopts the FOLLOWING block as its child (the reported bug)', () => {
    const s = editor(docOf(prose('h1', 'x'), prose('b1', 'body')));
    const next = s.apply(s.tr.insertText('# ', 1)); // "x" → "# x" promotes h1; resection adopts b1
    expect(next.doc.child(0).attrs.heading).toBe(true);
    expect(next.doc.child(1).attrs.parentId).toBe('h1'); // b1 is now h1's child
  });

  it('"## " nests under the preceding top-level heading', () => {
    const h1 = heading('h1', '# Sec');
    const s = editor(docOf(h1, prose('b2', 'x')));
    const next = s.apply(s.tr.insertText('## ', h1.nodeSize + 1)); // b2 → "## x"
    expect(next.doc.child(1).attrs.heading).toBe(true);
    expect(next.doc.child(1).attrs.parentId).toBe('h1');
  });

  it('clamps a skipped level ("### " under only a "#" → nests under the "#")', () => {
    const h1 = heading('h1', '# Sec');
    const s = editor(docOf(h1, prose('b2', 'x')));
    const next = s.apply(s.tr.insertText('### ', h1.nodeSize + 1)); // b2 → "### x"
    expect(next.doc.child(1).attrs.parentId).toBe('h1'); // no depth-2 between → child of the "#"
  });

  it('a body block takes the DEEPEST open heading; headings nest by depth', () => {
    const doc = docOf(heading('h1', '# A'), heading('h2', '## B'), prose('b', 'text'));
    const s = editor(doc);
    const next = s.apply(s.tr.insertText('x', s.doc.content.size - 1)); // trivial edit → re-section runs
    expect(next.doc.child(0).attrs.parentId ?? null).toBe(null); // # A top-level
    expect(next.doc.child(1).attrs.parentId).toBe('h1'); // ## B under # A
    expect(next.doc.child(2).attrs.parentId).toBe('h2'); // body under the deepest open (## B)
  });

  it('demoting a heading releases its children to the enclosing section', () => {
    const h1 = heading('h1', '# A');
    const s = editor(docOf(h1, prose('b', 'body', { parentId: 'h1' })));
    const next = s.apply(s.tr.delete(1, 3)); // delete "# " → "A": h1 demotes; b has no heading above now
    expect(next.doc.child(0).attrs.heading).toBe(false);
    expect(next.doc.child(0).attrs.parentId ?? null).toBe(null);
    expect(next.doc.child(1).attrs.parentId ?? null).toBe(null); // released to top level
  });

  it('a top-level config block ends the open section: a block after it stays top-level', () => {
    // [# A, body-under-A, config (top-level), trailing] — the trailing block must re-section to TOP level
    // (parentId null), NOT under # A. Otherwise a trailing placeholder after a config inherits the heading and
    // becomes a phantom reparent intent that wedges autosave in the 'Unsaved' state (it is never sent).
    const config = editorSchema.nodes.config.create({ unitId: 'c', configFamily: 'notation' }, [
      editorSchema.text('Z := ZZ'),
    ]);
    const doc = docOf(
      heading('h1', '# A'),
      prose('b', 'body', { parentId: 'h1' }),
      config,
      prose('t', 'tail', { parentId: 'h1' }), // wrongly under h1 to start — re-section must correct it
    );
    const s = editor(doc);
    const next = s.apply(s.tr.insertText('x', s.doc.content.size - 1)); // trivial edit → re-section runs
    expect(next.doc.child(1).attrs.parentId).toBe('h1'); // body BEFORE the config still under # A
    expect(next.doc.child(3).attrs.parentId ?? null).toBe(null); // block AFTER the top-level config: top level
  });
});
