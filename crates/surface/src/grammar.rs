//! The PINNED `mathmeander` grammar v1 (arch doc §6.3a, §13a.1 "pin the surface grammar's
//! precedence/fraction rule here"). This module is the single frozen source of the
//! precedence table, the relation set, and the slash/fraction rule. Changing anything here
//! in a way that re-reads stored surfaces is a `GRAMMAR_VERSION` migration (`migrate.rs`),
//! gated by frozen `fixtures/grammar_v1/`.
//!
//! ## Precedence — tightest → loosest (binding powers; higher binds tighter)
//!
//! ```text
//!   scripts  ^  _   (postfix)       BP_SCRIPT     70   (tightest)
//!   call     f(x)                   BP_CALL       60
//!   juxtaposition  a b              BP_JUXTAPOSE  50
//!   fraction  /  //                 BP_DIV        40
//!   product   *                     BP_MUL        30
//!   sum       +  -                  BP_ADD        20
//!   relation  =  <=  in  …          BP_REL        10   (loosest)
//! ```
//!
//! Scripts are POSTFIX on a primary and CHAIN onto the running base (left-assoc), so a sub
//! and a sup attach to the same base: `x_i^2` = `(x_i)^2`, and `x^2_i` likewise. A script's
//! argument is a tight operand (an atom/group/call, optionally signed: `x^-1`), so
//! `x^2 y` = `(x^2) y` and `x^(a+b)` keeps the group. Unary sign `-x`/`+x` binds tighter
//! than every binary infix except juxtaposition/call/scripts (operand parses at `BP_DIV`),
//! so `-a/b` = `(-a)/b`, `-a b` = `-(a b)`, and `-x^2` = `-(x^2)`.
//!
//! ## The slash / fraction rule (Model A, pure-lexical — style lives in the surface)
//!
//! Three author-controlled forms, each round-tripping to itself; DISPLAY is derived
//! (`Expr::frac_built_up`):
//!   • `a/b`      — STRUCTURAL: builds up iff ≥1 operand is grouped/structured
//!                  (`(...)` / call / script / fraction); else a literal inline slash.
//!                  So `G/H`, `dy/dx`, `X/~` stay literal; `(a+b)/c`, `sqrt(a)/b` build up.
//!   • `a//b`     — an explicit inline slash, always.
//!   • `frac(a,b)`— an explicit built-up fraction, always.

/// Binding powers (higher = binds tighter). Frozen for `GRAMMAR_VERSION = 1`. These drive
/// the Pratt loop for the infix operators; `BP_CALL` and `BP_SCRIPT` are DOCUMENTATION of
/// where call/script sit in the ladder — those two are enforced structurally in the parser
/// (calls in `parse_atom`, scripts as postfix in `parse_postfix`), not via a binding power.
pub const BP_REL: u8 = 10;
pub const BP_ADD: u8 = 20;
pub const BP_MUL: u8 = 30;
pub const BP_DIV: u8 = 40;
pub const BP_JUXTAPOSE: u8 = 50;
pub const BP_CALL: u8 = 60;
pub const BP_SCRIPT: u8 = 70;

/// The min-binding-power a unary sign's operand parses at — tighter than `*`/`/`/`+`,
/// looser than juxtaposition/call/scripts.
pub const BP_UNARY_OPERAND: u8 = BP_DIV;

/// The maximum nesting/chain DEPTH the parser will build (part of the pinned grammar:
/// changing it changes what parses, so it rides `GRAMMAR_VERSION`). Past this, the parser
/// stops descending and recovers (`Expr::Error`), staying TOTAL — a deep `((((…` or
/// `1+1+…` from untrusted FFI input degrades to a preserved fragment instead of a stack
/// overflow (which would be an uncatchable abort, defeating totality). The cap is far
/// above any hand-authored expression and chosen wasm-stack-safe for recursive traversal
/// (drop/serialize) of the resulting bounded tree.
pub const MAX_DEPTH: u32 = 256;

/// The relation tokens of grammar v1 (loosest precedence): the common symbolic relations
/// plus a small set of word relations — including `in`/`subset`/`subseteq`, the ∈/⊆ that
/// type inference will read (§14). Anything else degrades to identifiers/juxtaposition or
/// the LaTeX escape hatch — full parity with LaTeX/Typst is a non-goal (§6.3a).
pub const SYMBOLIC_RELATIONS: &[&str] = &["<=", ">=", "!=", ":=", "->", "=>", "=", "<", ">"];

/// Word relations (recognized as a standalone `Name` token in operator position).
pub const WORD_RELATIONS: &[&str] = &["in", "notin", "subset", "subseteq"];

/// The special call head that parses into a built-up fraction (`frac(a, b)`).
pub const FRAC_HEAD: &str = "frac";

pub fn is_word_relation(s: &str) -> bool {
    WORD_RELATIONS.contains(&s)
}
