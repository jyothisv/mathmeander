// The inline-math recognizer plugin: scanning `$…$` text → the `mathExpr` identity mark + a synced expr,
// idempotently, with the §6.3a keystone (anchored exprs untouched) and copy-mints-fresh. Recognition runs on
// a doc edit (the plugin skips pure caret moves), so tests drive it through real transactions. The WASM
// runtime is stubbed (node has no WASM); `normalizeFresh` returns a fixed status so the sync is deterministic.
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Node } from 'prosemirror-model';

const h = vi.hoisted(() => ({
  normalizeFresh: vi.fn((input: string) => ({
    canonicalText: input,
    parseStatus: 'renderable' as const,
    occurrenceSites: [] as { name: string; span: { start: number; end: number } }[],
  })),
}));
vi.mock('./mathRuntime', () => ({
  isMathRuntimeReady: () => true,
  normalizeFresh: h.normalizeFresh,
}));

import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { mathRecognize } from './mathRecognize';

const MARK = editorSchema.marks.mathExpr;

function makeExpr(id: string, surface: string, occurrences = 0): MathExpression {
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

/** A text node, optionally carrying the mathExpr mark for `expr`. */
function txt(s: string, expr?: MathExpression): Node {
  return expr ? editorSchema.text(s, [MARK.create({ expr })]) : editorSchema.text(s);
}

function prose(...children: Node[]): Node {
  return editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, children),
  ]);
}

/** Build a state from `doc`, run `edit` (a doc-changing transaction), and return the recognized doc. */
function afterEdit(
  doc: Node,
  edit: (tr: ReturnType<EditorState['tr']['insertText']>) => void,
): Node {
  const state = EditorState.create({ schema: editorSchema, doc, plugins: [mathRecognize] });
  const tr = state.tr;
  edit(tr);
  return state.apply(tr).doc;
}

/** Type `text` into an empty prose block (the common case: fresh `$…$` typed in prose). */
function typed(text: string): Node {
  return afterEdit(prose(), (tr) => tr.insertText(text, 1));
}

/** The mathExpr-marked text spans of a recognized doc, in order. */
function marked(d: Node): { text: string; expr: MathExpression }[] {
  const out: { text: string; expr: MathExpression }[] = [];
  d.descendants((node) => {
    if (!node.isText) return;
    const m = node.marks.find((x) => x.type === MARK);
    if (m) out.push({ text: node.text ?? '', expr: m.attrs.expr as MathExpression });
  });
  return out;
}

describe('mathRecognize — applies the mark to recognized $…$', () => {
  it('marks a typed expression in surrounding prose, syncing the inner source', () => {
    const ms = marked(typed('let $x^2$ go'));
    expect(ms).toHaveLength(1);
    expect(ms[0]!.text).toBe('$x^2$');
    expect(ms[0]!.expr.surface_text).toBe('x^2');
    expect(ms[0]!.expr.id).toBeTruthy();
    expect(ms[0]!.expr.parse_status).toBe('renderable');
  });

  it('marks digit-leading math ($3x$) and leaves currency ($5 and $10) alone', () => {
    expect(marked(typed('$3x$'))[0]!.expr.surface_text).toBe('3x');
    expect(marked(typed('$5 and $10'))).toHaveLength(0);
  });

  it('does not mark an escaped \\$', () => {
    expect(marked(typed('\\$5'))).toHaveLength(0);
  });

  it('does not let math cross a hard break (recognition is per text run)', () => {
    const d = afterEdit(prose(txt('$x'), editorSchema.nodes.hard_break.create(), txt('y$')), (tr) =>
      tr.insertText(' ', 1),
    );
    expect(marked(d)).toHaveLength(0);
  });
});

describe('mathRecognize — identity', () => {
  it('is idempotent: an unrelated later edit does not re-mint the math id', () => {
    const once = typed('$x$'); // "$x$" → marked, id minted
    const id1 = marked(once)[0]!.expr.id;
    const again = afterEdit(once, (tr) => tr.insertText(' done', once.content.size)); // type after it
    expect(marked(again)[0]!.expr.id).toBe(id1);
  });

  it('preserves the id across an in-place edit (citations follow), resyncing the surface', () => {
    const a = makeExpr('id-A', 'x'); // "$x$" marked; type `y` between x and the closing $
    const ms = marked(afterEdit(prose(txt('$x$', a)), (tr) => tr.insertText('y', 3)));
    expect(ms[0]!.expr.id).toBe('id-A');
    expect(ms[0]!.expr.surface_text).toBe('xy');
  });

  it('copy-mints-fresh: a duplicated expr id is re-minted on the later occurrence', () => {
    const a = makeExpr('dup', 'a'); // two spans share id `dup` (an internal paste)
    const d = prose(txt('$a$', a), txt(' '), txt('$a$', a));
    const ms = marked(afterEdit(d, (tr) => tr.insertText(' ', d.content.size)));
    expect(ms).toHaveLength(2);
    expect(ms[0]!.expr.id).toBe('dup');
    expect(ms[1]!.expr.id).not.toBe('dup');
  });

  it('keystone: an anchored expr is never re-normalized in place (surface left as-is)', () => {
    const a = makeExpr('anc', 'x', 1); // anchored; text already shows "$xy$"
    const ms = marked(afterEdit(prose(txt('$xy$', a)), (tr) => tr.insertText(' ', 5)));
    expect(ms[0]!.expr.id).toBe('anc');
    expect(ms[0]!.expr.surface_text).toBe('x');
  });
});

