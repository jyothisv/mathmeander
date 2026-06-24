//! Grammar tests (arch doc §6.3a, §13a.1): the pinned slash/fraction rule, canonical
//! round-trip / fixpoint, parser totality, script combining, and the resolution-ready
//! occurrence-site model.

use mathmeander_surface::ast::{Expr, ExprKind, FracForm};
use mathmeander_surface::normalize::normalize_fresh;
use mathmeander_surface::parser::parse;
use mathmeander_surface::serializer::serialize;
use mathmeander_surface::span::CharSpan;
use mathmeander_surface::status::ParseStatus;
use proptest::prelude::*;

/// Pull the form + built-up decision from a surface whose root is a fraction.
fn frac_of(s: &str) -> (FracForm, bool) {
    match parse(s).kind {
        ExprKind::Frac { num, den, form } => (form, Expr::frac_built_up(&num, &den, form)),
        other => panic!("expected a fraction at the root of {s:?}, got {other:?}"),
    }
}

#[test]
fn the_pinned_slash_fraction_rule() {
    // `/` with plain operands → literal inline (NOT built up).
    assert_eq!(frac_of("G/H"), (FracForm::Slash, false));
    assert_eq!(frac_of("dy/dx"), (FracForm::Slash, false));
    assert_eq!(frac_of("X/n"), (FracForm::Slash, false));
    // `/` with a grouped/structured operand → built up.
    assert_eq!(frac_of("(a + b)/c"), (FracForm::Slash, true));
    assert_eq!(frac_of("sqrt(a)/b"), (FracForm::Slash, true));
    assert_eq!(frac_of("a/(b + c)"), (FracForm::Slash, true));
    // explicit forms, always.
    assert_eq!(frac_of("a//b"), (FracForm::SlashSlash, false));
    assert_eq!(frac_of("frac(a, b)"), (FracForm::FracCall, true));
}

/// Canonical surfaces round-trip exactly: `serialize(parse(s)) == s`, and re-parsing is
/// stable. These double as the pinned grammar-v1 behaviours.
#[test]
fn canonical_surfaces_round_trip() {
    let canon = [
        "x",
        "x + y",
        "a - b",
        "a * b",
        "a + b * c",
        "a * b/c",
        "G/H",
        "dy/dx",
        "a//b",
        "frac(a, b)",
        "(a + b)/c",
        "sqrt(a)/b",
        "x^2",
        "x_i",
        "x_i^2",
        "x^2_i",
        "x^(a + b)",
        "x^-1",
        "2 x",
        "f(x)",
        "f(x) = x^2 + 1",
        "x in S",
        "A subseteq B",
        "-x",
        "-x + 1",
        "cal(F)",
    ];
    for s in canon {
        assert_eq!(serialize(&parse(s)), s, "not canonical: {s:?}");
    }
}

/// Fully parenthesize a tree by STRUCTURE (ignoring the canonical serializer's
/// precedence-aware spacing), so the string captures the parse SHAPE. `serialize(parse(s))
/// == s` is invariant under precedence/associativity flips for associatively-spelled
/// operators; this is not — it pins the numeric ladder.
fn shape(s: &str) -> String {
    fn go(e: &Expr) -> String {
        match &e.kind {
            ExprKind::Empty => "∅".into(),
            ExprKind::Number(n) | ExprKind::Ident(n) | ExprKind::Symbol(n) | ExprKind::Error(n) => {
                n.clone()
            }
            ExprKind::Group(x) => format!("({})", go(x)),
            ExprKind::Call { head, args } => format!(
                "{}({})",
                go(head),
                args.iter().map(go).collect::<Vec<_>>().join(",")
            ),
            ExprKind::Sup { base, exp } => format!("({}^{})", go(base), go(exp)),
            ExprKind::Sub { base, sub } => format!("({}_{})", go(base), go(sub)),
            ExprKind::Unary { op, operand } => format!("({}{})", op.as_str(), go(operand)),
            ExprKind::Juxtapose(fs) => {
                format!("[{}]", fs.iter().map(go).collect::<Vec<_>>().join(" "))
            }
            ExprKind::Frac { num, den, .. } => format!("({}/{})", go(num), go(den)),
            ExprKind::Mul { lhs, rhs } => format!("({}*{})", go(lhs), go(rhs)),
            ExprKind::Add { lhs, op, rhs } => format!("({}{}{})", go(lhs), op.as_str(), go(rhs)),
            ExprKind::Rel { lhs, op, rhs } => format!("({}{}{})", go(lhs), op, go(rhs)),
        }
    }
    go(&parse(s))
}

#[test]
fn precedence_and_associativity_are_pinned_by_shape() {
    // The numeric ladder, tightest → loosest. A binding-power flip changes a shape below
    // (e.g. swapping `*`/`+` makes the first case `((a+b)*c)`), so this goes red even though
    // every fixture's string round-trip still passes.
    assert_eq!(shape("a + b * c"), "(a+(b*c))"); // * tighter than +
    assert_eq!(shape("a * b/c"), "(a*(b/c))"); // / tighter than *
    assert_eq!(shape("a b + c"), "([a b]+c)"); // juxtaposition tighter than +
    assert_eq!(shape("2 x^2"), "[2 (x^2)]"); // script tighter than juxtaposition
    assert_eq!(shape("a + b = c"), "((a+b)=c)"); // relation loosest
    // Associativity.
    assert_eq!(shape("a - b - c"), "((a-b)-c)"); // additive left-assoc
    assert_eq!(shape("a/b/c"), "((a/b)/c)"); // fraction left-assoc
    assert_eq!(shape("x^a^b"), "((x^a)^b)"); // script chain left-assoc
}

