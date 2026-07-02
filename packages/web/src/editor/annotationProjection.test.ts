import { describe, expect, it } from 'vitest';
import type { AnnotationDetail, AnnotationTarget, MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import {
  annotationIntents,
  annotationSig,
  docAnnotationDrafts,
  serverAnnotationSigs,
} from './projection';

const ANNO = editorSchema.marks.annoRef;
const MATH = editorSchema.marks.mathExpr;

function proseAnno(unitId: string) {
  // "the discriminant" with an overbrace over the phrase "discriminant" (code points 4..16).
  return editorSchema.nodes.prose.create({ unitId }, [
    editorSchema.text('the '),
    editorSchema.text('discriminant', [
      ANNO.create({
        annotationId: 'ann-prose',
        targetId: 'tgt-prose',
        kind: 'underbrace',
        gap: 'small',
        label: 'the disc.',
        extent: { kind: 'prose_span' },
      }),
    ]),
  ]);
}

function inlineMathExpr(): MathExpression {
  return {
    id: 'expr-1',
    surface_text: 'x^2 + y',
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: 'x^2 + y',
    parse_status: 'renderable',
    occurrences: [],
  };
}

function mathSubTermAnno(unitId: string) {
  const expr = inlineMathExpr();
  return editorSchema.nodes.prose.create({ unitId }, [
    editorSchema.text('see '),
    editorSchema.text('$x^2 + y$', [
      MATH.create({ expr }),
      ANNO.create({
        annotationId: 'ann-math',
        targetId: 'tgt-math',
        kind: 'overbrace',
        gap: 'medium',
        label: 'the square',
        extent: { kind: 'sub_term', expressionId: 'expr-1', termPath: [0] },
      }),
    ]),
  ]);
}

describe('annotation projection seam (§6.2)', () => {
  it('derives a prose-phrase annotation whose prose_span matches the mark range', () => {
    const doc = editorSchema.nodes.doc.create(null, [proseAnno('u1')]);
    const drafts = docAnnotationDrafts(doc);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.annotation_id).toBe('ann-prose');
    expect(d.primitives[0]).toEqual({
      kind: 'underbrace',
      label: { text: 'the disc.', inline: [] },
      gap: 'small',
    });
    const t = d.targets[0]!;
    expect(t.target_unit_id).toBe('u1');
    expect(t.role).toBe('target');
    expect(t.extent).toEqual({
      kind: 'locator',
      locator: { kind: 'prose_span', start: 4, end: 16 },
    });
  });

  it('derives a math sub-term annotation from the stored structural path (zero-width in prose)', () => {
    const doc = editorSchema.nodes.doc.create(null, [mathSubTermAnno('u2')]);
    const drafts = docAnnotationDrafts(doc);
    expect(drafts).toHaveLength(1);
    const t = drafts[0]!.targets[0]!;
    expect(t.target_unit_id).toBe('u2');
    expect(t.extent).toEqual({ kind: 'sub_term', expression_id: 'expr-1', term_path: [0] });
  });

  it('derives an expression-span annotation as an expression_span locator', () => {
    const expr = inlineMathExpr();
    const block = editorSchema.nodes.prose.create({ unitId: 'u3' }, [
      editorSchema.text('$x^2 + y$', [
        MATH.create({ expr }),
        ANNO.create({
          annotationId: 'ann-span',
          targetId: 'tgt-span',
          kind: 'overbrace',
          gap: 'small',
          label: 'a sub-chain',
          extent: { kind: 'expression_span', expressionId: 'expr-1', start: 2, end: 7 },
        }),
      ]),
    ]);
    const drafts = docAnnotationDrafts(editorSchema.nodes.doc.create(null, [block]));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.targets[0]!.extent).toEqual({
      kind: 'locator',
      locator: { kind: 'expression_span', expression_id: 'expr-1', start: 2, end: 7 },
    });
  });

  it('skips an annotation on a not-yet-persisted block (null unitId → defer)', () => {
    const block = editorSchema.nodes.prose.create({ unitId: null }, [
      editorSchema.text('x', [
        ANNO.create({
          annotationId: 'a',
          targetId: 't',
          kind: 'overbrace',
          gap: 'small',
          label: '',
          extent: { kind: 'prose_span' },
        }),
      ]),
    ]);
    expect(docAnnotationDrafts(editorSchema.nodes.doc.create(null, [block]))).toHaveLength(0);
  });

  it('round-trips against the server baseline: an unchanged annotation has no pending intent', () => {
    const doc = editorSchema.nodes.doc.create(null, [proseAnno('u1')]);
    const draft = docAnnotationDrafts(doc)[0]!;
    // The server rows that would result from persisting this draft.
    const details: AnnotationDetail[] = [{ object_id: 'ann-prose', primitives: draft.primitives }];
    const targets: AnnotationTarget[] = [
      {
        id: 'tgt-prose',
        annotation_id: 'ann-prose',
        role: 'target',
        position: 0,
        target_unit_id: 'u1',
        target_object_id: 'obj',
        extent: draft.targets[0]!.extent,
        status: 'active',
        provenance_id: 'prov',
      },
    ];
    const sigs = serverAnnotationSigs(details, targets);
    expect(sigs.get('ann-prose')).toBe(annotationSig(draft));
    expect(annotationIntents(doc, sigs)).toEqual([]);
  });

  it('flags a pending intent when the doc drops a server annotation, or changes one', () => {
    const doc = editorSchema.nodes.doc.create(null, [proseAnno('u1')]);
    // Server has a DIFFERENT annotation the doc no longer contains → a delete intent.
    const dropped = new Map([['gone', 'sig']]);
    expect(annotationIntents(doc, dropped)).toContain('gone');
    // Server has the same id but a stale sig → an upsert intent.
    const changed = new Map([['ann-prose', 'stale-sig']]);
    expect(annotationIntents(doc, changed)).toContain('ann-prose');
  });
});