describe('mathRecognize — non-destructive (never silently drops an intact equation)', () => {
  it('typing a digit right after a complete $x$ keeps it as math (the core regression)', () => {
    const a = makeExpr('keep', 'x'); // "$x$" at [1,4); type "2" right after the closing $
    const ms = marked(afterEdit(prose(txt('$x$', a)), (tr) => tr.insertText('2', 4)));
    expect(ms).toHaveLength(1);
    expect(ms[0]!.text).toBe('$x$'); // intact, not stripped or swallowed
    expect(ms[0]!.expr.id).toBe('keep'); // Inline::Math identity preserved
    expect(ms[0]!.expr.surface_text).toBe('x');
  });

  it('a digit + prose between two equations keeps both (no over-wide swallow)', () => {
    const a = makeExpr('ax', 'x');
    const b = makeExpr('by', 'y');
    // "$x$ and $y$" → type "2" right after the first $x$ (pos 4) → "$x$2 and $y$"
    const d = prose(txt('$x$', a), txt(' and ', undefined), txt('$y$', b));
    const ms = marked(afterEdit(d, (tr) => tr.insertText('2', 4)));
    expect(ms.map((m) => m.text)).toEqual(['$x$', '$y$']);
    expect(ms.map((m) => m.expr.id)).toEqual(['ax', 'by']);
  });

  it('a lone $ typed before a marked $x$ keeps the equation (the stray $ stays literal)', () => {
    const a = makeExpr('keep', 'x'); // insert "$" at the start (pos 1), before the marked $x$
    const ms = marked(afterEdit(prose(txt('$x$', a)), (tr) => tr.insertText('$', 1)));
    expect(ms).toHaveLength(1);
    expect(ms[0]!.text).toBe('$x$');
    expect(ms[0]!.expr.id).toBe('keep');
  });

  it('typing $$x$ fresh marks nothing ($$ is reserved for display math)', () => {
    expect(marked(typed('$$x$'))).toHaveLength(0);
  });

  it('keystone: deleting a CITED expr’s closing $ keeps the mark (surfaced, not dropped)', () => {
    const a = makeExpr('cited', 'x', 1); // anchored; delete the closing $ (pos 3..4) → "$x"
    const ms = marked(afterEdit(prose(txt('$x$', a)), (tr) => tr.delete(3, 4)));
    expect(ms).toHaveLength(1);
    expect(ms[0]!.expr.id).toBe('cited');
  });

  it('a FRESH span that loses its closing $ is released to plain text', () => {
    const a = makeExpr('fresh', 'x'); // fresh; delete the closing $ → "$x"
    expect(marked(afterEdit(prose(txt('$x$', a)), (tr) => tr.delete(3, 4)))).toHaveLength(0);
  });
});

describe('mathRecognize — fixpoint / no churn', () => {
  it('an unrelated edit leaves projected math byte-identical (no spurious re-mint/resync)', () => {
    const fresh = makeExpr('f1', 'x^2');
    const anch = makeExpr('a1', 'y', 1);
    const d = prose(
      txt('let ', undefined),
      txt('$x^2$', fresh),
      txt(' and ', undefined),
      txt('$y$', anch),
    );
    const ms = marked(afterEdit(d, (tr) => tr.insertText(' ok', d.content.size)));
    expect(ms.map((m) => m.expr.id)).toEqual(['f1', 'a1']);
    expect(ms.map((m) => m.expr.surface_text)).toEqual(['x^2', 'y']);
  });

  it('reuses an unchanged span verbatim — no parse_status recompute on an unrelated edit', () => {
    const a = makeExpr('v', 'x');
    h.normalizeFresh.mockClear();
    afterEdit(prose(txt('$x$', a)), (tr) => tr.insertText(' done', 4)); // edit AFTER the math
    expect(h.normalizeFresh).not.toHaveBeenCalled();
  });
});
