// mathSync (text → attrs.expr mirror + abandoned-empty cleanup) — pure, no DOM. The WASM runtime is stubbed
// (node has no WebAssembly init): `normalizeFresh` echoes the text and flags `^^` as invalid, so we test the
// PLUGIN logic (drift detection, surface_text/original_input/parse_status write, empty-node cleanup), not the
// parser.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./mathRuntime', () => ({
  normalizeFresh: (input: string) => ({
    canonicalText: input,
    parseStatus: input.includes('^^') ? 'invalid' : 'renderable',
    occurrenceSites: [],
  }),
}));

import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { mathSync } from './mathSync';

function mathWith(text: string, expr: Partial<MathExpression>): Node {
  const full: MathExpression = {
    id: 'e',
    surface_text: '',
    surface_format: 'mathmeander',
    original_input: '',
    parse_status: 'renderable',
    occurrences: [],
    ...expr,
  };
  return editorSchema.nodes.inlineMath.create(
    { expr: full },
    text ? editorSchema.text(text) : null,
  );
}

/** Run mathSync's appendTransaction over a one-block doc (caret at `caret`). */
function sync(inline: Node[], caret: number): Node {
  const doc = editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, inline),
  ]);
  const state = EditorState.create({
    schema: editorSchema,
    doc,
    plugins: [mathSync],
    selection: TextSelection.create(doc, caret),
  });
  return state.apply(state.tr).doc;
}

function firstMath(doc: Node): Node | null {
  let m: Node | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'inlineMath') {
      m = n;
      return false;
    }
    return undefined;
  });
  return m;
}

describe('mathSync', () => {
  it('mirrors drifted source text into attrs.expr (surface_text / original_input / parse_status)', () => {
    // text "x^2" but a stale expr → mathSync re-syncs from the text.
    const doc = sync([editorSchema.text('ab'), mathWith('x^2', { surface_text: 'OLD' })], 1);
    const expr = firstMath(doc)!.attrs.expr as MathExpression;
    expect(expr.surface_text).toBe('x^2');
    expect(expr.original_input).toBe('x^2');
    expect(expr.parse_status).toBe('renderable');
  });

  it('records parse_status invalid for unparseable source (never lost)', () => {
    const doc = sync([editorSchema.text('ab'), mathWith('x^^', { surface_text: 'OLD' })], 1);
    const expr = firstMath(doc)!.attrs.expr as MathExpression;
    expect(expr.surface_text).toBe('x^^');
    expect(expr.parse_status).toBe('invalid');
  });

  it('leaves an already-in-sync node untouched (no churn)', () => {
    const doc = sync(
      [editorSchema.text('ab'), mathWith('x', { surface_text: 'x', original_input: 'x' })],
      1,
    );
    const expr = firstMath(doc)!.attrs.expr as MathExpression;
    expect(expr.surface_text).toBe('x');
  });

  it('drops an EMPTY math node when the caret is elsewhere (abandoned `$`)', () => {
    const doc = sync([editorSchema.text('ab'), mathWith('', {})], 1); // caret in prose, not in the math
    expect(firstMath(doc)).toBeNull();
  });

  it('KEEPS an empty math node while the caret is inside it (the in-progress create)', () => {
    const doc = sync([mathWith('', {})], 2); // caret inside the empty math (pos 2)
    expect(firstMath(doc)).not.toBeNull();
  });
});
