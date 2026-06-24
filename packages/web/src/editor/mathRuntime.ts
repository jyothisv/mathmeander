// The client math runtime — the editor parses/transpiles math LOCALLY via the WASM build of the owned
// `mathmeander-surface` crate (arch doc §5/§6.3a). No server round-trip, no TS reimplementation of the
// grammar (single source of truth): the same Rust parser/serializer/renderer the core uses. `initMathRuntime`
// MUST be awaited once (in main.tsx, before mount) before any other function here is called.
import init, {
  katex as wasmKatex,
  katexDisplay as wasmKatexDisplay,
  mathml as wasmMathml,
  latexImport as wasmLatexImport,
  normalizeFresh as wasmNormalizeFresh,
  surfacePaths as wasmSurfacePaths,
} from '../wasm/mathmeander_surface_wasm.js';
import type { ParseStatus } from '@mathmeander/schema';

let ready: Promise<void> | null = null;
let loaded = false;

/** Instantiate the WASM module once (idempotent). Awaited at app startup. The returned promise REJECTS if
 *  the module fails to load — callers (main.tsx) mount anyway and the editor degrades to source-only math
 *  (see `isMathRuntimeReady`), rather than crashing on first math use. */
export function initMathRuntime(): Promise<void> {
  if (!ready)
    ready = init().then(() => {
      loaded = true;
    });
  return ready;
}

/** Has the WASM module instantiated? When false, callers must NOT invoke the transpile/parse functions below
 *  (they would throw); render the math source verbatim and skip normalization instead. */
export function isMathRuntimeReady(): boolean {
  return loaded;
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

/** Like `toKatex`, but each sub-term is wrapped in `\htmlData{path=…}` → a `data-path` per node in the
 *  rendered DOM (precise click, F3). Render this with `katex.render {trust:true}`; pair with `surfacePaths`.
 *  Used for DISPLAY equations + SYSTEM rows; inline keeps the cheaper untagged `toKatex`. */
export function toKatexDisplay(surfaceText: string): string {
  return wasmKatexDisplay(surfaceText);
}

/** One sub-term's structural path + its char-span in the canonical surface (precise click, F3). */
export interface SurfacePath {
  path: number[];
  charSpan: { start: number; end: number };
}

/** Every sub-term's `(path, charSpan)` for `surfaceText` (precise click, F3). The spans index the SAME
 *  canonical string the editor holds, so a clicked `data-path` (from `toKatexDisplay`) maps to its source
 *  range here. */
export function surfacePaths(surfaceText: string): SurfacePath[] {
  return JSON.parse(wasmSurfacePaths(surfaceText)) as SurfacePath[];
}

/** Transpile a canonical surface to presentation MathML. */
export function toMathml(surfaceText: string): string {
  return wasmMathml(surfaceText);
}

/** Import LaTeX (lenient, total) → canonical `mathmeander` surface text. */
export function importLatex(latex: string): string {
  return wasmLatexImport(latex);
}
