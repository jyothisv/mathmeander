//! Surface-grammar vocabularies (arch doc §6.3a). Text-backed enums, the surface's home
//! for "which grammar", "how it was entered", and "is it usable per OUR parser". Relocated
//! from the core in slice 1b (the surface owns this vocabulary) and re-exported by the
//! core unchanged, so the schema artifact carries identical `$defs`.

use serde::{Deserialize, Serialize};

/// The grammar a `surface_text` is written in (arch doc §6.3a). `mathmeander` (our owned
/// grammar) is canonical; `latex` is retained for raw-imported/unnormalized surfaces;
/// `typst` and `asciimath` are reserved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SurfaceFormat {
    Mathmeander,
    Latex,
    Typst,
    Asciimath,
}

/// How an expression was entered/imported (arch doc §6.3a). Tri-state at the wire level:
/// *absent* (`Option::None`, never recorded) ≠ `unknown` (recorded, dialect undetermined);
/// migrations never backfill it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InputSyntax {
    Mathmeander,
    Latex,
    Typst,
    Asciimath,
    Unicode,
    Mixed,
    Unknown,
}

/// Whether a surface is usable, per OUR parser (arch doc §6.3a) — defined by `mathmeander`,
/// not LaTeX. Un-parseable input is never punished: it persists as `invalid` with
/// `original_input` intact (§2.2).
///
/// - `renderable`    — parses cleanly into a fully-formed AST.
/// - `partially_resolved` — parses, but with one or more recovered error fragments
///   (`Expr::Error`); still renderable, with the bad parts shown verbatim.
/// - `invalid`       — nothing usable parsed (e.g. empty after trimming, or all error).
/// - `unresolved`    — reserved for "parsed, but has unresolved occurrences/references"
///   (set by the core once occurrence resolution runs; the parser never emits it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Unresolved,
    Renderable,
    PartiallyResolved,
    Invalid,
}
