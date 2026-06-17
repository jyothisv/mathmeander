//! Syntax adapters — the uniform seam for reading/writing math in MULTIPLE surface
//! syntaxes over the one canonical AST (arch doc §6.3a/§14). The crate is hub-and-spoke:
//! the `Expr` AST + canonical `mathmeander` text are the HUB; each `SurfaceFormat` is a
//! SPOKE with an adapter that `import`s (`&str → Expr`, total) and `export`s
//! (`Expr → String`). `mathmeander` is the canonical spoke (import = `parse`, export =
//! `serialize`); `latex` is a lossy adapter; `typst`/`asciimath` are reserved — no adapter
//! yet, so `adapter_for` returns `None`.
//!
//! Adding a syntax is deliberately a ONE-PLACE change: implement `SyntaxAdapter` for a new
//! zero-sized type and add its arm to `adapter_for`. Nothing in the core, the schema
//! artifact, or the `Expr` AST changes — an input method is an adapter, never new model
//! vocabulary or a new canonical op (arch doc §14).
//!
//! Keyed on `SurfaceFormat` (the grammar a `surface_text` is written in), NOT `InputSyntax`:
//! the latter also carries `unicode`/`mixed`/`unknown`, which are provenance facts about how
//! input arrived, not grammars with a clean round-trip (glyph→canonical-name normalization is
//! the notation registry's job, slice 2 — until then Unicode is tolerated as `Symbol`
//! passthrough, not a first-class adapter).

use crate::ast::Expr;
use crate::status::SurfaceFormat;
use crate::{latex, parser, serializer};

/// A reader/writer between one surface syntax and the canonical `Expr` AST. Both directions
/// are TOTAL and pure, matching the crate's discipline: `import` never fails (it recovers
/// un-parseable input as `Expr::Error`), `export` always produces a string. Object-safe, so
/// `adapter_for` can hand back a `&dyn SyntaxAdapter`.
pub trait SyntaxAdapter {
    /// The surface format this adapter handles.
    fn format(&self) -> SurfaceFormat;

    /// Parse text written in this syntax into the canonical AST (total — recovers, never
    /// fails). For `mathmeander` this is `parse`; an adapter syntax transliterates first.
    fn import(&self, input: &str) -> Expr;

    /// Render the canonical AST as text in this syntax. For `mathmeander` this is the
    /// canonical `serialize` (the stored normal form); adapter syntaxes may be lossy —
    /// full parity is a non-goal (§6.3a), with the core's `original_input` as the escape hatch.
    fn export(&self, expr: &Expr) -> String;
}

/// The canonical syntax: import = `parse`, export = `serialize` (the stored normal form).
struct Mathmeander;

impl SyntaxAdapter for Mathmeander {
    fn format(&self) -> SurfaceFormat {
        SurfaceFormat::Mathmeander
    }
    fn import(&self, input: &str) -> Expr {
        parser::parse(input)
    }
    fn export(&self, expr: &Expr) -> String {
        serializer::serialize(expr)
    }
}

/// LaTeX: a lossy import/export adapter (§6.3a). `mathmeander`-specific distinctions (e.g.
/// the inline `//`) collapse on export; `original_input` preserves the verbatim keystrokes.
struct Latex;

impl SyntaxAdapter for Latex {
    fn format(&self) -> SurfaceFormat {
        SurfaceFormat::Latex
    }
    fn import(&self, input: &str) -> Expr {
        latex::import(input)
    }
    fn export(&self, expr: &Expr) -> String {
        latex::export(expr)
    }
}

static MATHMEANDER: Mathmeander = Mathmeander;
static LATEX: Latex = Latex;

/// The adapter for a surface format, or `None` if it is reserved-but-unimplemented
/// (`typst`/`asciimath`). Adding one = implement `SyntaxAdapter` + a match arm here.
pub fn adapter_for(format: SurfaceFormat) -> Option<&'static dyn SyntaxAdapter> {
    match format {
        SurfaceFormat::Mathmeander => Some(&MATHMEANDER),
        SurfaceFormat::Latex => Some(&LATEX),
        // Reserved slots (§6.3a) — declared vocabulary, no adapter yet.
        SurfaceFormat::Typst | SurfaceFormat::Asciimath => None,
    }
}

/// Re-express `input` (written in `from`) as text in `to`, pivoting through the canonical
/// AST: `to.export(from.import(input))`. `None` if either format has no adapter yet. This is
/// the "one user prefers LaTeX, another prefers mathmeander" path: store everyone's canonical
/// `mathmeander`, and `transcode` to each reader's chosen syntax for display/editing. Note
/// adapter syntaxes are lossy, so a non-`mathmeander` round trip is not guaranteed identity.
pub fn transcode(input: &str, from: SurfaceFormat, to: SurfaceFormat) -> Option<String> {
    let src = adapter_for(from)?;
    let dst = adapter_for(to)?;
    Some(dst.export(&src.import(input)))
}
