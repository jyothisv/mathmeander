//! Span-remap tests (arch doc §6.3a): `rewrite_with_remap` is the ONLY post-anchor
//! re-canonicalization path. A rename re-emits the surface and remaps each anchor; an
//! anchor that names no occurrence comes back `None` (→ the edge goes stale, never silently
//! dropped, §6.1b).

use mathmeander_surface::rewrite::{RemapOutcome, SurfaceEdit, rewrite_with_remap};
use mathmeander_surface::span::CharSpan;
use mathmeander_surface::status::ParseStatus;

#[test]
fn rename_rewrites_and_remaps_anchors() {
    // "a + a" has identifier `a` at chars 0..1 and 4..5. Rename a → bb (a longer name, so
    // downstream spans shift) and remap both anchors plus a non-matching one.
    let anchors = [
        CharSpan::new(0, 1), // first `a`
        CharSpan::new(4, 5), // second `a`
        CharSpan::new(2, 3), // the `+` — names no occurrence
    ];
    let RemapOutcome {
        new_text,
        remapped,
        parse_status,
    } = rewrite_with_remap(
        "a + a",
        &SurfaceEdit::RenameIdent {
            from: "a".into(),
            to: "bb".into(),
        },
        &anchors,
    );

    assert_eq!(new_text, "bb + bb");
    assert_eq!(parse_status, ParseStatus::Renderable);
    assert_eq!(
        remapped,
        vec![
            Some(CharSpan::new(0, 2)), // first `a` → first `bb`
            Some(CharSpan::new(5, 7)), // second `a` → second `bb`
            None,                      // the `+` anchor can't be re-placed
        ]
    );
}

#[test]
fn rename_only_touches_the_named_identifier() {
    let out = rewrite_with_remap(
        "x + y",
        &SurfaceEdit::RenameIdent {
            from: "x".into(),
            to: "z".into(),
        },
        &[],
    );
    assert_eq!(out.new_text, "z + y");
}

#[test]
fn rename_to_a_keyword_marks_anchors_stale_never_wrong() {
    // f → frac turns `f(a, b)` into `frac(a, b)`, which re-parses to a built-up fraction
    // with NO head occurrence. The old head anchor (0..4 region) must come back stale, never
    // pointing at the literal keyword. The occurrence count drops (f,a,b → a,b), so every
    // anchor is conservatively staled.
    let out = rewrite_with_remap(
        "f(a, b)",
        &SurfaceEdit::RenameIdent {
            from: "f".into(),
            to: "frac".into(),
        },
        &[CharSpan::new(0, 1), CharSpan::new(2, 3)], // the `f` head, the `a`
    );
    assert_eq!(out.new_text, "frac(a, b)");
    assert_eq!(out.remapped, vec![None, None]); // stale, not wrong
}

#[test]
fn rename_to_a_relation_word_marks_anchors_stale() {
    // y → in turns `x y` (juxtaposition) into `x in` (a relation) — structure changes.
    let out = rewrite_with_remap(
        "x y",
        &SurfaceEdit::RenameIdent {
            from: "y".into(),
            to: "in".into(),
        },
        &[CharSpan::new(0, 1)],
    );
    assert_eq!(out.remapped, vec![None]);
}

#[test]
fn rename_reaches_into_structure() {
    // The rename descends into fractions, scripts, calls.
    let out = rewrite_with_remap(
        "f(a)/a^a",
        &SurfaceEdit::RenameIdent {
            from: "a".into(),
            to: "t".into(),
        },
        &[],
    );
    assert_eq!(out.new_text, "f(t)/t^t");
}
