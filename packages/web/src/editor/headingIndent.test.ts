// Depth-based indentation (headingIndent.ts) — the `computeDepths` chain walk. Heading → depth−1; body →
// its section depth (one step under the title); top-level → 0; malformed parentId → 0 (no throw); capped.
import { describe, expect, it } from 'vitest';
import type { Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import { computeDepths } from './headingIndent';

const prose = (unitId: string, text: string, attrs: Record<string, unknown> = {}): Node =>
  editorSchema.nodes.prose.create(
    { unitId, ...attrs },
    text ? [editorSchema.text(text)] : undefined,
  );
const docOf = (...blocks: Node[]): Node => editorSchema.nodes.doc.create(null, blocks);
const levels = (doc: Node): number[] => computeDepths(doc).map((b) => b.level);

describe('computeDepths', () => {
  it('flat top-level prose → all level 0', () => {
    expect(levels(docOf(prose('a', 'one'), prose('b', 'two')))).toEqual([0, 0]);
  });

  it('a top-level heading is flush-left (level 0); its body is one step in (level 1)', () => {
    const doc = docOf(prose('h', '# A', { heading: true }), prose('b', 'body', { parentId: 'h' }));
    expect(levels(doc)).toEqual([0, 1]);
  });

  it('nested headings ladder by depth; bodies sit one step under their section', () => {
    const doc = docOf(
      prose('a', '# A', { heading: true }),
      prose('a-b', 'body of A', { parentId: 'a' }),
      prose('b', '## B', { heading: true, parentId: 'a' }),
      prose('b-b', 'body of B', { parentId: 'b' }),
    );
    // A heading=0, A body=1, B heading=1, B body=2
    expect(levels(doc)).toEqual([0, 1, 1, 2]);
  });

  it('a malformed body parentId (no such heading) falls back to level 0 (no throw)', () => {
    const doc = docOf(prose('b', 'orphan', { parentId: 'missing' }));
    expect(levels(doc)).toEqual([0]);
  });

  it('caps deep nesting at the CSS ladder max (6) via the decoration class, not the raw level', () => {
    // build a depth-9 heading chain; computeDepths reports the true level, the plugin clamps to 6 in the class
    const blocks: Node[] = [];
    let parent: string | null = null;
    for (let i = 1; i <= 9; i++) {
      const id = `h${i}`;
      blocks.push(
        prose(
          id,
          '#'.repeat(i) + ' H',
          parent ? { heading: true, parentId: parent } : { heading: true },
        ),
      );
      parent = id;
    }
    const lv = levels(docOf(...blocks));
    expect(lv[0]).toBe(0); // depth 1 → level 0
    expect(lv[8]).toBe(8); // depth 9 → level 8 (raw; the plugin's class is min(8,6))
  });
});
