//! `normalize_fresh` — the keystone before-anchors invariant (arch doc §6.3a). The
//! signature takes ONLY raw input and returns the canonical surface + status + occurrence
//! sites; it takes **no anchor/span parameter**, so it is *structurally impossible* for it
//! to remap-and-drop existing anchors. Normalization may run only on a FRESH expression
//! (zero occurrences, zero inbound anchors) — at input/paste time, before any anchor
//! exists. Once anchors exist, the only re-canonicalization path is `rewrite_with_remap`
//! (`rewrite.rs`), which is given the anchors explicitly and remaps them.

use crate::ast::Expr;
use crate::parser::parse;
use crate::serializer::{OccurrenceSite, serialize_with_sites};
use crate::status::ParseStatus;

/// The result of normalizing fresh input.
pub struct Normalized {
    /// The canonical `mathmeander` surface text.
    pub text: String,
    /// `parse_status` per OUR parser (§6.3a).
    pub status: ParseStatus,
    /// Coarse identifier occurrence sites in `text` (resolution-ready; the core turns
    /// these into occurrence edges, §6.1b).
    pub occurrence_sites: Vec<OccurrenceSite>,
}

/// Normalize fresh input into the canonical surface (no anchors may exist yet — enforced
/// by the absence of a span parameter, the keystone invariant).
pub fn normalize_fresh(input: &str) -> Normalized {
    let e = parse(input);
    let (text, occurrence_sites) = serialize_with_sites(&e);
    Normalized {
        text,
        status: parse_status(&e),
        occurrence_sites,
    }
}

/// Derive `parse_status` from a parsed tree (arch doc §6.3a):
///
/// - no content + no error → `renderable` (an empty surface renders to nothing);
/// - no content + error → `invalid` (nothing usable parsed);
/// - content + error → `partially_resolved` (good parts + recovered fragments);
/// - content + no error → `renderable`.
///
/// `unresolved` is never emitted by the parser — the core sets it once occurrence
/// resolution runs.
pub fn parse_status(e: &Expr) -> ParseStatus {
    match (e.has_content(), e.has_error()) {
        (false, false) => ParseStatus::Renderable,
        (false, true) => ParseStatus::Invalid,
        (true, true) => ParseStatus::PartiallyResolved,
        (true, false) => ParseStatus::Renderable,
    }
}
