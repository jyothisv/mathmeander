//! Canonical serialization `Expr → mathmeander surface_text` (arch doc §6.3a). There is
//! ONE normal form: fixed operator spelling and spacing, explicit `Group`s preserved
//! (Model A — the author's parenthesization is part of the surface). Re-parsing the output
//! yields the same tree, so `normalize` is idempotent (the fixpoint law, tested in
//! `tests/`). Serialization also collects **occurrence sites** — the char-spans of
//! identifier atoms in the canonical text — the coarse, resolution-ready occurrence model
//! the core turns into edges (§6.1b) and that sub-term resolution refines later (§14).

use crate::ast::{Expr, ExprKind, FracForm, MulOp};
use crate::span::CharSpan;

/// An identifier occurrence in a canonical surface: its name and char-span. Coarse by
/// design (whole-atom spans now; sub-term resolution is reserved, §6.3a/§14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OccurrenceSite {
    pub name: String,
    pub span: CharSpan,
}

/// Serialize to the canonical surface text.
pub fn serialize(e: &Expr) -> String {
    serialize_with_sites(e).0
}

/// Serialize to canonical text AND collect identifier occurrence sites (char-spans into
/// the returned text).
pub fn serialize_with_sites(e: &Expr) -> (String, Vec<OccurrenceSite>) {
    let mut out = Out {
        buf: String::new(),
        chars: 0,
        sites: Vec::new(),
    };
    emit(e, &mut out);
    (out.buf, out.sites)
}

struct Out {
    buf: String,
    /// Running char count == the char offset of the next write (canonical text is
    /// ASCII for the common case; counting chars keeps spans dialect-independent).
    chars: u32,
    sites: Vec<OccurrenceSite>,
}

impl Out {
    /// Insert a separating space if the buffer's last char would FUSE with `next`'s first
    /// char into a single token on re-lex (`fuses`). This is what keeps serialization a
    /// fixpoint: a recovered `Error` leaf's text (always an operator string) can abut a
    /// structural operator at a tight boundary — `Error("/")` numerator + the `Frac` `/`
    /// → `"//"`, which the lexer would munch as one `SlashSlash`, changing the re-parse.
    /// Run once per chunk; never inside a single pushed string (multi-char tokens / idents
    /// / numbers are emitted as ONE push and must not be split).
    fn separate_before(&mut self, next: &str) {
        if let (Some(last), Some(first)) = (self.buf.chars().last(), next.chars().next())
            && fuses(last, first)
        {
            self.buf.push(' ');
            self.chars = self.chars.saturating_add(1);
        }
    }

    fn push(&mut self, s: &str) {
        self.separate_before(s);
        self.buf.push_str(s);
        self.chars = self.chars.saturating_add(s.chars().count() as u32);
    }

    fn push_ident(&mut self, name: &str) {
        // Separate first so the recorded span starts at the ident's REAL char offset (an
        // inserted space shifts it); the `push` below re-checks but is then a no-op.
        self.separate_before(name);
        let start = self.chars;
        self.push(name);
        self.sites.push(OccurrenceSite {
            name: name.to_string(),
            span: CharSpan::new(start, self.chars),
        });
    }
}

/// Whether chars `a` then `b`, emitted adjacently, would lex as ONE token (or extend one)
/// rather than two — so a separating space is needed. A sound superset of the lexer's
/// maximal-munch rules (`lexer.rs` — keep in sync): the two-char operator prefixes, an
/// identifier run, and a number run. Under today's serializer only `('/','/')` and
/// `('-','>')` can actually occur (operator-text `Error`/`Symbol` leaves abutting a `Frac`
/// `/` or a `Unary` `-`); the rest is defensive coverage for future serializer changes.
fn fuses(a: char, b: char) -> bool {
    let two_char_op = matches!(
        (a, b),
        ('/', '/') | ('<', '=') | ('>', '=') | ('!', '=') | (':', '=') | ('-', '>') | ('=', '>')
    );
    let ident_run = a.is_ascii_alphabetic() && b.is_ascii_alphabetic();
    let number_run = (a.is_ascii_digit() && b.is_ascii_digit())
        || (a.is_ascii_digit() && b == '.')
        || (a == '.' && b.is_ascii_digit());
    two_char_op || ident_run || number_run
}

