//! LaTeX adapter tests (arch doc §6.3a): export correctness, the export∘import round-trip
//! (idempotent on the LaTeX side), and import totality. Full LaTeX parity is a non-goal.

use mathmeander_surface::latex::{export, import};
use mathmeander_surface::parser::parse;
use proptest::prelude::*;

#[test]
fn export_covers_the_core() {
    let cases = [
        ("alpha", "\\alpha"),
        ("x^2", "x^{2}"),
        ("x_i", "x_{i}"),
        ("sqrt(x)", "\\sqrt{x}"),
        ("cal(F)", "\\mathcal{F}"),
        ("bb(R)", "\\mathbb{R}"),
        ("a * b", "a \\cdot b"),
        ("a <= b", "a \\leq b"),
        ("a != b", "a \\neq b"),
        ("x in S", "x \\in S"),
        ("G/H", "G/H"),
        ("(a + b)/c", "\\frac{a + b}{c}"),
        ("frac(a, b)", "\\frac{a}{b}"),
        ("f(x) = x^2 + 1", "f\\left(x\\right) = x^{2} + 1"),
        // v3: × (times), variant star, piecewise.
        ("N times N", "N \\times N"),
        ("Z*", "Z^{*}"),
        ("cases(a, b)", "\\begin{cases}a \\\\ b\\end{cases}"),
    ];
    for (mm, tex) in cases {
        assert_eq!(export(&parse(mm)), tex, "export mismatch for {mm:?}");
    }
}

#[test]
fn export_then_import_is_idempotent() {
    let latex_inputs = [
        "\\frac{a+b}{c}",
        "x^{2} + 1",
        "\\sqrt{x}",
        "\\alpha \\leq \\beta",
        "\\mathcal{F}",
        "a \\cdot b",
        "x \\in S",
        "\\frac{1}{2} x^{2}",
        // v3: × (times), variant star, piecewise — each must survive a LaTeX round-trip.
        "a \\times b",
        "Z^{*}",
        "\\begin{cases} a \\\\ b \\end{cases}",
        "\\begin{cases} 0 \\text{if} x < 0 \\\\ x \\text{if} x \\geq 0 \\end{cases}",
    ];
    for l in latex_inputs {
        let once = export(&import(l));
        let twice = export(&import(&once));
        assert_eq!(once, twice, "export∘import not idempotent for {l:?}");
    }
}

#[test]
fn import_is_lenient_on_unknown_macros() {
    // An unknown macro degrades to a plain name rather than failing. v2 segments the multi-letter
    // run into single-letter variables (`foobar` → `f o o b a r`), so the letters are preserved in
    // order even though the run is split — leniency intact, content not lost.
    let e = import("\\foobar + x");
    let tex = export(&e);
    assert!(
        tex.replace(' ', "").contains("foobar"),
        "unknown macro lost: {tex}"
    );
}

#[test]
fn export_escapes_arbitrary_symbol_and_error_text() {
    // A pasted/garbage token carrying LaTeX specials must not inject macros or break
    // grouping/math mode in the exported (KaTeX) string — the specials come back escaped.
    let tex = export(&parse("x \\ { } $ #"));
    assert!(
        tex.contains("\\textbackslash{}"),
        "backslash not escaped: {tex}"
    );
    assert!(
        tex.contains("\\{") && tex.contains("\\}"),
        "braces not escaped: {tex}"
    );
    assert!(
        tex.contains("\\$") && tex.contains("\\#"),
        "specials not escaped: {tex}"
    );
}

proptest! {
    /// LaTeX import never panics on arbitrary input (totality).
    #[test]
    fn import_is_total(s in ".*") {
        let _ = export(&import(&s));
    }
}
