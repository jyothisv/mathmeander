//! Grammar tests (arch doc §6.3a, §13a.1): the pinned slash/fraction rule, canonical
//! round-trip / fixpoint, parser totality, script combining, and the resolution-ready
//! occurrence-site model.

use mathmeander_surface::ast::{Expr, ExprKind, FracForm, MulOp};
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
        "d y/d x", // v2: `dy`/`dx` segment to `d·y`/`d·x` (write `"dy"` for a differential)
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
        // v2: segmentation, blackboard, string literals.
        "a a",
        "2 a b",
        "x in RR",
        "\"radius\"",
        "f(\"radius\")",
        "{ x in RR | x \"is natural\" }",
        // v3: × (times) distinct from · (*), variant star, piecewise.
        "N times N",
        "Z^*",
        "ZZ^*",
        "cases(a, b)",
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
            ExprKind::Text(s) => format!("\"{s}\""),
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
            ExprKind::Mul { lhs, op, rhs } => {
                let o = match op {
                    MulOp::Cdot => "*",
                    MulOp::Cross => "\u{00D7}",
                };
                format!("({}{}{})", go(lhs), o, go(rhs))
            }
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

// ── grammar v2: dictionary-aware segmentation + Typst-ish syntax ──

#[test]
fn segmentation_splits_unknown_runs_keeps_known_whole() {
    use mathmeander_surface::lexer::{Tok, lex};
    let kinds = |s: &str| -> Vec<Tok> { lex(s).into_iter().map(|t| t.tok).collect() };
    // An unknown letter-run splits into one single-letter Name per letter.
    assert_eq!(
        kinds("aa"),
        vec![Tok::Name("a".into()), Tok::Name("a".into())]
    );
    assert_eq!(serialize(&parse("aa")), "a a");
    assert_eq!(serialize(&parse("radius")), "r a d i u s");
    assert_eq!(serialize(&parse("pin")), "p i n");
    // A KNOWN name (function/greek/blackboard/styling-head/word-relation/frac) stays one token.
    for name in [
        "sin", "cos", "in", "subseteq", "RR", "NN", "sqrt", "frac", "bb", "cal", "nabla", "alpha",
    ] {
        assert_eq!(
            kinds(name),
            vec![Tok::Name(name.into())],
            "{name} should stay whole"
        );
    }
}

#[test]
fn combining_mark_attaches_to_the_last_split_letter() {
    use mathmeander_surface::lexer::{Tok, lex};
    // `ab` + combining acute splits to `a`, `b́` (the mark stays on its base, grapheme intact).
    let kinds: Vec<Tok> = lex("ab\u{301}").into_iter().map(|t| t.tok).collect();
    assert_eq!(
        kinds,
        vec![Tok::Name("a".into()), Tok::Name("b\u{301}".into())]
    );
    assert_eq!(serialize(&parse("ab\u{301}")), "a b\u{301}");
}

#[test]
fn string_literals_are_text_and_round_trip() {
    assert!(matches!(parse("\"radius\"").kind, ExprKind::Text(s) if s == "radius"));
    assert_eq!(serialize(&parse("\"is natural\"")), "\"is natural\"");
    assert!(matches!(parse("\"x\"^2").kind, ExprKind::Sup { .. })); // a string is a script base
    assert!(matches!(parse("\"a\" \"b\"").kind, ExprKind::Juxtapose(_))); // two strings juxtapose
    // Unterminated string is lenient/total: content runs to EOF.
    assert!(matches!(parse("\"abc").kind, ExprKind::Text(s) if s == "abc"));
}

#[test]
fn blackboard_text_and_bar_rendering() {
    use mathmeander_surface::latex::export;
    assert_eq!(export(&parse("RR")), "\\mathbb{R}");
    assert_eq!(export(&parse("NN")), "\\mathbb{N}");
    assert!(export(&parse("a | b")).contains("\\mid")); // `|` → set-builder/divides bar
    let braces = export(&parse("{ x }"));
    assert!(braces.contains("\\{") && braces.contains("\\}"));
    assert_eq!(export(&parse("\"radius\"")), "\\text{radius}");
    // Injection-safe: a `}` inside a text literal is escaped.
    assert!(export(&parse("\"a}b\"")).contains("\\text{a\\}b}"));
}

#[test]
fn migration_recanonicalizes_segmented_identifiers() {
    use mathmeander_surface::migrate::{migrate_surface_to_current, migration_from};
    assert!(migration_from(1).is_some());
    assert_eq!(migrate_surface_to_current("dy/dx", 1), "d y/d x");
    // Idempotent: migrating the already-current form is a no-op.
    assert_eq!(migrate_surface_to_current("d y/d x", 2), "d y/d x");
}

#[test]
fn dictionary_covers_every_render_special_name() {
    use mathmeander_surface::dictionary::{
        BLACKBOARD, FUNCTIONS, NAMES, PRODUCT_WORDS, STYLING_HEADS, is_known_name,
    };
    for &n in NAMES
        .iter()
        .chain(FUNCTIONS)
        .chain(STYLING_HEADS)
        .chain(PRODUCT_WORDS)
    {
        assert!(
            is_known_name(n),
            "{n} renders specially but the lexer would split it"
        );
    }
    for &(name, _) in BLACKBOARD {
        assert!(
            is_known_name(name),
            "{name} is blackboard but the lexer would split it"
        );
    }
}

