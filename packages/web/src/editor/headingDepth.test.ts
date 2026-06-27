// Tab/Shift-Tab heading depth (headingDepth.ts). Depth changes by rewriting the `#` prefix of the whole
// subtree; headingRecognize (composed in via EditorState.apply, which runs appendTransaction to a fixpoint)
// then settles parentId. Locks: indent a leaf; indent shifts the whole subtree + preserves the chain;
// subtree boundary excludes a following same-depth heading; outdent; clamps (outdent at depth 1; indent with
// no valid parent) are swallowed no-ops; Tab in a body block falls through; the settled parentId drives the
// structural drain.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { MathContent, Unit } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { changeHeadingDepth } from './headingDepth';
import { headingRecognize } from './headingRecognize';
import { headingResection } from './headingResection';
import { structuralNeeds } from './projection';

const prose = (unitId: string, text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create(
    { unitId, ...attrs },
    text ? [editorSchema.text(text)] : undefined,
  );
const docOf = (...blocks: Node[]): Node => editorSchema.nodes.doc.create(null, blocks);

/** A state with the real heading pair (recognize sets the flag, resection derives parentId); caret at
 *  content offset `o` of block `i`. */
function stateAt(doc: Node, i: number, o: number): EditorState {
  const base = EditorState.create({
    schema: editorSchema,
    doc,
    plugins: [headingRecognize, headingResection],
  });
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos + 1 + o)));
}

/** Run the depth command; apply (recognizer settles parentId to a fixpoint). */
function run(state: EditorState, delta: 1 | -1): { ran: boolean; next: EditorState | null } {
  let tr: Transaction | null = null;
  const ran = changeHeadingDepth(delta)(state, (t) => {
    tr = t;
  });
  return { ran, next: tr ? state.apply(tr) : null };
}

const at = (s: EditorState | null, i: number) => s!.doc.child(i);

describe('changeHeadingDepth — indent (Tab)', () => {
  it('indents a leaf heading: `# B` → `## B`, settled parent = the preceding heading', () => {
    const doc = docOf(prose('a', '# A', { heading: true }), prose('b', '# B', { heading: true }));
    const { ran, next } = run(stateAt(doc, 1, 3), 1);
    expect(ran).toBe(true);
    expect(at(next, 1).textContent).toBe('## B');
    expect(at(next, 1).attrs.heading).toBe(true);
    expect(at(next, 1).attrs.parentId).toBe('a');
  });

  it('indenting shifts the WHOLE subtree (+1 to every descendant `#`) and PRESERVES the chain', () => {
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('b', '# B', { heading: true }),
      prose('b1', '## B1', { heading: true, parentId: 'b' }),
      prose('b2', '### B2', { heading: true, parentId: 'b1' }),
    );
    const { next } = run(stateAt(doc, 1, 3), 1);
    expect(at(next, 1).textContent).toBe('## B');
    expect(at(next, 2).textContent).toBe('### B1');
    expect(at(next, 3).textContent).toBe('#### B2');
    expect(at(next, 1).attrs.parentId).toBe('a'); // B under A
    expect(at(next, 2).attrs.parentId).toBe('b'); // B1 still under B
    expect(at(next, 3).attrs.parentId).toBe('b1'); // B2 still under B1
  });

  it('SUBTREE BOUNDARY: a following same-depth heading is NOT shifted or absorbed', () => {
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('b', '# B', { heading: true }),
      prose('b1', '## B1', { heading: true, parentId: 'b' }),
      prose('c', '# C', { heading: true }),
    );
    const { next } = run(stateAt(doc, 1, 3), 1);
    expect(at(next, 1).textContent).toBe('## B');
    expect(at(next, 2).textContent).toBe('### B1');
    expect(at(next, 3).textContent).toBe('# C'); // untouched
    expect(at(next, 3).attrs.parentId ?? null).toBeNull(); // C still top-level
  });
});

