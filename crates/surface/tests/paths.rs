//! Sub-expression addressing (precise click / annotation targeting): each AST node carries the
//! VERBATIM source `CharSpan` it was parsed from (`path::verbatim_paths`), so a clicked sub-term
//! maps to its exact source range REGARDLESS of how the user typed it — spacing, brackets, packing.
//! These pin that the spans index the input directly (not a re-serialized canonical form) and that
//! the render-side `\htmlData` tags address only nodes the path list can resolve.

use mathmeander_surface::ast::Expr;
use mathmeander_surface::parser::parse;
use mathmeander_surface::path::{enumerate, resolve, verbatim_paths};
use mathmeander_surface::render::{katex, katex_with_paths};
use mathmeander_surface::serializer::serialize;
use proptest::prelude::*;

/// A spread of node kinds AND non-canonical spellings: no-space operators (`i=0`), packed
/// juxtaposition (`2ab`), leading/trailing whitespace, brackets, nested structure, macros.
const CORPUS: &[&str] = &[
    "x",
    "i=0",
    "2ab",
    "  x + y ",
    "a+b*c",
    "(a+b)^2 = a^2 + 2ab + b^2",
    "sin^2(x) + sum_(i=0)^n nabla",
    "(a + b)/c",
    "a/(b+c)",
    "frac(a,b)",
    "x^2",
    "x_i^2",
    "x^(a+b)",
    "f(x)=x^2+1",
    "[a+b]",
    "sqrt(a)/b",
    "x in S",
    "-x+1",
    "cal(F)",
    "2 x",
];

fn cp_len(s: &str) -> u32 {
    s.chars().count() as u32
}

fn char_slice(s: &str, start: u32, end: u32) -> String {
    s.chars()
        .skip(start as usize)
        .take((end - start) as usize)
        .collect()
}

/// Pull the `path=…` values out of `\htmlData{path=…}{…}` render tags.
fn data_path_tags(latex: &str) -> Vec<String> {
    const OPEN: &str = "\\htmlData{path=";
    let mut out = Vec::new();
    let mut rest = latex;
    while let Some(i) = rest.find(OPEN) {
        rest = &rest[i + OPEN.len()..];
        match rest.find('}') {
            Some(j) => {
                out.push(rest[..j].to_string());
                rest = &rest[j..];
            }
            None => break,
        }
    }
    out
}

#[test]
fn verbatim_span_reparses_to_subterm() {
    // THE precise-click invariant: for every recorded `(path, span)`, the VERBATIM source slice at
    // `span` is exactly that sub-term's source — re-parsing the slice yields the same canonical
    // form as the addressed node. Holds for non-canonical input (`2ab`, `i=0`, leading spaces)
    // because the span indexes the input directly; both sides canonicalize on re-serialize.
    for s in CORPUS {
        let e = parse(s);
        let paths = verbatim_paths(s);
        assert!(!paths.is_empty(), "no paths for {s:?}");
        for (path, span) in &paths {
            assert!(
                span.start <= span.end && span.end <= cp_len(s),
                "out-of-bounds span {:?} for path {:?} in {s:?}",
                (span.start, span.end),
                path.0
            );
            let node = resolve(&e, path)
                .unwrap_or_else(|| panic!("path {:?} did not resolve in {s:?}", path.0));
            let slice = char_slice(s, span.start, span.end);
            // The slice is the sub-term's EXACT source — no surrounding whitespace. (Asserted directly
            // because the canonical re-parse check below would still pass on a whitespace-PADDED span,
            // masking the headline claim; corpus is ASCII so there are no Unicode-whitespace `Sym`s.)
            assert_eq!(
                slice.trim(),
                slice,
                "span {:?} at path {:?} in {s:?} carries surrounding whitespace",
                (span.start, span.end),
                path.0
            );
            assert_eq!(
                serialize(&parse(&slice)),
                serialize(node),
                "verbatim slice {slice:?} (span {:?}) is not the source of path {:?} in {s:?}",
                (span.start, span.end),
                path.0
            );
        }
    }
}

#[test]
fn span_slices_are_the_exact_verbatim_substrings() {
    // The headline claim, spelled out: each path's slice is the PRECISE source the user typed — verbatim,
    // not the canonical re-serialization (`i=0`, not `i = 0`).
    let s = "i=0"; // Rel(i, =, 0)
    let by_path: std::collections::HashMap<Vec<usize>, String> = verbatim_paths(s)
        .into_iter()
        .map(|(p, sp)| (p.0, char_slice(s, sp.start, sp.end)))
        .collect();
    assert_eq!(by_path[&vec![]], "i=0"); // root — the WHOLE verbatim source (NOT canonical "i = 0")
    assert_eq!(by_path[&vec![0]], "i");
    assert_eq!(by_path[&vec![1]], "0");

    // Packed juxtaposition + brackets: spans index the literal characters.
    let t = "2ab"; // Juxtapose(2, ab)
    let by_path: std::collections::HashMap<Vec<usize>, String> = verbatim_paths(t)
        .into_iter()
        .map(|(p, sp)| (p.0, char_slice(t, sp.start, sp.end)))
        .collect();
    assert_eq!(by_path[&vec![]], "2ab");
    assert_eq!(by_path[&vec![0]], "2");
    assert_eq!(by_path[&vec![1]], "ab");
}

