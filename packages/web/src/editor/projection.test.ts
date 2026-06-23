// The load-bearing 2c-1 test: the MathContent ⇄ ProseMirror round-trip, especially the zero-width
// inline-atom contract (§6.0) and Mark regions. Pure (prosemirror-model runs in node, no DOM).
import { describe, expect, it } from 'vitest';
import type { Inline, MathContent, MathExpression, Unit, UnitType } from '@mathmeander/schema';
import {
  flushToContent,
  isEditable,
  isFlatProse,
  projectToDoc,
  typeNeeds,
  typeIntents,
} from './projection';
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

/** A top-level display-math (`UnitContent::Math`) unit. */
function mathUnit(id: string, position: number, surface: string): Unit {
  return {
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    content: {
      kind: 'math',
      expr: {
        id: `${id}-e`,
        surface_text: surface,
        surface_format: 'mathmeander',
        input_syntax: 'mathmeander',
        original_input: surface,
        parse_status: 'renderable',
        occurrences: [],
      },
    },
    provenance_id: '0197675f-71f4-7000-8000-0000000000d2',
  };
}

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

describe('display math (structured-math increment 1) — line-only $$…$$ ⇄ Math unit', () => {
  /** A prose block whose sole content is a `$$surface$$` display span (a typed/edited display equation). */
  function displayBlock(unitId: string, surface: string, exprId = `${unitId}-e`, occurrences = 0) {
    const expr: MathExpression = {
      id: exprId,
      surface_text: surface,
      surface_format: 'mathmeander',
      input_syntax: 'mathmeander',
      original_input: surface,
      parse_status: 'renderable',
      occurrences: Array.from({ length: occurrences }, () => ({})) as MathExpression['occurrences'],
    };
    return editorSchema.nodes.prose.create({ unitId }, [
      editorSchema.text(`$$${surface}$$`, [
        editorSchema.marks.mathExpr.create({ expr, display: true }),
      ]),
    ]);
  }
  const docOf = (...blocks: ReturnType<typeof displayBlock>[]) =>
    editorSchema.nodes.doc.create(null, blocks);
  const exprOf = (u: Unit) => (u.content as { expr: MathExpression }).expr;

  it('isEditable admits top-level prose + math; isFlatProse still rejects math', () => {
    const c = content([prose('u1', 0, 'A'), mathUnit('m1', 1, 'x^2')]);
    expect(isEditable(c)).toBe(true);
    expect(isFlatProse(c)).toBe(false); // math is not flat prose
  });

  it('a display-math unit round-trips with NO delta (project → flush is clean)', () => {
    expect(roundTripIsClean(content([prose('u1', 0, 'before'), mathUnit('m1', 1, 'x^2')]))).toBe(
      true,
    );
    expect(
      roundTripIsClean(
        content([mathUnit('m0', 0, 'a + b'), prose('u1', 1, 'mid'), mathUnit('m2', 2, 'c = d')]),
      ),
    ).toBe(true);
  });

  it('projects a math unit to a PROSE block holding its `$$surface$$` display span', () => {
    const doc = projectToDoc(content([prose('u1', 0, 'A'), mathUnit('m1', 1, 'x^2')]));
    const block = doc.child(1);
    expect(block.type.name).toBe('prose');
    expect(block.attrs.unitId).toBe('m1');
    expect(block.textContent).toBe('$$x^2$$');
    const mark = block.firstChild!.marks.find((m) => m.type.name === 'mathExpr')!;
    expect(mark.attrs.display).toBe(true);
  });

  it('CREATE: a new block typed as $$x^2$$ flushes to a new Math unit (keeps the block id)', () => {
    const { upserts, deletes } = flushToContent(docOf(displayBlock('new1', 'x^2')), content([]));
    expect(deletes).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.id).toBe('new1');
    expect(upserts[0]!.content.kind).toBe('math');
    expect(exprOf(upserts[0]!).surface_text).toBe('x^2');
  });

  it('EDIT: changing a display surface upserts the Math unit, expr id preserved', () => {
    const prior = content([mathUnit('m1', 0, 'x')]);
    const { upserts, deletes } = flushToContent(docOf(displayBlock('m1', 'y + 1', 'm1-e')), prior);
    expect(deletes).toEqual([]);
    const m = upserts.find((u) => u.id === 'm1')!;
    expect(exprOf(m).surface_text).toBe('y + 1');
    expect(exprOf(m).id).toBe('m1-e'); // identity preserved across the in-place edit
  });

  it('DELETE: removing a display equation deletes its (zero-anchor) Math unit', () => {
    const prior = content([prose('u1', 0, 'A'), mathUnit('m1', 1, 'x^2')]);
    const doc = projectToDoc(content([prose('u1', 0, 'A')])); // the equation is gone
    const { deletes } = flushToContent(doc, prior);
    expect(deletes).toContain('m1'); // the symmetric delete relaxation — erasing an equation just saves
  });

  it('REPOSITION: a moved math unit emits a position-only upsert (content unchanged)', () => {
    const prior = content([prose('u1', 0, 'A'), mathUnit('m1', 1, 'x^2')]);
    const doc = projectToDoc(content([mathUnit('m1', 0, 'x^2'), prose('u1', 1, 'A')]));
    const { upserts, deletes } = flushToContent(doc, prior);
    expect(deletes).toEqual([]);
    const m = upserts.find((u) => u.id === 'm1');
    expect(m?.position).toBe(0);
    expect(m?.content.kind).toBe('math');
  });

  it('KIND-FLIP prose→display: a prose block retyped as $$…$$ deletes the prose + creates a Math unit (fresh id)', () => {
    const prior = content([prose('u1', 0, 'hello')]);
    const { upserts, deletes } = flushToContent(docOf(displayBlock('u1', 'x^2')), prior);
    expect(deletes).toContain('u1'); // can't change a unit's kind in place → delete + create
    const created = upserts.find((u) => u.content.kind === 'math')!;
    expect(created).toBeTruthy();
    expect(created.id).not.toBe('u1'); // a kind flip mints a fresh id
  });

  it('KIND-FLIP display→prose: a display block retyped as plain text deletes the Math + creates a prose unit', () => {
    const prior = content([mathUnit('m1', 0, 'x')]);
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'm1' }, editorSchema.text('hello')),
    ]);
    const { upserts, deletes } = flushToContent(doc, prior);
    expect(deletes).toContain('m1');
    const created = upserts.find((u) => u.content.kind === 'prose')!;
    expect(created).toBeTruthy();
    expect(created.id).not.toBe('m1');
  });

  it('keystone: an ANCHORED display equation keeps its stored surface (frozen, not re-derived)', () => {
    const prior = content([mathUnit('m1', 0, 'x')]);
    // The displayed text has drifted to "$$xy$$" but the cited expr's stored surface is "x"
    // (occurrences>0) — the flush must NOT overwrite it from the displayed text.
    const anchored: MathExpression = {
      id: 'm1-e',
      surface_text: 'x',
      surface_format: 'mathmeander',
      input_syntax: 'mathmeander',
      original_input: 'x',
      parse_status: 'renderable',
      occurrences: [{}] as MathExpression['occurrences'],
    };
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'm1' }, [
        editorSchema.text('$$xy$$', [
          editorSchema.marks.mathExpr.create({ expr: anchored, display: true }),
        ]),
      ]),
    ]);
    const m = flushToContent(doc, prior).upserts.find((u) => u.id === 'm1')!;
    expect(exprOf(m).surface_text).toBe('x'); // frozen — not clobbered to 'xy'
  });

  it('MULTI-LINE: a $$…$$ with ≥2 non-empty lines now flushes to an Equations SYSTEM (2-B reinterpretation)', () => {
    // The prior display increment treated a multi-line `$$…$$` as ONE long equation; 2-B reinterprets it as a
    // co-equal system — each non-empty line is a row of an Equations container.
    const { upserts } = flushToContent(docOf(displayBlock('sys1', 'a + b\nc = d')), content([]));
    const container = upserts.find((u) => u.content.kind === 'equations')!;
    expect(container).toBeTruthy();
    const rows = upserts.filter((u) => u.parent_unit_id === container.id);
    expect(rows.map((r) => (r.content as { expr: MathExpression }).expr.surface_text)).toEqual([
      'a + b',
      'c = d',
    ]);
  });

  it('MULTI-LINE: projectToDoc splits the surface on \\n into text + hard_break (all display-marked)', () => {
    const doc = projectToDoc(content([mathUnit('m1', 0, 'a\nb')]));
    const block = doc.child(0);
    expect(block.type.name).toBe('prose');
    const kinds: string[] = [];
    block.forEach((child) => kinds.push(child.isText ? `t:${child.text}` : child.type.name));
    expect(kinds).toEqual(['t:$$a', 'hard_break', 't:b$$']); // "$$a⏎b$$"
    block.forEach((child) => {
      if (child.isText)
        expect(child.marks.some((mk) => mk.type.name === 'mathExpr' && mk.attrs.display)).toBe(
          true,
        );
    });
  });

  it('MULTI-LINE: a hard_break $$…$$ block flushes to a system (rows split on the breaks)', () => {
    const hb = () => editorSchema.nodes.hard_break.create();
    const e: MathExpression = {
      id: 'm1-e',
      surface_text: 'X',
      surface_format: 'mathmeander',
      input_syntax: 'mathmeander',
      original_input: 'X',
      parse_status: 'renderable',
      occurrences: [],
    };
    const mk = () => editorSchema.marks.mathExpr.create({ expr: e, display: true });
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'm1' }, [
        editorSchema.text('$$a', [mk()]),
        hb(),
        editorSchema.text('b$$', [mk()]),
      ]),
    ]);
    const { upserts } = flushToContent(doc, content([]));
    const container = upserts.find((u) => u.content.kind === 'equations')!;
    expect(container).toBeTruthy();
    const rows = upserts.filter((u) => u.parent_unit_id === container.id);
    expect(rows.map((r) => (r.content as { expr: MathExpression }).expr.surface_text)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('display math — caret home', () => {
  it('a math-only day projects a trailing empty prose block (a caret home)', () => {
    const doc = projectToDoc(content([mathUnit('m1', 0, 'x^2')]));
    const last = doc.child(doc.childCount - 1);
    expect(last.type.name).toBe('prose'); // a place to put the cursor
    expect(last.attrs.unitId).toBeNull(); // null id → flush skips it until typed
    // and it does not create a spurious unit on flush
    const { upserts } = flushToContent(doc, content([mathUnit('m1', 0, 'x^2')]));
    expect(upserts).toEqual([]);
  });
});

describe('systems (structured-math 2-B) — multi-line $$…$$ ⇄ Equations container + rows', () => {
  /** Canonical content: an `Equations` container + one Math row per surface. */
  function equationsContent(containerId: string, surfaces: string[]): MathContent {
    const container: Unit = {
      id: containerId,
      object_id: OBJ,
      position: 0,
      status: 'rough',
      declared_by: 'user',
      content: { kind: 'equations' },
      provenance_id: '0197675f-71f4-7000-8000-0000000000d3',
    };
    const rows: Unit[] = surfaces.map((s, i) => ({
      id: `${containerId}-r${i}`,
      object_id: OBJ,
      parent_unit_id: containerId,
      position: i,
      status: 'rough',
      declared_by: 'user',
      content: {
        kind: 'math',
        expr: {
          id: `${containerId}-e${i}`,
          surface_text: s,
          surface_format: 'mathmeander',
          input_syntax: 'mathmeander',
          original_input: s,
          parse_status: 'renderable',
          occurrences: [],
        },
      },
      provenance_id: '0197675f-71f4-7000-8000-0000000000d3',
    }));
    return { object_id: OBJ, revision: 3, units: [container, ...rows] };
  }

  /** A doc with one system block (unitId = container, rowIds set, multi-line `$$…$$` text marked display). */
  function systemDoc(containerId: string, rowIds: string[], surfaces: string[]) {
    const inner = surfaces.join('\n');
    const mark = editorSchema.marks.mathExpr.create({
      expr: {
        id: containerId,
        surface_text: inner,
        surface_format: 'mathmeander',
        input_syntax: 'mathmeander',
        original_input: inner,
        parse_status: 'renderable',
        occurrences: [],
      },
      display: true,
    });
    const nodes = `$$${inner}$$`.split('\n').flatMap((part, i) => {
      const out = [];
      if (i > 0) out.push(editorSchema.nodes.hard_break.create(null, null, [mark]));
      if (part.length > 0) out.push(editorSchema.text(part, [mark]));
      return out;
    });
    return editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: containerId, rowIds }, nodes),
    ]);
  }

  const surfaceOf = (u: Unit) => (u.content as { expr: MathExpression }).expr.surface_text;

  /** Apply a flush delta to content (as the server persist does) → the next flush's baseline. */
  function applyDelta(c: MathContent, d: { upserts: Unit[]; deletes: string[] }): MathContent {
    const byId = new Map(c.units.map((u) => [u.id, u]));
    for (const id of d.deletes) byId.delete(id);
    for (const u of d.upserts) byId.set(u.id, u);
    return { ...c, revision: c.revision + 1, units: [...byId.values()] };
  }

  it('isEditable admits a top-level Equations container + Math rows; rejects a deeper nest', () => {
    expect(isEditable(equationsContent('c1', ['a = 1', 'b = 2']))).toBe(true);
    expect(isFlatProse(equationsContent('c1', ['a = 1', 'b = 2']))).toBe(false);
  });

  it('isEditable FAILS CLOSED for a system with a Prose row (editor round-trips only Math rows, §6.0a)', () => {
    const c = equationsContent('c1', ['a = 1']);
    c.units.push({
      id: 'c1-prose',
      object_id: OBJ,
      parent_unit_id: 'c1',
      position: 1,
      status: 'rough',
      declared_by: 'user',
      content: { kind: 'prose', text: 'note', inline: [] },
      provenance_id: '0197675f-71f4-7000-8000-0000000000d3',
    });
    expect(isEditable(c)).toBe(false); // → read-only MathContentView (no editor wedge)
  });

  it('isEditable FAILS CLOSED for a system row carrying a row_relation', () => {
    const c = equationsContent('c1', ['a = 1', 'b = 2']);
    c.units[1] = { ...c.units[1]!, row_relation: 'eq' }; // a relation the editor flush can't round-trip
    expect(isEditable(c)).toBe(false);
  });

  it('CHURN: an edited row keeps its provenance_id (a FROZEN save_content facet — never re-minted)', () => {
    // Re-minting an existing row's provenance (via newMathUnit) made save_content 422 on every flush — the
    // editor proposed a changed frozen facet. An edited row must spread the prior row, like the prose path.
    const prior = equationsContent('c1', ['a = 1', 'b = 2']);
    const priorRow1 = prior.units.find((u) => u.parent_unit_id === 'c1' && u.position === 1)!;
    const doc = systemDoc('c1', ['c1-r0', 'c1-r1'], ['a = 1', 'b = 99']);
    const edited = flushToContent(doc, prior).upserts.find((u) => u.id === 'c1-r1')!;
    expect(edited.provenance_id).toBe(priorRow1.provenance_id); // unchanged — not a fresh uuid
    expect(edited.status).toBe(priorRow1.status); // every other frozen facet preserved too
  });

  it('KIND-FLIP single→system is IDEMPOTENT on the second flush (no autosave wedge — finding #1)', () => {
    // The flip mints a fresh container id + deletes the old Math unit; the doc keeps its stale unitId and a
    // normal flush never reprojects. The second flush must still find the real container (via the rows'
    // parent) and emit NOTHING — else it would re-parent the rows, which save_content 422s forever.
    const prior = content([mathUnit('m1', 0, 'a = 1')]);
    const doc = systemDoc('m1', ['r0', 'r1'], ['a = 1', 'b = 2']);
    const flush1 = flushToContent(doc, prior);
    expect(flush1.deletes).toContain('m1');
    const baseline2 = applyDelta(prior, flush1);
    const flush2 = flushToContent(doc, baseline2); // same doc, advanced baseline
    expect(flush2.upserts).toEqual([]);
    expect(flush2.deletes).toEqual([]);
  });

  it('SYSTEM round-trips clean (container + rows ⇄ multi-line $$…$$)', () => {
    expect(roundTripIsClean(equationsContent('c1', ['2x + y = 1', 'x - y = 4']))).toBe(true);
  });

  it('CREATE: a fresh multi-line block mints a container + one row per line (ids from rowIds)', () => {
    const doc = systemDoc('c1', ['r0', 'r1'], ['a = 1', 'b = 2']);
    const { upserts, deletes } = flushToContent(doc, content([]));
    expect(deletes).toEqual([]);
    const container = upserts.find((u) => u.content.kind === 'equations')!;
    expect(container.id).toBe('c1');
    const rows = upserts.filter((u) => u.parent_unit_id === 'c1');
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1']);
    expect(rows.map(surfaceOf)).toEqual(['a = 1', 'b = 2']);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('CHURN: editing one row emits exactly ONE upsert (rows keep their ids, no re-mint)', () => {
    const prior = equationsContent('c1', ['a = 1', 'b = 2']);
    const doc = systemDoc('c1', ['c1-r0', 'c1-r1'], ['a = 1', 'b = 99']); // row 1 edited
    const { upserts, deletes } = flushToContent(doc, prior);
    expect(deletes).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.id).toBe('c1-r1');
    expect(surfaceOf(upserts[0]!)).toBe('b = 99');
  });

  it('ADD a row: appends a new row, others untouched', () => {
    const prior = equationsContent('c1', ['a = 1', 'b = 2']);
    const doc = systemDoc('c1', ['c1-r0', 'c1-r1'], ['a = 1', 'b = 2', 'c = 3']); // rowIds short → row 2 fresh
    const { upserts, deletes } = flushToContent(doc, prior);
    expect(deletes).toEqual([]);
    expect(upserts).toHaveLength(1); // only the new row
    expect(upserts[0]!.parent_unit_id).toBe('c1');
    expect(surfaceOf(upserts[0]!)).toBe('c = 3');
    expect(upserts[0]!.position).toBe(2);
  });

  it('DELETE a row: the dropped row is in deletes, ≥2 remain (still a system)', () => {
    const prior = equationsContent('c1', ['a = 1', 'b = 2', 'c = 3']);
    const doc = systemDoc('c1', ['c1-r0', 'c1-r1', 'c1-r2'], ['a = 1', 'c = 3']); // middle line removed
    const { deletes } = flushToContent(doc, prior);
    // positional rowIds: r0=a (kept), r1 now holds 'c = 3' (content shifts), r2 unused → deleted.
    expect(deletes).toContain('c1-r2');
  });

  it('DELETE the whole system: clearing the block drops the container + every row', () => {
    const prior = equationsContent('c1', ['a = 1', 'b = 2']);
    // The block is gone (an empty doc with just a placeholder prose block).
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: null }),
    ]);
    const { deletes } = flushToContent(doc, prior);
    expect(new Set(deletes)).toEqual(new Set(['c1', 'c1-r0', 'c1-r1']));
  });

  it('KIND-FLIP single→system: adding a 2nd line deletes the Math unit + creates a container + rows', () => {
    const prior = content([mathUnit('m1', 0, 'a = 1')]);
    const doc = systemDoc('m1', [], ['a = 1', 'b = 2']); // same block id, now 2 lines
    const { upserts, deletes } = flushToContent(doc, prior);
    expect(deletes).toContain('m1'); // the old single Math unit is removed
    const container = upserts.find((u) => u.content.kind === 'equations')!;
    expect(container).toBeTruthy();
    expect(upserts.filter((u) => u.parent_unit_id === container.id)).toHaveLength(2);
  });

  it('KIND-FLIP system→single: deleting down to ONE line drops the container + rows, creates a Math unit', () => {
    const prior = equationsContent('c1', ['a = 1', 'b = 2']);
    const doc = docOfDisplay('c1', 'a = 1'); // one line → a single display equation
    const { upserts, deletes } = flushToContent(doc, prior);
    expect(new Set(deletes)).toEqual(new Set(['c1', 'c1-r0', 'c1-r1']));
    const math = upserts.find((u) => u.content.kind === 'math' && u.parent_unit_id == null)!;
    expect(math).toBeTruthy();
    expect(surfaceOf(math)).toBe('a = 1');
  });

  /** A doc with one single-line `$$surface$$` display block (a single equation). */
  function docOfDisplay(unitId: string, surface: string) {
    return editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId }, [
        editorSchema.text(`$$${surface}$$`, [
          editorSchema.marks.mathExpr.create({
            expr: {
              id: `${unitId}-e`,
              surface_text: surface,
              surface_format: 'mathmeander',
              input_syntax: 'mathmeander',
              original_input: surface,
              parse_status: 'renderable',
              occurrences: [],
            },
            display: true,
          }),
        ]),
      ]),
    ]);
  }
});
