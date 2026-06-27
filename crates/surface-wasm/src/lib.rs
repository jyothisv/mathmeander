//! mathmeander-surface-wasm — the browser seam over `mathmeander-surface` (arch doc §5).
//!
//! Mirrors `crates/core-node` (the napi seam) for the web: every `#[wasm_bindgen]` function is a
//! one-line delegation into `mathmeander_surface`, with strings crossing the boundary (JSON for the
//! structured `normalizeFresh` result, plain strings for the render/import adapters). Keeping
//! wasm-bindgen here — never in `mathmeander-surface` — is what keeps the surface crate pure and
//! WASM-clean (the cargo-tree purity guard audits `surface`, not this wrapper).
//!
//! The editor parses/transpiles/renders math LOCALLY via this module — no server round-trip — so
//! recognition, live render, and offline are all on the table, and the parser stays single-source
//! (the Rust grammar), never reimplemented in TypeScript.
use mathmeander_surface::{
    CharSpan, ParseStatus, latex, normalize_fresh, notation, parser, path, render, serializer,
};
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
struct OccurrenceSiteDto {
    name: String,
    span: CharSpan,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedDto {
    canonical_text: String,
    parse_status: ParseStatus,
    occurrence_sites: Vec<OccurrenceSiteDto>,
}

/// Normalize FRESH input (the keystone before-anchors path, §6.3a) → JSON
/// `{ canonicalText, parseStatus, occurrenceSites }`. Safe ONLY while an expression has zero
/// anchors; the editor commit-guards on `occurrences.length === 0` and routes anchored edits to
/// the core's `rewrite_surface` op instead.
#[wasm_bindgen(js_name = normalizeFresh)]
pub fn normalize_fresh_js(input: &str) -> String {
    let n = normalize_fresh(input);
    let dto = NormalizedDto {
        canonical_text: n.text,
        parse_status: n.status,
        occurrence_sites: n
            .occurrence_sites
            .into_iter()
            .map(|s| OccurrenceSiteDto {
                name: s.name,
                span: s.span,
            })
            .collect(),
    };
    serde_json::to_string(&dto).unwrap_or_else(|_| "{}".to_string())
}

/// Transpile a canonical `mathmeander` surface to a KaTeX-input (LaTeX-flavored) string.
#[wasm_bindgen]
pub fn katex(surface_text: &str) -> String {
    render::katex(&parser::parse(surface_text))
}

/// Like `katex`, but each sub-term is wrapped in `\htmlData{path=…}` so the rendered DOM carries a
/// `data-path` per node (precise click, F3). The frontend renders this with `katex.render
/// {trust:true}`; pair with `surfacePaths` to map a clicked `data-path` → its source char-span.
#[wasm_bindgen(js_name = katexDisplay)]
pub fn katex_display(surface_text: &str) -> String {
    render::katex_with_paths(&parser::parse(surface_text))
}

#[derive(serde::Deserialize)]
struct NotationDefDto {
    trigger: String,
    expansion: String,
}

/// Build a `NotationScope` from JSON `[{ "trigger": "Z*", "expansion": "ZZ^*" }, …]` (definition
/// order). Malformed JSON degrades to the empty scope (render unchanged) — never crashes.
fn parse_notation_scope(scope_json: &str) -> notation::NotationScope {
    let defs: Vec<NotationDefDto> = serde_json::from_str(scope_json).unwrap_or_default();
    let pairs: Vec<(String, String)> = defs.into_iter().map(|d| (d.trigger, d.expansion)).collect();
    notation::NotationScope::from_definitions(&pairs)
}

/// Like `katex`, but a document-scope NOTATION registry (JSON) is applied at RENDER time: the literal
/// `surface_text` is unchanged; matched triggers render as their expansion (notation-as-register, §6.3a).
#[wasm_bindgen(js_name = katexScoped)]
pub fn katex_scoped(surface_text: &str, scope_json: &str) -> String {
    let scope = parse_notation_scope(scope_json);
    render::katex(&notation::resolve_notation(
        &parser::parse(surface_text),
        &scope,
    ))
}

/// `katexDisplay` + notation resolution (display/system equations).
#[wasm_bindgen(js_name = katexScopedDisplay)]
pub fn katex_scoped_display(surface_text: &str, scope_json: &str) -> String {
    let scope = parse_notation_scope(scope_json);
    render::katex_with_paths(&notation::resolve_notation(
        &parser::parse(surface_text),
        &scope,
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfacePathDto {
    path: Vec<usize>,
    char_span: CharSpan,
}

/// Every sub-term's `StructuralPath` (as a `number[]`) + its `CharSpan` in the VERBATIM
/// `surface_text` → JSON `[{ path, charSpan }]` (precise click / sub-expression annotation, F3).
/// The spans index `surface_text` EXACTLY as the editor holds it (each AST node carries the source
/// range it was parsed from), so the mapping is robust to any input shape — spacing, brackets,
/// packing. A clicked `data-path` (from `katexDisplay`) looks up its source span here.
#[wasm_bindgen(js_name = surfacePaths)]
pub fn surface_paths(surface_text: &str) -> String {
    let dtos: Vec<SurfacePathDto> = path::verbatim_paths(surface_text)
        .into_iter()
        .map(|(p, span)| SurfacePathDto {
            path: p.0,
            char_span: span,
        })
        .collect();
    serde_json::to_string(&dtos).unwrap_or_else(|_| "[]".to_string())
}

/// Transpile a canonical surface to presentation MathML.
#[wasm_bindgen]
pub fn mathml(surface_text: &str) -> String {
    render::mathml(&parser::parse(surface_text))
}

/// Import LaTeX (lenient, total) → canonical `mathmeander` surface text.
#[wasm_bindgen(js_name = latexImport)]
pub fn latex_import(latex_src: &str) -> String {
    serializer::serialize(&latex::import(latex_src))
}
