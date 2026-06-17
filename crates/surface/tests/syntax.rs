//! The syntax-adapter seam (arch doc §6.3a/§14): uniform import/export dispatch over the
//! canonical AST, and transcoding between syntaxes through it. The hub is `mathmeander`;
//! `latex` is a lossy spoke; `typst`/`asciimath` are reserved (no adapter yet).

use mathmeander_surface::status::SurfaceFormat;
use mathmeander_surface::syntax::{SyntaxAdapter, adapter_for, transcode};

#[test]
fn implemented_formats_have_adapters_reserved_do_not() {
    assert!(adapter_for(SurfaceFormat::Mathmeander).is_some());
    assert!(adapter_for(SurfaceFormat::Latex).is_some());
    // Reserved (§6.3a) — adding one is implementing SyntaxAdapter + a match arm, nothing else.
    assert!(adapter_for(SurfaceFormat::Typst).is_none());
    assert!(adapter_for(SurfaceFormat::Asciimath).is_none());
}

#[test]
fn adapter_reports_its_own_format() {
    let a: &dyn SyntaxAdapter = adapter_for(SurfaceFormat::Latex).expect("latex adapter");
    assert_eq!(a.format(), SurfaceFormat::Latex);
}

#[test]
fn mathmeander_adapter_is_canonical_parse_serialize() {
    let mm = adapter_for(SurfaceFormat::Mathmeander).expect("mathmeander adapter");
    // import∘export of an already-canonical surface is identity (the stored normal form).
    assert_eq!(mm.export(&mm.import("a + b * c")), "a + b * c");
    assert_eq!(mm.export(&mm.import("frac(a, b)")), "frac(a, b)");
}

#[test]
fn transcode_pivots_through_the_canonical_ast() {
    // LaTeX in → canonical mathmeander out.
    assert_eq!(
        transcode(
            "\\frac{a}{b}",
            SurfaceFormat::Latex,
            SurfaceFormat::Mathmeander
        )
        .as_deref(),
        Some("frac(a, b)"),
    );
    // canonical mathmeander in → LaTeX out (render in the reader's preferred syntax).
    assert_eq!(
        transcode(
            "frac(a, b)",
            SurfaceFormat::Mathmeander,
            SurfaceFormat::Latex
        )
        .as_deref(),
        Some("\\frac{a}{b}"),
    );
    // a reserved target has no adapter yet → None (never a silent wrong answer).
    assert_eq!(
        transcode("x", SurfaceFormat::Mathmeander, SurfaceFormat::Typst),
        None,
    );
}
