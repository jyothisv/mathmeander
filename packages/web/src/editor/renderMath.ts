// Render a MathExpression into a DOM target with KaTeX. The KaTeX-input string always comes from the
// WASM/surface transpile (`toKatex`) — never a TS reimplementation of LaTeX (single source of truth).
// Un-parseable input is NEVER punished (§2.2): an `invalid` expression shows its `original_input` verbatim
// with a quiet warning affordance, so nothing the user typed is ever lost or hidden.
import katex from 'katex';
import type { MathExpression } from '@mathmeander/schema';
import { toKatex } from './mathRuntime';

/** Render `expr` into `into` (cleared first). `display` = block (centered) vs inline. */
export function renderMathInto(
  expr: MathExpression,
  into: HTMLElement,
  opts: { display: boolean },
): void {
  into.replaceChildren();
  into.classList.remove('math-invalid');
  const text = expr.surface_text ?? '';
  if (expr.parse_status === 'invalid' || text.length === 0) {
    // show exactly what the user typed; never KaTeX-throw, never blank out their input
    into.textContent = expr.original_input || text || '∅';
    if (expr.original_input || text) {
      into.classList.add('math-invalid');
      into.title = "couldn't parse this math — showing your original input";
    }
    return;
  }
  katex.render(toKatex(text), into, {
    displayMode: opts.display,
    throwOnError: false, // defense-in-depth; the surface transpile already escapes error fragments
  });
}