/// Emit `e`'s canonical text into `out`. (Sub-expression addressing no longer rides this walk —
/// precise click reads each node's verbatim `Expr::span` via `path::verbatim_paths`; this stays
/// the pure canonical serializer + occurrence-site collector.)
fn emit(e: &Expr, out: &mut Out) {
    match &e.kind {
        ExprKind::Empty => {}
        ExprKind::Number(s) | ExprKind::Symbol(s) | ExprKind::Error(s) => out.push(s),
        // A `"…"` text literal round-trips with its quotes (content has no `"` — see the lexer).
        ExprKind::Text(s) => {
            out.push("\"");
            out.push(s);
            out.push("\"");
        }
        ExprKind::Ident(s) => out.push_ident(s),
        ExprKind::Group(inner) => {
            out.push("(");
            emit(inner, out);
            out.push(")");
        }
        ExprKind::Tuple(elems) => {
            out.push("(");
            for (i, el) in elems.iter().enumerate() {
                if i > 0 {
                    out.push(", ");
                }
                emit(el, out);
            }
            out.push(")");
        }
        ExprKind::List(elems) => {
            for (i, el) in elems.iter().enumerate() {
                if i > 0 {
                    out.push(", ");
                }
                emit(el, out);
            }
        }
        ExprKind::Set(elems) => {
            out.push("{");
            for (i, el) in elems.iter().enumerate() {
                if i > 0 {
                    out.push(", ");
                }
                emit(el, out);
            }
            out.push("}");
        }
        ExprKind::Call { head, args } => {
            emit(head, out);
            out.push("(");
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push(", ");
                }
                emit(a, out);
            }
            out.push(")");
        }
        ExprKind::Sup { base, exp } => {
            emit(base, out);
            out.push("^");
            emit(exp, out);
        }
        ExprKind::Sub { base, sub } => {
            emit(base, out);
            out.push("_");
            emit(sub, out);
        }
        ExprKind::Unary { op, operand } => {
            out.push(op.as_str());
            emit(operand, out);
        }
        ExprKind::Juxtapose(fs) => {
            for (i, f) in fs.iter().enumerate() {
                // A PRIME hugs its base (`Sigma'`, `q'`) — the one juxtaposed factor that is
                // never space-separated; `Sigma '` reads as a stray tick and breaks verbatim
                // round-trips of primed names.
                let is_prime = matches!(&f.kind, ExprKind::Symbol(s) if s == "'");
                if i > 0 && !is_prime {
                    out.push(" ");
                }
                emit(f, out);
            }
        }
        ExprKind::Frac { num, den, form } => match form {
            FracForm::Slash => {
                emit(num, out);
                out.push("/");
                emit(den, out);
            }
            FracForm::SlashSlash => {
                emit(num, out);
                out.push("//");
                emit(den, out);
            }
            FracForm::FracCall => {
                out.push("frac(");
                emit(num, out);
                out.push(", ");
                emit(den, out);
                out.push(")");
            }
        },
        ExprKind::Mul { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(match op {
                MulOp::Cdot => " * ",
                MulOp::Cross => " times ",
            });
            emit(rhs, out);
        }
        ExprKind::Add { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(" ");
            out.push(op.as_str());
            out.push(" ");
            emit(rhs, out);
        }
        ExprKind::Rel { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(" ");
            out.push(op);
            out.push(" ");
            emit(rhs, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fuses;
    use crate::lexer::{Tok, lex};

    /// Token KINDS (spans dropped) of `s`.
    fn kinds(s: &str) -> Vec<Tok> {
        lex(s).into_iter().map(|t| t.tok).collect()
    }

    /// `fuses` must be a COMPLETE model of the lexer's maximal munch: for every char pair the
    /// lexer fuses across a boundary, `fuses` must return `true` — else the serializer could
    /// emit a sequence that re-lexes to a different token stream, breaking the parse∘serialize
    /// fixpoint (`normalize_fresh` idempotence). This drives that invariant FROM the lexer
    /// itself (the munch authority) over the printable-ASCII alphabet, where all operator /
    /// identifier / number fusion lives. So teaching the lexer a new operator (a future
    /// `|->`, say) without teaching `serializer::fuses` is a RED BUILD, not a silent
    /// idempotence regression — the "keep in sync" comment on `fuses` is now mechanical.
    ///
    /// Only the lexer⇒fuses direction is asserted: `fuses` MAY be a superset (a needless
    /// separator is a harmless space, since whitespace is skipped on re-lex). Combining-mark
    /// fusion is non-ASCII (outside this alphabet) and is covered by the lexer's
    /// `absorb_combining` plus the `normalize_is_total_and_idempotent` proptest.
    #[test]
    fn fuses_covers_every_lexer_fusion() {
        for a in 0x21u8..=0x7e {
            for b in 0x21u8..=0x7e {
                let (a, b) = (a as char, b as char);
                // `"` opens a DELIMITED string that consumes following chars (a space inside changes
                // its content), so the "insert a space" probe spuriously flags it as fusing. Strings
                // aren't maximal-munch fusions — `fuses` doesn't model them — and the serializer always
                // emits a Text node as a MATCHED `"…"` pair, never a bare `"` adjoining other content,
                // so the parse∘serialize fixpoint holds regardless. Skip the string-delimiter opener.
                if a == '"' {
                    continue;
                }
                // A space is whitespace-skipped, so `separated` is the no-fusion baseline; if
                // adjacency changes the token stream, the lexer munched across the boundary.
                let lexer_fuses = kinds(&format!("{a}{b}")) != kinds(&format!("{a} {b}"));
                if lexer_fuses {
                    assert!(
                        fuses(a, b),
                        "lexer fuses {a:?}+{b:?} but serializer::fuses() is false — the \
                         serializer could emit a sequence that re-lexes differently and break \
                         the parse∘serialize fixpoint. Teach fuses this pair."
                    );
                }
            }
        }
    }
}
