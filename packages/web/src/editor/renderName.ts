// Render an authored-name SOURCE string (§6.3b) into an inline DOM element — `$…$` runs become KaTeX (when
// the math runtime is ready; raw source otherwise), the rest is plain text. The name's SOURCE is the truth
// (edited raw in the title input, rendered here on commit) — the same source-is-truth paradigm as `$…$` in
// the body, just at commit granularity. Shared by the title widget (typeTitle) and the citation display
// (referenceLivePreview), so a name with `$L^2$` renders identically wherever it appears.
import type { MathExpression } from '@mathmeander/schema';
import { findMathRegions } from './mathSyntax';
import { isMathRuntimeReady, normalizeFresh } from './mathRuntime';
import { renderMathInto } from './renderMath';

/** A render-only `MathExpression` for one `$…$` run (id irrelevant — names render from their source). */
function nameExpr(surface: string): MathExpression {
  return {
    id: '',
    surface_text: surface,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: surface,
    parse_status: isMathRuntimeReady() ? normalizeFresh(surface).parseStatus : 'renderable',
    occurrences: [],
  };
}

/** Render `source` into a fresh `<span>` (KaTeX for `$…$`, text otherwise). */
export function renderNameSource(source: string): HTMLSpanElement {
  const span = document.createElement('span');
  let cursor = 0;
  for (const r of findMathRegions(source)) {
    if (r.start > cursor) span.appendChild(document.createTextNode(source.slice(cursor, r.start)));
    const full = source.slice(r.start, r.end); // includes the `$…$` delimiters
    if (isMathRuntimeReady()) {
      const into = document.createElement('span');
      renderMathInto(nameExpr(full.slice(1, -1)), into, { display: false });
      span.appendChild(into);
    } else {
      span.appendChild(document.createTextNode(full)); // raw source until KaTeX loads
    }
    cursor = r.end;
  }
  if (cursor < source.length) span.appendChild(document.createTextNode(source.slice(cursor)));
  return span;
}
