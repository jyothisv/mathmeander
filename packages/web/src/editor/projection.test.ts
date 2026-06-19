// The load-bearing 2c-1 test: the MathContent ⇄ ProseMirror round-trip, especially the zero-width
// inline-atom contract (§6.0) and Mark regions. Pure (prosemirror-model runs in node, no DOM).
import { describe, expect, it } from 'vitest';
import type { Inline, MathContent, MathExpression, Unit } from '@mathmeander/schema';
import { flushToContent, isFlatProse, projectToDoc } from './projection';

const OBJ = '0197675f-71f4-7000-8000-000000000001';

function prose(id: string, position: number, text: string, inline: Inline[] = []): Unit {
  return {
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline },
    provenance_id: '0197675f-71f4-7000-8000-0000000000d1',
  };
}
const content = (units: Unit[]): MathContent => ({ object_id: OBJ, revision: 3, units });

/** Project content to a doc, then flush it back unchanged → the delta must be EMPTY (round-trip). */
function roundTripIsClean(c: MathContent): boolean {
  const { upserts, deletes } = flushToContent(projectToDoc(c), c);
  return upserts.length === 0 && deletes.length === 0;
}

describe('MathContent ⇄ ProseMirror round-trip', () => {
  it('plain prose round-trips with no delta', () => {
    expect(
      roundTripIsClean(content([prose('u1', 0, 'Hello, world.'), prose('u2', 1, 'Second.')])),
    ).toBe(true);
  });

  it('a zero-width inline-math atom round-trips (its span stays [p,p] at the char offset)', () => {
    const expr: MathExpression = {
      id: '0197675f-71f4-7000-8000-0000000000e1',
      surface_text: 'd',
      surface_format: 'mathmeander',
      original_input: 'd',
      parse_status: 'renderable',
      occurrences: [],
    };
    const c = content([
      prose('u1', 0, 'a b', [{ kind: 'math', span: { start: 2, end: 2 }, expr }]),
    ]);
    expect(roundTripIsClean(c)).toBe(true);
    // and the flushed atom is recovered exactly
    const doc = projectToDoc(content([prose('u1', 0, 'a b', [])])); // a doc WITHOUT the atom (prior had it)
    const { upserts } = flushToContent(doc, c);
    expect(upserts).toHaveLength(1);
    const inline = (upserts[0]!.content as { inline: Inline[] }).inline;
    expect(inline).toHaveLength(0); // the atom was removed → delta reflects it
  });

  it('a non-BMP glyph keeps char (code-point) offsets correct', () => {
    // "𝔽 x" — 𝔽 is a single code point but two UTF-16 units; an atom after it sits at offset 2.
    const expr: MathExpression = {
      id: '0197675f-71f4-7000-8000-0000000000e2',
      surface_text: 'n',
      surface_format: 'mathmeander',
      original_input: 'n',
      parse_status: 'renderable',
      occurrences: [],
    };
    const c = content([
      prose('u1', 0, '𝔽 x', [{ kind: 'math', span: { start: 2, end: 2 }, expr }]),
    ]);
    expect(roundTripIsClean(c)).toBe(true);
  });

  it('a Mark region round-trips', () => {
    const c = content([
      prose('u1', 0, 'abcdef', [{ kind: 'mark', span: { start: 1, end: 4 }, style: 'em' }]),
    ]);
    expect(roundTripIsClean(c)).toBe(true);
  });

  it('a Mark region survives a zero-width atom inside it', () => {
    const expr: MathExpression = {
      id: '0197675f-71f4-7000-8000-0000000000e3',
      surface_text: 'k',
      surface_format: 'mathmeander',
      original_input: 'k',
      parse_status: 'renderable',
      occurrences: [],
    };
    const c = content([
      prose('u1', 0, 'abcd', [
        { kind: 'mark', span: { start: 0, end: 4 }, style: 'strong' },
        { kind: 'math', span: { start: 2, end: 2 }, expr },
      ]),
    ]);
    expect(roundTripIsClean(c)).toBe(true);
  });
});

describe('flushToContent delta', () => {
  it('an edited paragraph is the only upsert; unchanged siblings are not resent', () => {
    const prior = content([prose('u1', 0, 'first'), prose('u2', 1, 'second')]);
    const edited = content([prose('u1', 0, 'FIRST'), prose('u2', 1, 'second')]);
    const { upserts, deletes } = flushToContent(projectToDoc(edited), prior);
    expect(deletes).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.id).toBe('u1');
  });

  it('a removed paragraph is a delete', () => {
    const prior = content([prose('u1', 0, 'keep'), prose('u2', 1, 'drop')]);
    const after = content([prose('u1', 0, 'keep')]);
    const { upserts, deletes } = flushToContent(projectToDoc(after), prior);
    expect(upserts).toEqual([]);
    expect(deletes).toEqual(['u2']);
  });

  it('reordering two paragraphs upserts both with swapped positions', () => {
    const prior = content([prose('u1', 0, 'a'), prose('u2', 1, 'b')]);
    const swapped = content([prose('u1', 1, 'a'), prose('u2', 0, 'b')]);
    const { upserts, deletes } = flushToContent(projectToDoc(swapped), prior);
    expect(deletes).toEqual([]);
    const pos = (id: string) => upserts.find((u) => u.id === id)?.position;
    expect(pos('u1')).toBe(1);
    expect(pos('u2')).toBe(0);
  });

  it('a middle delete renumbers + upserts only the shifted survivor', () => {
    const prior = content([prose('u1', 0, 'a'), prose('u2', 1, 'b'), prose('u3', 2, 'c')]);
    const after = content([prose('u1', 0, 'a'), prose('u3', 1, 'c')]); // u2 gone, u3 shifted 2→1
    const { upserts, deletes } = flushToContent(projectToDoc(after), prior);
    expect(deletes).toEqual(['u2']);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.id).toBe('u3');
    expect(upserts[0]!.position).toBe(1);
  });

  it('an inline Reference atom round-trips (incl. an object target)', () => {
    const c = content([
      prose('u1', 0, 'see x', [
        {
          kind: 'reference',
          span: { start: 4, end: 4 },
          text: 'x',
          target: { kind: 'object', object_id: '0197675f-71f4-7000-8000-0000000000f1' },
        },
      ]),
    ]);
    expect(roundTripIsClean(c)).toBe(true);
  });

  it('an empty day projects to an editable doc and flushes to nothing', () => {
    const empty = content([]);
    expect(isFlatProse(empty)).toBe(true);
    const { upserts, deletes } = flushToContent(projectToDoc(empty), empty);
    expect(upserts).toEqual([]);
    expect(deletes).toEqual([]);
  });
});

describe('isFlatProse', () => {
  it('is false when a unit is non-prose or nested', () => {
    const mathUnit: Unit = {
      id: 'm1',
      object_id: OBJ,
      position: 0,
      status: 'rough',
      declared_by: 'user',
      content: {
        kind: 'math',
        expr: {
          id: '0197675f-71f4-7000-8000-0000000000e4',
          surface_text: 'x',
          surface_format: 'mathmeander',
          original_input: 'x',
          parse_status: 'renderable',
          occurrences: [],
        },
      },
      provenance_id: '0197675f-71f4-7000-8000-0000000000d1',
    };
    expect(isFlatProse(content([mathUnit]))).toBe(false);
  });
});
