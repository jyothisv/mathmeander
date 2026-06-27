// Type `$` over a selection (mathWrap.ts). Locks: a `$` over a plain selection wraps it in `$…$`; a `$`
// over a selection that IS one inline equation upgrades it to a `$$…$$` display block; an empty selection
// returns false (the `$` types normally); a selection crossing a math span / atom is a swallowed no-op.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { wrapSelectionAsMath } from './mathWrap';
import { mathRecognize } from './mathRecognize';

const expr = (id: string, surface: string): MathExpression => ({
  id,
  surface_text: surface,
  surface_format: 'mathmeander',
  input_syntax: 'mathmeander',
  original_input: surface,
  parse_status: 'renderable',
  occurrences: [],
});

/** A doc of one prose block; `make` builds its inline content. Selection set to `[from,to]` (doc positions). */
function blockState(children: import('prosemirror-model').Node[], from: number, to: number): EditorState {
  const block = editorSchema.nodes.prose.create({ unitId: 'u1' }, children);
  const doc = editorSchema.nodes.doc.create(null, [block]);
  const base = EditorState.create({ schema: editorSchema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
}

function capture(s: EditorState): { ran: boolean; next: EditorState | null } {
  let tr: Transaction | null = null;
  const ran = wrapSelectionAsMath(s, (t) => {
    tr = t;
  });
  return { ran, next: tr ? s.apply(tr) : null };
}

describe('wrapSelectionAsMath — `$` over a selection', () => {
  it('wraps a plain selection in inline `$…$`', () => {
    // "hello world" — select "world" (content offsets 6..11 → doc pos 7..12)
    const s = blockState([editorSchema.text('hello world')], 7, 12);
    const { ran, next } = capture(s);
    expect(ran).toBe(true);
    expect(next!.doc.firstChild!.textContent).toBe('hello $world$');
  });

  it('returns false for an empty selection (the `$` types normally)', () => {
    const s = blockState([editorSchema.text('hello')], 3, 3);
    expect(wrapSelectionAsMath(s, () => {})).toBe(false);
  });

  it('upgrades a selection that IS one inline `$…$` equation to a `$$…$$` display block', () => {
    // a marked inline equation "$x$" (doc pos 1..4); select the whole run
    const math = editorSchema.text('$x$', [editorSchema.marks.mathExpr.create({ expr: expr('e1', 'x') })]);
    const s = blockState([math], 1, 4);
    const { ran, next } = capture(s);
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.textContent).toBe('$$x$$');
  });

  it('the upgraded `$$x$$` is recognized as display (id reused) when mathRecognize runs', () => {
    const math = editorSchema.text('$x$', [editorSchema.marks.mathExpr.create({ expr: expr('e1', 'x') })]);
    const block = editorSchema.nodes.prose.create({ unitId: 'u1' }, [math]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc, plugins: [mathRecognize] });
    const s = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 4)));
    let tr: Transaction | null = null;
    wrapSelectionAsMath(s, (t) => (tr = t));
    const next = s.apply(tr!);
    const mark = next.doc.firstChild!.firstChild!.marks.find((m) => m.type.name === 'mathExpr');
    expect(mark?.attrs.display).toBe(true);
    expect((mark!.attrs.expr as MathExpression).id).toBe('e1'); // identity preserved across the upgrade
  });

  it('does NOT upgrade a MID-LINE inline equation (would inject stray `$` into the prose) — M2', () => {
    // "foo $x$ bar": select the `$x$` run; pressing `$` must be a no-op (the equation isn't whole-line, so
    // it can't become a display block — upgrading would bake stray `$` into the prose).
    const a = editorSchema.text('foo ');
    const math = editorSchema.text('$x$', [editorSchema.marks.mathExpr.create({ expr: expr('e1', 'x') })]);
    const b = editorSchema.text(' bar');
    const s = blockState([a, math, b], 5, 8); // select "$x$" (doc pos 5..8)
    const { ran, next } = capture(s);
    expect(ran).toBe(true); // handled (swallowed)
    expect(next).toBeNull(); // no change — no stray `$`
  });

  it('does NOT upgrade an inline equation in a HEADING title (headings are never display) — M2', () => {
    const math = editorSchema.text('$x$', [editorSchema.marks.mathExpr.create({ expr: expr('e1', 'x') })]);
    const block = editorSchema.nodes.prose.create({ unitId: 'h', heading: true }, [
      editorSchema.text('# '),
      math,
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const s = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 3, 6))); // select "$x$"
    let tr: Transaction | null = null;
    const ran = wrapSelectionAsMath(s, (t) => {
      tr = t;
    });
    expect(ran).toBe(true);
    expect(tr).toBeNull(); // no-op in a heading
  });

  it('is a swallowed no-op when the selection crosses a math span (would leave stray `$`)', () => {
    // "a$x$b" with "$x$" marked; select "a$x" (crosses into the math) → no-op
    const a = editorSchema.text('a');
    const math = editorSchema.text('$x$', [editorSchema.marks.mathExpr.create({ expr: expr('e1', 'x') })]);
    const b = editorSchema.text('b');
    const s = blockState([a, math, b], 1, 4); // "a" + first two chars of the math
    const { ran, next } = capture(s);
    expect(ran).toBe(true); // handled (swallowed)
    expect(next).toBeNull(); // but no transaction dispatched → no stray delimiters
  });
});
