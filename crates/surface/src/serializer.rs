//! Canonical serialization `Expr → mathmeander surface_text` (arch doc §6.3a). There is
//! ONE normal form: fixed operator spelling and spacing, explicit `Group`s preserved
//! (Model A — the author's parenthesization is part of the surface). Re-parsing the output
//! yields the same tree, so `normalize` is idempotent (the fixpoint law, tested in
//! `tests/`). Serialization also collects **occurrence sites** — the char-spans of
//! identifier atoms in the canonical text — the coarse, resolution-ready occurrence model
//! the core turns into edges (§6.1b) and that sub-term resolution refines later (§14).

use crate::ast::{Expr, FracForm};
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
    fn push(&mut self, s: &str) {
        self.buf.push_str(s);
        self.chars = self.chars.saturating_add(s.chars().count() as u32);
    }

    fn push_ident(&mut self, name: &str) {
        let start = self.chars;
        self.push(name);
        self.sites.push(OccurrenceSite {
            name: name.to_string(),
            span: CharSpan::new(start, self.chars),
        });
    }
}

fn emit(e: &Expr, out: &mut Out) {
    match e {
        Expr::Empty => {}
        Expr::Number(s) | Expr::Symbol(s) | Expr::Error(s) => out.push(s),
        Expr::Ident(s) => out.push_ident(s),
        Expr::Group(inner) => {
            out.push("(");
            emit(inner, out);
            out.push(")");
        }
        Expr::Call { head, args } => {
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
        Expr::Sup { base, exp } => {
            emit(base, out);
            out.push("^");
            emit(exp, out);
        }
        Expr::Sub { base, sub } => {
            emit(base, out);
            out.push("_");
            emit(sub, out);
        }
        Expr::Unary { op, operand } => {
            out.push(op.as_str());
            emit(operand, out);
        }
        Expr::Juxtapose(fs) => {
            for (i, f) in fs.iter().enumerate() {
                if i > 0 {
                    out.push(" ");
                }
                emit(f, out);
            }
        }
        Expr::Frac { num, den, form } => match form {
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
        Expr::Mul { lhs, rhs } => {
            emit(lhs, out);
            out.push(" * ");
            emit(rhs, out);
        }
        Expr::Add { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(" ");
            out.push(op.as_str());
            out.push(" ");
            emit(rhs, out);
        }
        Expr::Rel { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(" ");
            out.push(op);
            out.push(" ");
            emit(rhs, out);
        }
    }
}
