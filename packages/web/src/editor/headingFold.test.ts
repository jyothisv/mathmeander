// Section folding (headingFold.ts) — the view-only fold-state machine (no DOM needed for the logic).
// Locks: descendantBlocks/foldedHiddenPositions; toggle adds/removes; folding hides the subtree; a demoted
// heading is pruned from the fold set; caret-safety auto-unfolds when the selection lands in hidden content.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import { headingIndex } from './cues';
import {
  headingFold,
  toggleFold,
  foldedHeadings,
  foldedHiddenPositions,
  descendantBlocks,
} from './headingFold';

const prose = (unitId: string, text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create(
    { unitId, ...attrs },
    text ? [editorSchema.text(text)] : undefined,
  );
const docOf = (...blocks: Node[]): Node => editorSchema.nodes.doc.create(null, blocks);
const withFold = (doc: Node): EditorState =>
  EditorState.create({ schema: editorSchema, doc, plugins: [headingFold] });

/** A section: heading H + a body + a subsection (with its own body). */
const section = (): Node =>
  docOf(
    prose('h', '# H', { heading: true }),
    prose('hb', 'body of H', { parentId: 'h' }),
    prose('s', '## S', { heading: true, parentId: 'h' }),
    prose('sb', 'body of S', { parentId: 's' }),
    prose('after', '# After', { heading: true }),
  );

/** Toggle a heading's fold and return the next state (recognizer-free; fold is pure view state). */
const toggle = (s: EditorState, id: string): EditorState => {
  let next = s;
  toggleFold(id)(s, (tr) => {
    next = s.apply(tr);
  });
  return next;
};

describe('descendantBlocks', () => {
  it('returns the whole subtree (body + subsection + its body), excluding a following sibling section', () => {
    const doc = section();
    const ids = descendantBlocks(doc, 'h', headingIndex(doc)).map(
      (d) => doc.resolve(d.pos + 1).parent.attrs.unitId,
    );
    expect(ids).toEqual(['hb', 's', 'sb']); // NOT 'after'
  });

  it('a leaf heading has no descendants', () => {
    const doc = section();
    expect(descendantBlocks(doc, 'after', headingIndex(doc))).toHaveLength(0);
  });
});

describe('fold state machine', () => {
  it('toggling folds then unfolds; folding hides the whole subtree', () => {
    const s0 = withFold(section());
    expect(foldedHeadings(s0).size).toBe(0);

    const s1 = toggle(s0, 'h');
    expect([...foldedHeadings(s1)]).toEqual(['h']);
    // the hidden positions are exactly H's descendants (hb, s, sb)
    const hidden = foldedHiddenPositions(s1.doc, foldedHeadings(s1) as Set<string>);
    const hiddenIds = hidden.map((pos) => s1.doc.resolve(pos + 1).parent.attrs.unitId);
    expect(hiddenIds).toEqual(['hb', 's', 'sb']);

    const s2 = toggle(s1, 'h');
    expect(foldedHeadings(s2).size).toBe(0);
  });

  it('prunes a folded heading that is demoted/removed on a doc edit', () => {
    const s1 = toggle(withFold(section()), 'h');
    expect(foldedHeadings(s1).has('h')).toBe(true);
    // demote h: clear its heading attr (a doc change) → it's no longer a heading → pruned from the set
    const hPos = 0;
    const s2 = s1.apply(s1.tr.setNodeAttribute(hPos, 'heading', false));
    expect(foldedHeadings(s2).has('h')).toBe(false);
  });
});

describe('caret safety', () => {
  it('auto-unfolds when the selection lands inside a hidden (folded) descendant', () => {
    const s1 = toggle(withFold(section()), 'h'); // h folded → hb/s/sb hidden
    expect(foldedHeadings(s1).has('h')).toBe(true);
    // move the caret into the hidden body block 'hb' (block index 1)
    const hbStart = s1.doc.child(0).nodeSize + 1;
    const s2 = s1.apply(s1.tr.setSelection(TextSelection.create(s1.doc, hbStart)));
    expect(foldedHeadings(s2).has('h')).toBe(false); // unfolded so the caret is visible
  });

  it('a caret on the heading itself keeps the fold (the heading is not hidden)', () => {
    const s1 = toggle(withFold(section()), 'h');
    const hStart = 1; // inside the heading block content
    const s2 = s1.apply(s1.tr.setSelection(TextSelection.create(s1.doc, hStart)));
    expect(foldedHeadings(s2).has('h')).toBe(true);
  });
});
