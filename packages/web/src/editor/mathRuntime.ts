// The client math runtime — the editor parses/transpiles math LOCALLY via the WASM build of the owned
// `mathmeander-surface` crate (arch doc §5/§6.3a). No server round-trip, no TS reimplementation of the
// grammar (single source of truth): the same Rust parser/serializer/renderer the core uses. `initMathRuntime`
// MUST be awaited once (in main.tsx, before mount) before any other function here is called.
import init, {
  katex as wasmKatex,
  mathml as wasmMathml,
  latexImport as wasmLatexImport,
  normalizeFresh as wasmNormalizeFresh,
} from '../wasm/mathmeander_surface_wasm.js';
import type { ParseStatus } from '@mathmeander/schema';

let ready: Promise<void> | null = null;

/** Instantiate the WASM module once (idempotent). Awaited at app startup. */
export function initMathRuntime(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

/** The result of `normalizeFresh` (the keystone before-anchors normalization). */
export interface NormalizedMath {
  canonicalText: string;
  parseStatus: ParseStatus;
  occurrenceSites: { name: string; span: { start: number; end: number } }[];
}

/** Canonicalize FRESH input (no anchors yet) → canonical surface + parse status. The ONLY normalization
 *  path; anchored expressions (a later occurrence slice) route through the core's `rewrite_surface` op. */
export function normalizeFresh(input: string): NormalizedMath {
  return JSON.parse(wasmNormalizeFresh(input)) as NormalizedMath;
}

/** Transpile a canonical surface to a KaTeX-input (LaTeX-flavored) string. */
export function toKatex(surfaceText: string): string {
  return wasmKatex(surfaceText);
}

/** Transpile a canonical surface to presentation MathML. */
export function toMathml(surfaceText: string): string {
  return wasmMathml(surfaceText);
}

/** Import LaTeX (lenient, total) → canonical `mathmeander` surface text. */
export function importLatex(latex: string): string {
  return wasmLatexImport(latex);
}
