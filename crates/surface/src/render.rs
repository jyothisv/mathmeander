//! Render adapters (arch doc §6.3a): `Expr → String` ONLY — no DOM, no KaTeX dependency;
//! rendering proper lives in `packages/web`. KaTeX consumes LaTeX, so the KaTeX render IS
//! the LaTeX serialization; MathML is a direct structural serialization honoring the
//! Model-A fraction display (`Expr::frac_built_up`).

use crate::ast::Expr;
use crate::latex;

/// The string fed to KaTeX in the frontend (KaTeX renders LaTeX): the LaTeX export.
pub fn katex(e: &Expr) -> String {
    latex::export(e)
}

/// Serialize to presentation MathML (a string; no DOM).
pub fn mathml(e: &Expr) -> String {
    let mut s = String::from("<math xmlns=\"http://www.w3.org/1998/Math/MathML\">");
    emit(e, &mut s);
    s.push_str("</math>");
    s
}

/// Emit one MathML element (always exactly one top-level element, so it can be a child of
/// `<msup>`/`<mfrac>`/… directly). Compounds wrap in `<mrow>`.
fn emit(e: &Expr, out: &mut String) {
    match e {
        Expr::Empty => out.push_str("<mrow/>"),
        Expr::Number(n) => {
            out.push_str("<mn>");
            push_escaped(n, out);
            out.push_str("</mn>");
        }
        Expr::Ident(s) => {
            out.push_str("<mi>");
            push_escaped(s, out);
            out.push_str("</mi>");
        }
        Expr::Symbol(s) => {
            out.push_str("<mo>");
            push_escaped(s, out);
            out.push_str("</mo>");
        }
        Expr::Error(s) => {
            out.push_str("<merror><mtext>");
            push_escaped(s, out);
            out.push_str("</mtext></merror>");
        }
        Expr::Group(inner) => {
            out.push_str("<mrow><mo>(</mo>");
            emit(inner, out);
            out.push_str("<mo>)</mo></mrow>");
        }
        Expr::Call { head, args } => {
            if let Expr::Ident(h) = head.as_ref()
                && h == "sqrt"
                && args.len() == 1
            {
                out.push_str("<msqrt>");
                emit(&args[0], out);
                out.push_str("</msqrt>");
                return;
            }
            out.push_str("<mrow>");
            emit(head, out);
            out.push_str("<mo>(</mo>");
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push_str("<mo>,</mo>");
                }
                emit(a, out);
            }
            out.push_str("<mo>)</mo></mrow>");
        }
        Expr::Sup { base, exp } => {
            out.push_str("<msup>");
            emit_unwrapped(base, out);
            emit_unwrapped(exp, out);
            out.push_str("</msup>");
        }
        Expr::Sub { base, sub } => {
            out.push_str("<msub>");
            emit_unwrapped(base, out);
            emit_unwrapped(sub, out);
            out.push_str("</msub>");
        }
        Expr::Unary { op, operand } => {
            out.push_str("<mrow><mo>");
            out.push_str(op.as_str());
            out.push_str("</mo>");
            emit(operand, out);
            out.push_str("</mrow>");
        }
        Expr::Juxtapose(fs) => {
            out.push_str("<mrow>");
            for f in fs {
                emit(f, out);
            }
            out.push_str("</mrow>");
        }
        Expr::Frac { num, den, form } => {
            if Expr::frac_built_up(num, den, *form) {
                out.push_str("<mfrac>");
                emit_unwrapped(num, out);
                emit_unwrapped(den, out);
                out.push_str("</mfrac>");
            } else {
                out.push_str("<mrow>");
                emit(num, out);
                out.push_str("<mo>/</mo>");
                emit(den, out);
                out.push_str("</mrow>");
            }
        }
        Expr::Mul { lhs, rhs } => {
            out.push_str("<mrow>");
            emit(lhs, out);
            out.push_str("<mo>\u{22C5}</mo>");
            emit(rhs, out);
            out.push_str("</mrow>");
        }
        Expr::Add { lhs, op, rhs } => {
            out.push_str("<mrow>");
            emit(lhs, out);
            out.push_str("<mo>");
            out.push_str(op.as_str());
            out.push_str("</mo>");
            emit(rhs, out);
            out.push_str("</mrow>");
        }
        Expr::Rel { lhs, op, rhs } => {
            out.push_str("<mrow>");
            emit(lhs, out);
            out.push_str("<mo>");
            push_escaped(op, out);
            out.push_str("</mo>");
            emit(rhs, out);
            out.push_str("</mrow>");
        }
    }
}

/// Emit a node for a position (`<msup>`/`<mfrac>` child) where a `Group`'s visible parens
/// should be dropped (the structure provides the grouping). Always exactly one element.
fn emit_unwrapped(e: &Expr, out: &mut String) {
    match e {
        Expr::Group(inner) => {
            out.push_str("<mrow>");
            emit(inner, out);
            out.push_str("</mrow>");
        }
        _ => emit(e, out),
    }
}

fn push_escaped(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
}