#[test]
fn root_span_covers_the_content() {
    // The root path `[]` spans the whole expression's source: first token → last, EXCLUDING
    // surrounding whitespace. For a trimmed input that's `[0, cpLen]`.
    for s in ["x", "i=0", "2ab", "(a+b)^2", "f(x)=x^2+1"] {
        let root = &verbatim_paths(s)[0];
        assert!(root.0.0.is_empty(), "first path must be the root for {s:?}");
        assert_eq!(
            (root.1.start, root.1.end),
            (0, cp_len(s)),
            "root span should cover all of {s:?}"
        );
    }
    // Leading/trailing whitespace is excluded: `"  x + y "` → the root spans `x + y` at [2, 7].
    let padded = &verbatim_paths("  x + y ")[0];
    assert_eq!((padded.1.start, padded.1.end), (2, 7));
}

#[test]
fn data_path_tags_are_addressable() {
    // Every `data-path` the render emits must be a path the click handler can resolve via
    // `verbatim_paths` (some nodes — e.g. a `wrap_macro` elided head — are intentionally NOT
    // tagged, so tags are a SUBSET of addressable paths, never a superset).
    for s in CORPUS {
        let addressable: std::collections::HashSet<String> = verbatim_paths(s)
            .iter()
            .map(|(p, _)| {
                p.0.iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(".")
            })
            .collect();
        for tag in data_path_tags(&katex_with_paths(&parse(s))) {
            assert!(
                addressable.contains(&tag),
                "render tagged data-path={tag:?} but it is not addressable in {s:?}"
            );
        }
    }
}

#[test]
fn export_with_paths_tags_each_node_untagged_export_unchanged() {
    let e = parse("x + y");
    let tagged = katex_with_paths(&e);
    assert!(
        tagged.contains("\\htmlData{path="),
        "no \\htmlData in {tagged:?}"
    );
    assert!(
        tagged.contains("\\htmlData{path=0}"),
        "lhs untagged in {tagged:?}"
    );
    assert!(
        tagged.contains("\\htmlData{path=1}"),
        "rhs untagged in {tagged:?}"
    );
    // The untagged render carries NO data-path (inline stays cheap; clipboard stays clean).
    assert!(
        !katex(&e).contains("htmlData"),
        "untagged katex leaked \\htmlData"
    );
}

proptest! {
    /// Every node's span is in-bounds and well-NESTED: a child's span lies within its parent's.
    /// This is the structural guarantee precise click + annotation anchoring rely on.
    #[test]
    fn spans_are_in_bounds_and_nested(s in ".*") {
        let e = parse(&s);
        let len = cp_len(&s);
        fn check(e: &Expr, len: u32) {
            assert!(e.span.start <= e.span.end && e.span.end <= len);
            for c in e.children() {
                assert!(
                    c.span.start >= e.span.start && c.span.end <= e.span.end,
                    "child span {:?} escapes parent {:?}",
                    (c.span.start, c.span.end),
                    (e.span.start, e.span.end)
                );
                check(c, len);
            }
        }
        check(&e, len);
        // `enumerate`/`resolve` stay consistent: every enumerated path resolves to its node.
        for (p, node) in enumerate(&e) {
            prop_assert_eq!(resolve(&e, &p).map(|r| &r.kind), Some(&node.kind));
        }
    }

    /// Each node's span slices EXACTLY its verbatim source: re-parsing the slice reproduces the node
    /// (canonically). A bounded UNICODE alphabet (greek `β`, a non-BMP glyph `𝕏`, a combining mark
    /// U+0301) exercises the CODE-POINT span boundaries — where an off-by-one (counting UTF-16 units, or
    /// splitting a surrogate / a combining sequence) would mis-slice. Bounded length keeps it snappy.
    #[test]
    fn node_slice_is_its_verbatim_source(s in "[a-zβ𝕏\u{0301}+*/^_()=, -]{0,24}") {
        let e = parse(&s);
        for (_p, node) in enumerate(&e) {
            let slice = char_slice(&s, node.span.start, node.span.end);
            prop_assert_eq!(serialize(&parse(&slice)), serialize(node));
        }
    }
}
