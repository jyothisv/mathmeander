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
    CharSpan, ParseStatus, latex, normalize_fresh, parser, render, serializer,
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