#[test]
fn scripts_combine_on_the_base() {
    // sub then sup attach to the same base (not nested).
    assert!(matches!(
        parse("x_i^2").kind,
        ExprKind::Sup { base, .. } if matches!(base.kind, ExprKind::Sub { .. })
    ));
    assert!(matches!(
        parse("x^2_i").kind,
        ExprKind::Sub { base, .. } if matches!(base.kind, ExprKind::Sup { .. })
    ));
    // a script does not grab the following juxtaposed factor.
    assert!(matches!(parse("x^2 y").kind, ExprKind::Juxtapose(_)));
}

#[test]
fn parse_status_is_ours() {
    assert_eq!(normalize_fresh("x + y").status, ParseStatus::Renderable);
    assert_eq!(normalize_fresh("").status, ParseStatus::Renderable);
    assert_eq!(normalize_fresh(")").status, ParseStatus::Invalid);
    assert_eq!(
        normalize_fresh("a )").status,
        ParseStatus::PartiallyResolved
    );
}

#[test]
fn unparseable_keeps_original_verbatim_as_error() {
    // A stray operator is recovered as an Error fragment, preserved in the surface.
    let n = normalize_fresh("@ #");
    assert!(n.text.contains('@') && n.text.contains('#'));
}

#[test]
fn combining_marks_bind_to_their_base_atom() {
    // `e` + combining acute (U+0301) must stay one atom, not split into `e` and a separate
    // symbol with a juxtaposition space ("e ́"). The canonical surface preserves the grapheme.
    let n = normalize_fresh("e\u{301} + x");
    assert_eq!(n.text, "e\u{301} + x");
    // a combining mark over a symbol (vector arrow U+20D7) likewise stays attached.
    assert_eq!(normalize_fresh("v\u{20D7}").text, "v\u{20D7}");
}

#[test]
fn occurrence_sites_are_identifier_spans() {
    let n = normalize_fresh("f(x) + y");
    let names: Vec<&str> = n.occurrence_sites.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["f", "x", "y"]);
    // canonical text is "f(x) + y"; the `x` occurrence sits at chars 2..3.
    assert_eq!(n.text, "f(x) + y");
    assert_eq!(n.occurrence_sites[1].span, CharSpan::new(2, 3));
}

/// Deeply nested / long-chained input must stay TOTAL — recover via the depth cap, never
/// abort the process with a stack overflow (which is uncatchable and would defeat the whole
/// point of a "total" parser, and is a remote-DoS vector from untrusted FFI input). These
/// inputs are far past the cap; before the depth guard they aborted (SIGABRT) around a few
/// thousand. We also drop + serialize the result, since a deep tree overflows on traversal
/// too — the cap must bound the resulting tree, not just the parse recursion.
#[test]
fn deep_input_recovers_and_never_overflows() {
    let n = 50_000;
    let inputs = [
        "(".repeat(n),                  // nested groups (parse recursion)
        format!("1{}", "+1".repeat(n)), // left-assoc chain (loop-built deep tree)
        format!("x{}", "^x".repeat(n)), // script chain (loop-built deep tree)
        "-".repeat(n) + "x",            // unary chain (parse recursion)
        "(".repeat(n) + &")".repeat(n), // matched deep nesting
    ];
    for input in inputs {
        let out = normalize_fresh(&input); // must not abort
        // Traversing (drop + re-serialize) the produced tree must also not overflow.
        let _ = serialize(&parse(&out.text));
    }
}

/// The serializer must never emit adjacent pieces that FUSE into a different token on
/// re-lex (a recovered `Error` leaf's operator text abutting a structural operator), which
/// would break the parse∘serialize fixpoint. Regression for the proptest seed `"/\r/\0"`
/// (`Error("/")` numerator + the `Frac` `/` → `"//"` → one `SlashSlash`) and the `Unary`
/// `-` + `Error(">")` → `"->"` case.
#[test]
fn serializer_never_fuses_tokens() {
    for s in ["/\r/\0", "- >", "x/ /", "1 -> 2 -"] {
        let once = normalize_fresh(s).text;
        let twice = normalize_fresh(&once).text;
        assert_eq!(
            once, twice,
            "normalize not idempotent for {s:?}: {once:?} vs {twice:?}"
        );
        // `once` is a genuine fixed point: re-parsing + serializing reproduces it exactly.
        assert_eq!(serialize(&parse(&once)), once, "not a fixpoint: {once:?}");
    }
    // The specific fusion: the two slashes come back separated so they never munch to `//`.
    assert_eq!(normalize_fresh("/\r/\0").text, "/ /\u{0}");
}

proptest! {
    /// Totality + the fixpoint law: `normalize_fresh` never panics on ANY input, and
    /// re-normalizing its canonical output is a no-op (parse∘serialize fixpoint).
    #[test]
    fn normalize_is_total_and_idempotent(s in ".*") {
        let once = normalize_fresh(&s).text;
        let twice = normalize_fresh(&once).text;
        prop_assert_eq!(once, twice);
    }

    /// The parser never panics on arbitrary input (totality).
    #[test]
    fn parser_is_total(s in ".*") {
        let _ = parse(&s);
    }
}
