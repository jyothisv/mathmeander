// headingRecognize: the `#` markers are KEPT as text; this appendTransaction reconciles the `heading` FLAG
// from the live `#` count (promote on gaining a prefix, demote on losing it). `parentId` is NOT its job —
// the holistic re-section (headingResection) derives parentId from the `#`-depth sequence (see
// headingResection.test.ts). EditorState.apply runs the plugin's appendTransaction, so the asserted state
// reflects the recognizer.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import { headingRecognize } from './headingRecognize';

const prose = (unitId: string, text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create(
    { unitId, ...attrs },
    text ? [editorSchema.text(text)] : undefined,
  );
const docOf = (...blocks: Node[]): Node => editorSchema.nodes.doc.create(null, blocks);
const withReco = (doc: Node): EditorState =>
  EditorState.create({ schema: editorSchema, doc, plugins: [headingRecognize] });

describe('headingRecognize — `#` flag recognition (kept, not consumed)', () => {
  it('PROMOTES a plain block to a heading when it gains a leading "# "', () => {
    const s = withReco(docOf(prose('b1', 'x')));
    const next = s.apply(s.tr.insertText('# ', 1)); // "x" → "# x"
    expect(next.doc.firstChild!.attrs.heading).toBe(true);
    expect(next.doc.firstChild!.textContent).toBe('# x'); // the hashes are KEPT
  });

  it('a deeper "## " also promotes to a heading (the flag; depth/parentId is re-section’s job)', () => {
    const h1 = prose('h1', '# Sec', { heading: true });
    const b2 = prose('b2', 'x');
    const s = withReco(docOf(h1, b2));
    const start = h1.nodeSize + 1; // b2 content start
    const next = s.apply(s.tr.insertText('## ', start)); // b2 → "## x"
    expect(next.doc.child(1).attrs.heading).toBe(true);
  });

  it('DEMOTES a heading when its "#" prefix is deleted', () => {
    const s = withReco(docOf(prose('h1', '# x', { heading: true })));
    const next = s.apply(s.tr.delete(1, 3)); // delete "# " → "x"
    expect(next.doc.firstChild!.attrs.heading).toBe(false);
  });

  it('does NOT promote a TYPED unit whose text starts with "# " (the hash is literal there)', () => {
    const s = withReco(docOf(prose('t1', '# x', { unitType: 'definition' })));
    const next = s.apply(s.tr.insertText('y', s.doc.content.size - 1)); // any edit → re-scan
    expect(next.doc.firstChild!.attrs.heading).toBe(false);
  });

  it('does NOT promote a MULTI-LINE block (a heading is single-line; would absorb the soft-lines + hide the `#`)', () => {
    // The "`#` silently consumed" bug: adding a `# ` prefix to a multi-line prose block via a NON-cue path
    // (paste, or `#` typed before an existing space) would promote the WHOLE block — absorbing line2 into the
    // title and folding the `#` into the hidden prefix. The single-line guard keeps it literal prose.
    const block = editorSchema.nodes.prose.create({ unitId: 'm' }, [
      editorSchema.text('line1'),
      editorSchema.nodes.hard_break.create(),
      editorSchema.text('line2'),
    ]);
    const s = withReco(docOf(block));
    const next = s.apply(s.tr.insertText('# ', 1)); // prepend "# " → "# line1⏎line2"
    expect(next.doc.firstChild!.attrs.heading).toBe(false); // NOT a heading (multi-line)
    expect(next.doc.firstChild!.textContent).toBe('# line1line2'); // the `#` is KEPT (visible, not consumed)
  });
});
