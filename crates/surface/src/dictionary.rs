//! The KNOWN-NAME dictionary (arch doc §6.3a, grammar v2). The SINGLE source of which
//! letter-runs the lexer keeps WHOLE versus splits into single-letter variables
//! (dictionary-aware segmentation): `sin`/`RR`/`in` stay one `Name`, `aa`/`radius` split.
//! It is also the name→rendering categories the LaTeX/MathML adapters consult, so
//! "segmentation dictionary == render dictionary" is MECHANICAL — a name that renders
//! specially but that the lexer would split is a red build (`tests` assert the inclusion).
//!
//! Word relations + the `frac` head stay pinned in `grammar.rs` (they drive the parser); this
//! module re-uses them so there is still exactly one list of each.

use crate::grammar::{FRAC_HEAD, WORD_RELATIONS};

/// Names shared by both LaTeX directions: `mathmeander` name ⇔ LaTeX macro (without backslash).
/// Greek + a few letterlike/big operators. Anything else passes through as a plain name.
pub const NAMES: &[&str] = &[
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
    "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi", "chi", "psi", "omega", "Gamma",
    "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega", "infty", "sum", "prod",
    "int", "nabla", "partial",
];

/// Function names exported as LaTeX operators (`\sin`, …) for nicer rendering.
pub const FUNCTIONS: &[&str] = &["sin", "cos", "tan", "log", "ln", "exp", "lim", "max", "min"];

/// Blackboard-bold shorthands (Typst): name → the single letter inside `\mathbb{…}` (`RR`→ℝ).
pub const BLACKBOARD: &[(&str, &str)] = &[
    ("RR", "R"),
    ("NN", "N"),
    ("ZZ", "Z"),
    ("QQ", "Q"),
    ("CC", "C"),
];

/// Structured call HEADS kept whole so `head(args)` parses as a call: styling wrappers
/// (`cal(F)`→`\mathcal{F}`, `sqrt(x)`→`\sqrt{x}`, …) AND environments (`cases(…)`→`\begin{cases}`).
/// (Their per-head LaTeX/MathML rendering lives in `latex.rs`/`render.rs`; this list is the
/// segmentation half — the `dictionary_covers_render_special_names` test ties the two.)
pub const STYLING_HEADS: &[&str] = &["sqrt", "cal", "bb", "frak", "bold", "bf", "cases"];

/// Product OPERATOR-WORDS: a whole letter-run that is an infix product (× / Cartesian product),
/// recognized in operator position like a word-relation (`N times N` → ×). Kept whole by the lexer;
/// `Ntimes` (no spaces) still segments. (`*` stays the `·` product — a distinct `Tok::Star`.)
pub const PRODUCT_WORDS: &[&str] = &["times"];

/// Whether a letter-run is a KNOWN name and so kept WHOLE by the lexer; otherwise the run splits
/// into one single-letter `Name` per letter (grammar v2). The union of every category — plus the
/// pinned word relations + `frac` head from `grammar.rs`.
pub fn is_known_name(s: &str) -> bool {
    NAMES.contains(&s)
        || FUNCTIONS.contains(&s)
        || WORD_RELATIONS.contains(&s)
        || STYLING_HEADS.contains(&s)
        || PRODUCT_WORDS.contains(&s)
        || s == FRAC_HEAD
        || BLACKBOARD.iter().any(|(name, _)| *name == s)
}

/// Whether `s` is a product operator-word (`times` → ×), recognized in infix operator position.
pub fn is_product_word(s: &str) -> bool {
    PRODUCT_WORDS.contains(&s)
}

/// The `\mathbb{…}` letter for a blackboard name (`"RR"` → `"R"`), or `None`.
pub fn blackboard(s: &str) -> Option<&'static str> {
    BLACKBOARD
        .iter()
        .find(|(name, _)| *name == s)
        .map(|&(_, letter)| letter)
}
