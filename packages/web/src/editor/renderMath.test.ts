// renderMathInto branch coverage (§2.2 + runtime-down + partial). KaTeX and the WASM runtime are stubbed
// (node has no DOM and no WASM init), so this exercises the FALLBACK/affordance logic — the real parse +
// KaTeX/MathML transpile is covered by the e2e suite (the real-WASM boundary needs a browser).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ render: vi.fn(), ready: true }));
vi.mock('katex', () => ({ default: { render: h.render } }));
vi.mock('./mathRuntime', () => ({
  isMathRuntimeReady: () => h.ready,
  toKatex: (s: string) => s,
  toKatexDisplay: (s: string) => `D:${s}`, // the `\htmlData`-tagged transpile (distinct from toKatex)
}));

import type { MathExpression } from '@mathmeander/schema';
import { renderMathInto } from './renderMath';

function fakeInto() {
  const classes = new Set<string>();
  return {
    textContent: '',
    title: '',
    replaceChildren() {
      this.textContent = '';
    },
    classList: {
      add: (c: string) => classes.add(c),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    has: (c: string) => classes.has(c),
  };
}

function expr(over: Partial<MathExpression>): MathExpression {
  return {
    id: 'e',
    surface_text: 'x',
    surface_format: 'mathmeander',
    original_input: 'x',
    parse_status: 'renderable',
    occurrences: [],
    ...over,
  };
}

beforeEach(() => {
  h.ready = true;
  h.render.mockClear();
});

describe('renderMathInto', () => {
  it('runtime not ready → shows the source verbatim, never calls KaTeX', () => {
    h.ready = false;
    const into = fakeInto();
    renderMathInto(expr({ surface_text: 'x^2', original_input: 'x^2' }), into as never, {
      display: false,
    });
    expect(into.textContent).toBe('x^2');
    expect(h.render).not.toHaveBeenCalled();
    expect(into.has('math-invalid')).toBe(false); // not an error — just unrendered
  });

  it('invalid → shows original_input verbatim with the warning affordance, never calls KaTeX', () => {
    const into = fakeInto();
    renderMathInto(
      expr({ parse_status: 'invalid', surface_text: 'bad', original_input: 'bad' }),
      into as never,
      {
        display: false,
      },
    );
    expect(into.textContent).toBe('bad');
    expect(into.has('math-invalid')).toBe(true);
    expect(h.render).not.toHaveBeenCalled();
  });

  it('empty → shows the ∅ placeholder, never calls KaTeX', () => {
    const into = fakeInto();
    renderMathInto(expr({ surface_text: '', original_input: '' }), into as never, {
      display: false,
    });
    expect(into.textContent).toBe('∅');
    expect(h.render).not.toHaveBeenCalled();
  });

  it('renderable → calls KaTeX, no warning classes', () => {
    const into = fakeInto();
    renderMathInto(expr({ parse_status: 'renderable', surface_text: 'x' }), into as never, {
      display: false,
    });
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(into.has('math-invalid')).toBe(false);
    expect(into.has('math-partial')).toBe(false);
  });

  it('display → toKatexDisplay (tagged) with trust SCOPED to \\htmlData only', () => {
    const into = fakeInto();
    renderMathInto(expr({ parse_status: 'renderable', surface_text: 'x^2' }), into as never, {
      display: true,
    });
    expect(h.render).toHaveBeenCalledTimes(1);
    const [input, , opts] = h.render.mock.calls[0]!;
    expect(input).toBe('D:x^2'); // toKatexDisplay (NOT toKatex) — the `\htmlData`-tagged source
    expect(opts).toMatchObject({ displayMode: true, strict: false });
    // trust is a function that allows ONLY `\htmlData` — every other trusted command is rejected.
    expect(typeof opts.trust).toBe('function');
    expect(opts.trust({ command: '\\htmlData' })).toBe(true);
    expect(opts.trust({ command: '\\href' })).toBe(false);
    expect(opts.trust({ command: '\\includegraphics' })).toBe(false);
  });

  it('inline → toKatex (untagged) with trust:false (no trusted command emitted)', () => {
    const into = fakeInto();
    renderMathInto(expr({ parse_status: 'renderable', surface_text: 'x^2' }), into as never, {
      display: false,
    });
    const [input, , opts] = h.render.mock.calls[0]!;
    expect(input).toBe('x^2'); // toKatex — the cheaper untagged transpile for inline
    expect(opts).toMatchObject({ displayMode: false, trust: false });
  });

  it('partially_resolved → renders AND flags the partial affordance', () => {
    const into = fakeInto();
    renderMathInto(
      expr({ parse_status: 'partially_resolved', surface_text: 'x^^' }),
      into as never,
      {
        display: false,
      },
    );
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(into.has('math-partial')).toBe(true);
    expect(into.has('math-invalid')).toBe(false);
  });
});
