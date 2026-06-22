// The load-bearing 2c-1 test: the MathContent ⇄ ProseMirror round-trip, especially the zero-width
// inline-atom contract (§6.0) and Mark regions. Pure (prosemirror-model runs in node, no DOM).
import { describe, expect, it } from 'vitest';
import type { Inline, MathContent, MathExpression, Unit, UnitType } from '@mathmeander/schema';
import { flushToContent, isFlatProse, projectToDoc, typeNeeds, typeIntents } from './projection';
import { editorSchema } from './schema';

const OBJ = '0197675f-71f4-7000-8000-000000000001';

function prose(
  id: string,
  position: number,
  text: string,
  inline: Inline[] = [],
  type?: UnitType,
): Unit {
  return {
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    ...(type ? { type } : {}),
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

  it('inline math is literal $…$ text carrying the mathExpr mark; prose text stays 0-width', () => {
    // slice 2d editable-syntax: the math source is LITERAL `$…$` text (editable + copy/pasteable), tagged
    // with the mathExpr mark that carries the expr identity. It still contributes 0 chars to the canonical
    // prose text — the span stays [p, p] and the round-trip is clean (the `$…$` is stripped at the seam).
    const expr: MathExpression = {
      id: '0197675f-71f4-7000-8000-0000000000e4',
      surface_text: 'x^2 + y',
      surface_format: 'mathmeander',
      original_input: 'x^2 + y',
      parse_status: 'renderable',
      occurrences: [],
    };
    const src = content([
      prose('u1', 0, 'a b', [{ kind: 'math', span: { start: 2, end: 2 }, expr }]),
    ]);
    const doc = projectToDoc(src);
    let mathNode: import('prosemirror-model').Node | null = null;
    doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'mathExpr')) {
        mathNode = n;
        return false;
      }
      return undefined;
    });
    expect(mathNode).not.toBeNull();
    expect(mathNode!.text).toBe('$x^2 + y$'); // literal, editable, copy/pasteable source
    expect(roundTripIsClean(src)).toBe(true); // stripped to a zero-width Math at [2,2]
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

  it('does not re-upsert a unit whose server content keys differ in ORDER (wire vs local)', () => {
    // The server's zod-parsed content can serialize as {text, inline, kind}; the editor builds
    // {kind, text, inline}. Change-detection must be key-order-INDEPENDENT — otherwise a just-saved
    // unit looks "changed" and the editor re-upserts it on every idle cycle (never settling).
    const wireUnit: Unit = {
      id: 'u1',
      object_id: OBJ,
      position: 0,
      status: 'rough',
      declared_by: 'user',
      content: { text: 'Status check.', inline: [], kind: 'prose' }, // kind LAST (wire order)
      provenance_id: '0197675f-71f4-7000-8000-0000000000d1',
    };
    const c: MathContent = { object_id: OBJ, revision: 2, units: [wireUnit] };
    const { upserts, deletes } = flushToContent(projectToDoc(c), c);
    expect(upserts).toEqual([]);
    expect(deletes).toEqual([]);
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

describe('type round-trip + typeNeeds (2c-2)', () => {
  it('a typed unit causes NO spurious upsert (type is not part of the prose delta)', () => {
    expect(roundTripIsClean(content([prose('u1', 0, 'Pythagoras.', [], 'theorem')]))).toBe(true);
  });

  it('editing a typed unit preserves its type UNCHANGED in the upsert (save_content-safe)', () => {
    const prior = content([prose('u1', 0, 'Pythagoras.', [], 'theorem')]);
    const doc = projectToDoc(content([prose('u1', 0, 'Pythagoras!!', [], 'theorem')]));
    const { upserts } = flushToContent(doc, prior);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.type).toBe('theorem'); // preserved from prior, never changed by the prose flush
  });

  it('typeNeeds emits a set when the doc type differs from the server', () => {
    const server = content([prose('u1', 0, 'Pythagoras.')]); // untyped on the server
    const doc = projectToDoc(content([prose('u1', 0, 'Pythagoras.', [], 'theorem')]));
    expect(typeNeeds(doc, server)).toEqual([{ unitId: 'u1', type: 'theorem' }]);
  });

  it('typeNeeds emits a clear (null) when the doc cleared a server type', () => {
    const server = content([prose('u1', 0, 'Pythagoras.', [], 'theorem')]);
    const doc = projectToDoc(content([prose('u1', 0, 'Pythagoras.')]));
    expect(typeNeeds(doc, server)).toEqual([{ unitId: 'u1', type: null }]);
  });

  it('typeNeeds is empty when types match, and skips a unit not yet on the server', () => {
    const server = content([prose('u1', 0, 'A', [], 'lemma')]);
    expect(typeNeeds(projectToDoc(content([prose('u1', 0, 'A', [], 'lemma')])), server)).toEqual(
      [],
    );
    const withNew = projectToDoc(
      content([prose('u1', 0, 'A', [], 'lemma'), prose('u2', 1, 'B', [], 'theorem')]),
    );
    expect(typeNeeds(withNew, server)).toEqual([]); // u2 not persisted yet → skipped
  });
});

describe('multi-line prose (2c-2 hard_break ↔ \\n)', () => {
  it('a prose unit with line breaks round-trips', () => {
    expect(roundTripIsClean(content([prose('u1', 0, 'line one\nline two\nthree')]))).toBe(true);
  });

  it('an inline atom after a line break keeps its code-point offset', () => {
    const expr: MathExpression = {
      id: '0197675f-71f4-7000-8000-0000000000e9',
      surface_text: 'x',
      surface_format: 'mathmeander',
      original_input: 'x',
      parse_status: 'renderable',
      occurrences: [],
    };
    const c = content([
      prose('u1', 0, 'a\nb', [{ kind: 'math', span: { start: 2, end: 2 }, expr }]),
    ]);
    expect(roundTripIsClean(c)).toBe(true);
  });
});

describe('typeIntents vs typeNeeds (2c-2)', () => {
  it('typeIntents INCLUDES a brand-new cued unit not in baseline; typeNeeds SKIPS it', () => {
    const baseline = content([prose('u1', 0, 'A')]); // u2 not yet persisted
    const doc = projectToDoc(content([prose('u1', 0, 'A'), prose('u2', 1, 'B', [], 'theorem')]));
    expect(typeIntents(doc, baseline)).toEqual([{ unitId: 'u2', type: 'theorem' }]);
    expect(typeNeeds(doc, baseline)).toEqual([]); // server-absent → skipped (can't set_unit_type yet)
  });

  it('typeIntents EXCLUDES an untouched unit (doc == baseline) so a foreign retype is preserved', () => {
    const baseline = content([prose('u1', 0, 'A', [], 'theorem')]);
    const doc = projectToDoc(content([prose('u1', 0, 'A', [], 'theorem')])); // I did not touch u1
    expect(typeIntents(doc, baseline)).toEqual([]); // no pending intent → keepTypes won't clobber theirs
  });

  it('typeIntents reports a pending clear (null) on a unit I de-typed', () => {
    const baseline = content([prose('u1', 0, 'A', [], 'theorem')]);
    const doc = projectToDoc(content([prose('u1', 0, 'A')])); // type cleared in the doc
    expect(typeIntents(doc, baseline)).toEqual([{ unitId: 'u1', type: null }]);
  });
});

describe('flush — surface_text keystone guard (§6.3a)', () => {
  function mathExprOf(id: string, surface: string, occurrences = 0): MathExpression {
    return {
      id,
      surface_text: surface,
      surface_format: 'mathmeander',
      input_syntax: 'mathmeander',
      original_input: surface,
      parse_status: 'renderable',
      occurrences: Array.from({ length: occurrences }, () => ({})) as MathExpression['occurrences'],
    };
  }
  /** A doc with a single prose unit whose only content is a `mathExpr`-marked text node. */
  function docWithMath(displayed: string, expr: MathExpression) {
    return editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'u1' }, [
        editorSchema.text(displayed, [editorSchema.marks.mathExpr.create({ expr })]),
      ]),
    ]);
  }
  const flushedMath = (displayed: string, expr: MathExpression): MathExpression => {
    const { upserts } = flushToContent(docWithMath(displayed, expr), content([prose('u1', 0, '')]));
    const inline = (upserts[0]!.content as { inline: Inline[] }).inline;
    return (inline.find((i) => i.kind === 'math') as { expr: MathExpression }).expr;
  };

  it('an ANCHORED expr keeps its stored surface_text (never overwritten from displayed text)', () => {
    // displayed "$xy$" but the cited surface is "x" — must NOT be clobbered to "xy".
    expect(flushedMath('$xy$', mathExprOf('a1', 'x', 1)).surface_text).toBe('x');
  });

  it('a FRESH expr rebuilds surface_text from the displayed text', () => {
    expect(flushedMath('$xy$', mathExprOf('f1', 'x')).surface_text).toBe('xy');
  });
});