#[test]
fn dictionary_contents_are_pinned() {
    // SNAPSHOT of the kept-whole name set (mirrors the precedence shape-pin). Adding/removing ANY
    // entry is a re-reading grammar change — a stored `cot` would keep-whole instead of `c·o·t` —
    // so it must be a DELIBERATE `GRAMMAR_VERSION` bump: update this snapshot in the same change.
    use mathmeander_surface::dictionary::{
        BLACKBOARD, FUNCTIONS, NAMES, PRODUCT_WORDS, STYLING_HEADS,
    };
    assert_eq!(
        NAMES,
        &[
            "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
            "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi", "chi", "psi", "omega",
            "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
            "infty", "sum", "prod", "int", "nabla", "partial",
        ]
    );
    assert_eq!(
        FUNCTIONS,
        &["sin", "cos", "tan", "log", "ln", "exp", "lim", "max", "min"]
    );
    assert_eq!(
        STYLING_HEADS,
        &["sqrt", "cal", "bb", "frak", "bold", "bf", "cases"]
    );
    assert_eq!(PRODUCT_WORDS, &["times"]);
    assert_eq!(
        BLACKBOARD,
        &[
            ("RR", "R"),
            ("NN", "N"),
            ("ZZ", "Z"),
            ("QQ", "Q"),
            ("CC", "C"),
        ]
    );
}

// ── grammar v3: `times` (×) distinct from `*` (·), postfix `*` variant star, `cases(…)` ──

#[test]
fn times_is_cross_product_distinct_from_cdot() {
    use mathmeander_surface::latex::export;
    use mathmeander_surface::lexer::{Tok, lex};
    assert!(matches!(
        parse("a * b").kind,
        ExprKind::Mul {
            op: MulOp::Cdot,
            ..
        }
    ));
    assert!(matches!(
        parse("N times N").kind,
        ExprKind::Mul {
            op: MulOp::Cross,
            ..
        }
    ));
    assert!(export(&parse("a * b")).contains("\\cdot"));
    assert!(export(&parse("N times N")).contains("\\times"));
    // `times` is kept whole (one Name); `Ntimes` (no spaces) still segments.
    let toks: Vec<Tok> = lex("times").into_iter().map(|t| t.tok).collect();
    assert_eq!(toks, vec![Tok::Name("times".into())]);
    assert_eq!(lex("Ntimes").len(), 6);
}

#[test]
fn postfix_star_is_the_variant_when_no_operand_follows() {
    // `Z*` (nothing follows) → the variant star `Z^*`.
    assert!(matches!(parse("Z*").kind, ExprKind::Sup { .. }));
    assert_eq!(serialize(&parse("Z*")), "Z^*");
    assert_eq!(serialize(&parse("ZZ*")), "ZZ^*"); // blackboard ℤ with a star
    // The canonical/exported form `Z^*` re-parses to the SAME clean tree — no `Error("*")`, so it
    // doesn't self-degrade to a `<merror>` on a rewrite / clipboard / reload round-trip.
    assert_eq!(parse("Z^*"), parse("Z*"));
    assert!(!parse("Z^*").has_error() && !parse("Z*").has_error());
    // A `*` after a NUMBER is NOT the variant star (no `2^*`): it reads as an (incomplete) product.
    assert!(matches!(
        parse("2*").kind,
        ExprKind::Mul {
            op: MulOp::Cdot,
            ..
        }
    ));
    // `*` stays the `·` product when an operand follows.
    assert!(matches!(
        parse("Z*b").kind,
        ExprKind::Mul {
            op: MulOp::Cdot,
            ..
        }
    ));
    // before an operator / relation / product-word it's postfix: `(Z*) …`.
    assert!(matches!(
        parse("Z* + 1").kind,
        ExprKind::Add { lhs, .. } if matches!(lhs.kind, ExprKind::Sup { .. })
    ));
    assert!(matches!(
        parse("Z* in G").kind,
        ExprKind::Rel { lhs, .. } if matches!(lhs.kind, ExprKind::Sup { .. })
    ));
    assert!(matches!(
        parse("Z* times N").kind,
        ExprKind::Mul { op: MulOp::Cross, lhs, .. } if matches!(lhs.kind, ExprKind::Sup { .. })
    ));
}

#[test]
fn cases_renders_the_piecewise_environment() {
    use mathmeander_surface::latex::export;
    // `cases` is kept whole → a Call; the canonical surface stays `cases(a, b)`.
    assert!(matches!(parse("cases(a, b)").kind, ExprKind::Call { .. }));
    assert_eq!(serialize(&parse("cases(a, b)")), "cases(a, b)");
    // …but LaTeX renders the piecewise environment.
    let tex = export(&parse("cases(0 \"if\" x < 0, x \"if\" x >= 0)"));
    assert!(tex.contains("\\begin{cases}") && tex.contains("\\end{cases}"));
    assert!(tex.contains("\\text{if}")); // a `"if"` text-literal condition
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
