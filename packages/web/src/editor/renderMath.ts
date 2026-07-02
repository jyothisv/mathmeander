// Render a MathExpression into a DOM target with KaTeX. The KaTeX-input string always comes from the
// WASM/surface transpile (`toKatex`) — never a TS reimplementation of LaTeX (single source of truth).
// Un-parseable input is NEVER punished (§2.2): an `invalid` expression shows its `original_input` verbatim
// with a quiet warning affordance, so nothing the user typed is ever lost or hidden. If the WASM runtime
// failed to load, math degrades to source-only (verbatim, no KaTeX) rather than crashing.
import katex from 'katex';
import type { MathExpression } from '@mathmeander/schema';
import {
  toKatex,
  toKatexDisplay,
  toKatexScoped,
  toKatexScopedDisplay,
  isMathRuntimeReady,
  normalizeFresh,
  type NotationDef,
} from './mathRuntime';

/** Render `expr` into `into` (cleared first). `display` = block (centered) vs inline. `tagged` FORCES the
 *  `\htmlData`-tagged transpile even for inline (§6.2): an inline `$…$` normally uses the cheaper untagged
 *  transpile, but an inline expression carrying a brace annotation needs a `data-path` per sub-term so the
 *  overlay can resolve the bound sub-term's rect — done LAZILY (only annotated inline exprs pay the tagging
 *  cost + the narrow `\htmlData` trust; un-annotated inline math is unchanged). Display is always tagged. */
export function renderMathInto(
  expr: MathExpression,
  into: HTMLElement,
  opts: { display: boolean; scope?: NotationDef[]; tagged?: boolean },
): void {
  into.replaceChildren();
  into.classList.remove('math-invalid', 'math-partial');
  const text = expr.surface_text ?? '';
  const verbatim = expr.original_input || text;

  // Runtime unavailable → show the source as plain text (never call toKatex → never throw). Keeps the editor
  // usable (source-only math) when the WASM module fails to load.
  if (!isMathRuntimeReady()) {
    into.textContent = verbatim || '∅';
    return;
  }

  // The parse status is derived LIVE from the current grammar, never trusted from the stored field: an
  // expression authored under an older grammar carries a stale persisted `parse_status` (the reported
  // permanent amber underline on now-fully-parseable math) — the stored field is only the degraded-mode
  // fallback above (runtime down → no flag at all).
  const status = normalizeFresh(text).parseStatus;

  // Un-parseable or empty → show exactly what the user typed; never KaTeX-throw, never blank their input.
  if (status === 'invalid' || text.length === 0) {
    into.textContent = verbatim || '∅';
    if (verbatim) {
      into.classList.add('math-invalid');
      into.title = "couldn't parse this math — showing your original input";
    }
    return;
  }

  // DISPLAY (incl. system rows) uses the `\htmlData`-tagged transpile so the DOM carries a `data-path`
  // per sub-term (precise click, F3); inline keeps the cheaper untagged transpile. `trust` is SCOPED to
  // exactly the one command we emit (`\htmlData`) and ONLY on the display path — inline emits no trusted
  // command at all, so it gets `trust:false` (zero attack surface). Defense-in-depth atop the surface
  // emitter's escaping: even a future escaping gap or a new emitter command can't become an injection
  // vector (KaTeX rejects `\href`/`\url`/`\includegraphics`/etc.). `strict:false` silences its warning
  // on the custom data attr.
  // Notation-as-register: when the caller passes a document-scope registry, resolve triggers at RENDER
  // time (e.g. `Z*` → `ZZ^*` → ℤ*) — the literal source is unchanged. No scope → today's render.
  // Tagged when DISPLAY (always) OR when an inline expr is annotated (`tagged`) — both need `data-path` +
  // the narrow `\htmlData` trust. `displayMode` (block-centered vs inline) is INDEPENDENT of tagging, so an
  // annotated inline expr renders inline-sized yet path-tagged.
  const wantTagged = opts.display || opts.tagged === true;
  const scope = opts.scope;
  let katexInput: string;
  if (scope && scope.length > 0) {
    katexInput = wantTagged ? toKatexScopedDisplay(text, scope) : toKatexScoped(text, scope);
  } else {
    katexInput = wantTagged ? toKatexDisplay(text) : toKatex(text);
  }
  katex.render(katexInput, into, {
    displayMode: opts.display,
    throwOnError: false, // defense-in-depth; the surface transpile already escapes error fragments
    trust: wantTagged ? (ctx) => ctx.command === '\\htmlData' : false,
    strict: false,
  });

  // Partially parsed: it DOES render (the transpiler shows the bad fragments verbatim), but flag the partial
  // failure with a quiet affordance — distinct from the red `invalid` styling.
  if (status === 'partially_resolved') {
    into.classList.add('math-partial');
    into.title = 'part of this math could not be parsed — shown as typed';
  }
}