describe('changeHeadingDepth — outdent (Shift-Tab)', () => {
  it('outdents a heading to top level: `## B` → `# B`, parent null', () => {
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('b', '## B', { heading: true, parentId: 'a' }),
    );
    const { next } = run(stateAt(doc, 1, 4), -1);
    expect(at(next, 1).textContent).toBe('# B');
    expect(at(next, 1).attrs.parentId ?? null).toBeNull();
  });

  it('outdent: a following same-depth sibling nests under the promoted heading (positional outline semantics)', () => {
    // `# A / ## B / ## C` (B,C both children of A); outdent B. C (still `##`) then finds B as its nearest
    // depth-1 predecessor → C nests under B. This is the positional `#`-count outline behavior (as in
    // Word/Markdown heading outlines) and the only DFS-consistent result: keeping C under A while B sits
    // adjacent at depth 1 would desync doc order from the tree (a reorder on reload). DOCUMENTED, not a bug.
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('b', '## B', { heading: true, parentId: 'a' }),
      prose('c', '## C', { heading: true, parentId: 'a' }),
    );
    const { next } = run(stateAt(doc, 1, 4), -1); // outdent B
    expect(at(next, 1).textContent).toBe('# B');
    expect(at(next, 1).attrs.parentId ?? null).toBeNull(); // B → top-level
    expect(at(next, 2).attrs.parentId).toBe('b'); // C nests under the promoted B (positional)
  });

  it('outdent shifts the subtree −1 and keeps the chain', () => {
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('b', '## B', { heading: true, parentId: 'a' }),
      prose('b1', '### B1', { heading: true, parentId: 'b' }),
    );
    const { next } = run(stateAt(doc, 1, 4), -1);
    expect(at(next, 1).textContent).toBe('# B');
    expect(at(next, 2).textContent).toBe('## B1');
    expect(at(next, 1).attrs.parentId ?? null).toBeNull();
    expect(at(next, 2).attrs.parentId).toBe('b');
  });
});

describe('changeHeadingDepth — clamps & fall-through (no corruption / no drift)', () => {
  it('outdent at depth 1 is a no-op that FALLS THROUGH (returns false → no a11y tab-trap, never demotes)', () => {
    const doc = docOf(prose('a', '# A', { heading: true }));
    const { ran, next } = run(stateAt(doc, 0, 3), -1);
    expect(ran).toBe(false); // returns false → Tab reaches default focus navigation (no keyboard trap, n1)
    expect(next).toBeNull(); // and makes no edit (never demotes a top-level heading)
  });

  it('indent with no preceding heading at the current depth falls through (returns false)', () => {
    const doc = docOf(prose('a', '# A', { heading: true }), prose('b', '# B', { heading: true }));
    // A is the first heading → nothing to nest under
    const { ran, next } = run(stateAt(doc, 0, 3), 1);
    expect(ran).toBe(false);
    expect(next).toBeNull();
  });

  it('Tab in a non-heading body block returns false (falls through to default)', () => {
    const doc = docOf(prose('a', '# A', { heading: true }), prose('b', 'body', { parentId: 'a' }));
    expect(changeHeadingDepth(1)(stateAt(doc, 1, 2), () => {})).toBe(false);
  });
});

describe('changeHeadingDepth — drives the structural drain', () => {
  it('after an indent, structuralNeeds emits a reparent for the moved heading', () => {
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('b', '# B', { heading: true }),
      prose('b1', '## B1', { heading: true, parentId: 'b' }),
    );
    const { next } = run(stateAt(doc, 1, 3), 1); // indent B → B under A; B1 still under B

    const srvUnit = (id: string, parent: string | null): Unit =>
      ({
        id,
        object_id: 'o',
        position: 0,
        status: 'rough',
        declared_by: 'user',
        provenance_id: 'p',
        content: { kind: 'heading', text: '', inline: [] },
        ...(parent ? { parent_unit_id: parent } : {}),
      }) as Unit;
    const server = {
      object_id: 'o',
      revision: 1,
      units: [srvUnit('a', null), srvUnit('b', null), srvUnit('b1', 'b')],
    } as MathContent;

    const needs = structuralNeeds(next!.doc, server);
    const reparents = needs.filter((n) => n.op === 'reparent');
    expect(reparents).toContainEqual(
      expect.objectContaining({ op: 'reparent', unitId: 'b', newParentId: 'a' }),
    );
    // B1's parent did not change (still 'b') → no reparent for it
    expect(reparents.find((r) => 'unitId' in r && r.unitId === 'b1')).toBeUndefined();
  });
});
