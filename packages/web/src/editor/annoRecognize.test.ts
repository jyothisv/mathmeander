import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { editorSchema } from './schema';
import { annoOccurrences, dedupePlan, annoRecognize } from './annoRecognize';

const ANNO = editorSchema.marks.annoRef;

function anno(id: string, extentKind: 'prose_span' | 'sub_term' = 'prose_span') {
  return ANNO.create({
    annotationId: id,
    targetId: `t-${id}`,
    kind: 'overbrace',
    gap: 'small',
    label: 'lbl',
    extent:
      extentKind === 'prose_span'
        ? { kind: 'prose_span' }
        : { kind: 'sub_term', expressionId: 'e', termPath: [0] },
  });
}

/** A doc of two prose blocks, each annotating its text with the given annotation ids. */
function docWith(ids: [string, string]) {
  const p = (id: string) =>
    editorSchema.nodes.prose.create({ unitId: `u-${id}` }, editorSchema.text('phrase', [anno(id)]));
  return editorSchema.nodes.doc.create(null, [p(ids[0]), p(ids[1])]);
}

describe('annoRecognize (§6.2 copy-mints-fresh)', () => {
  it('merges adjacent same-annotation text runs into one occurrence', () => {
    const block = editorSchema.nodes.prose.create({ unitId: 'u' }, [
      editorSchema.text('foo', [anno('a')]),
      editorSchema.text('bar', [anno('a'), editorSchema.marks.styled.create({ style: 'strong' })]),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const occ = annoOccurrences(doc);
    expect(occ).toHaveLength(1);
    expect(occ[0]!.annotationId).toBe('a');
  });

  it('keeps two distinct annotations as separate occurrences', () => {
    const occ = annoOccurrences(docWith(['a', 'b']));
    expect(occ.map((o) => o.annotationId)).toEqual(['a', 'b']);
  });

  it('plans a re-mint only for the DUPLICATE (second) occurrence, keeping the first id', () => {
    let n = 0;
    const fresh = () => `fresh-${n++}`;
    const plan = dedupePlan(annoOccurrences(docWith(['dup', 'dup'])), fresh);
    expect(plan).toHaveLength(1);
    // The re-minted range is the SECOND block; a fresh annotation + target id, not the shared 'dup'.
    expect(plan[0]!.annotationId).toBe('fresh-0');
    expect(plan[0]!.targetId).toBe('fresh-1');
  });

  it('re-mints a pasted duplicate annoRef through the plugin (the first keeps its id)', () => {
    const state = EditorState.create({ schema: editorSchema, doc: docWith(['dup', 'dup']) });
    const tr = annoRecognize.spec.appendTransaction!([], state, state);
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const ids: string[] = [];
    next.doc.descendants((node) => {
      const m = node.marks.find((x) => x.type === ANNO);
      if (m) ids.push(m.attrs.annotationId as string);
    });
    // Two occurrences, now with DISTINCT ids; the first is still 'dup'.
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('dup');
    expect(ids[1]).not.toBe('dup');
    expect(new Set(ids).size).toBe(2);
  });

  it('is a no-op when every annotation id is already unique', () => {
    const state = EditorState.create({ schema: editorSchema, doc: docWith(['a', 'b']) });
    expect(annoRecognize.spec.appendTransaction!([], state, state)).toBeNull();
  });
});

it('a MULTI-LINE display run (text + hard_breaks) is ONE occurrence — never shredded into duplicates', () => {
  // The regression: text-only adjacency split a `$$⏎(a+b)^2⏎$$` run at its hard_breaks into three
  // "duplicate" occurrences, which the copy-mints-fresh dedupe then wrongly re-minted — orphaning the
  // annotation (no brace drawn). Marked non-text inline leaves must CONTINUE the run.
  const MATHM = editorSchema.marks.mathExpr;
  const expr = {
    id: 'e1',
    surface_text: '\n(a+b)^2\n',
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: '',
    parse_status: 'renderable',
    occurrences: [],
  };
  const m = MATHM.create({ expr, display: true });
  const a = anno('A', 'sub_term');
  const block = editorSchema.nodes.prose.create({ unitId: 'u' }, [
    editorSchema.text('$$', [m, a]),
    editorSchema.nodes.hard_break.create(null, null, [m, a]),
    editorSchema.text('(a+b)^2', [m, a]),
    editorSchema.nodes.hard_break.create(null, null, [m, a]),
    editorSchema.text('$$', [m, a]),
  ]);
  const doc = editorSchema.nodes.doc.create(null, [block]);
  const occ = annoOccurrences(doc);
  expect(occ).toHaveLength(1);
  expect(occ[0]!.annotationId).toBe('A');
  // And the recognizer therefore has nothing to re-mint.
  const state = EditorState.create({ schema: editorSchema, doc });
  expect(annoRecognize.spec.appendTransaction!([], state, state)).toBeNull();
});

it('COEXISTENCE: two annoRef marks on ONE node yield two occurrences with correct ranges — no re-mint', () => {
  // `excludes: ''` lets annotations overlap; each id must surface as exactly one occurrence.
  const a = anno('inner', 'sub_term');
  const b = anno('outer', 'sub_term');
  const block = editorSchema.nodes.prose.create({ unitId: 'u' }, [
    editorSchema.text('pre ', [b]),
    editorSchema.text('mid', [a, b]),
    editorSchema.text(' post', [b]),
  ]);
  const doc = editorSchema.nodes.doc.create(null, [block]);
  const occ = annoOccurrences(doc);
  const byId = new Map(occ.map((o) => [o.annotationId, o]));
  expect(occ).toHaveLength(2);
  expect(byId.get('outer')).toMatchObject({ from: 1, to: 13 }); // the whole run
  expect(byId.get('inner')).toMatchObject({ from: 5, to: 8 }); // just 'mid'
  // Distinct ids → nothing to dedupe/re-mint.
  const state = EditorState.create({ schema: editorSchema, doc });
  expect(annoRecognize.spec.appendTransaction!([], state, state)).toBeNull();
});

it('COEXISTENCE: the dedupe re-mints ONLY the duplicated id, leaving a coexisting other annotation intact', () => {
  const dup = anno('dup', 'prose_span');
  const other = anno('other', 'prose_span');
  const block = (marks: (typeof dup)[]) =>
    editorSchema.nodes.prose.create({ unitId: `u${marks.length}` }, [
      editorSchema.text('word', marks),
    ]);
  const doc = editorSchema.nodes.doc.create(null, [block([dup, other]), block([dup])]);
  const state = EditorState.create({ schema: editorSchema, doc });
  const tr = annoRecognize.spec.appendTransaction!([], state, state);
  expect(tr).not.toBeNull();
  const next = state.apply(tr!);
  const ids: string[][] = [];
  next.doc.descendants((node) => {
    if (node.isText)
      ids.push(
        node.marks.filter((m) => m.type === ANNO).map((m) => m.attrs.annotationId as string),
      );
  });
  // Block 1 keeps BOTH 'dup' and 'other'; block 2's duplicate got a fresh id.
  expect(ids[0]).toContain('dup');
  expect(ids[0]).toContain('other');
  expect(ids[1]).toHaveLength(1);
  expect(ids[1]![0]).not.toBe('dup');
});
