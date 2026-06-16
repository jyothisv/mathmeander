//! LaTeX import/export adapters (arch doc §6.3a — LaTeX is an import/export adapter, never
//! the source of truth; KaTeX/MathML are render adapters in `render.rs`). Both directions
//! are pure `Expr ↔ String`. Import is LENIENT and TOTAL: it textually translates LaTeX
//! into `mathmeander` and reparses, so unknown macros degrade to names rather than failing
//! (full LaTeX parity is a non-goal; the exotic tail is the core's `original_input` +
//! `parse_status` escape hatch, §6.3a).

use crate::ast::Expr;
use crate::parser::parse;

/// Names shared by both directions: `mathmeander` name ⇔ LaTeX macro (without backslash).
/// Greek + a few letterlike/big operators. Anything else passes through as a plain name.
const NAMES: &[&str] = &[
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
    "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi", "chi", "psi", "omega", "Gamma",
    "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega", "infty", "sum", "prod",
    "int", "nabla", "partial",
];

/// Function names exported as LaTeX operators (`\sin`, …) for nicer rendering.
const FUNCTIONS: &[&str] = &["sin", "cos", "tan", "log", "ln", "exp", "lim", "max", "min"];

/// Relation token (mathmeander) ⇒ LaTeX. The reverse drives import.
fn rel_to_latex(op: &str) -> &str {
    match op {
        "<=" => "\\leq",
        ">=" => "\\geq",
        "!=" => "\\neq",
        "->" => "\\to",
        "=>" => "\\Rightarrow",
        ":=" => "\\coloneqq",
        "in" => "\\in",
        "notin" => "\\notin",
        "subset" => "\\subset",
        "subseteq" => "\\subseteq",
        other => other, // "=", "<", ">"
    }
}

// ── Export: Expr → LaTeX ─────────────────────────────────────────────────────

/// Serialize an expression to a LaTeX string (clipboard / KaTeX input).
pub fn export(e: &Expr) -> String {
    let mut s = String::new();
    emit(e, &mut s);
    s
}

fn emit(e: &Expr, out: &mut String) {
    match e {
        Expr::Empty => {}
        // Numbers are digits-only and identifiers are `[A-Za-z]+` or a known macro — safe.
        Expr::Number(s) => out.push_str(s),
        // Symbols and recovered error fragments carry ARBITRARY text (pasted glyphs, raw
        // input), so they MUST be escaped before going into a LaTeX/KaTeX string — otherwise
        // a crafted `\`/`{`/`$` is a KaTeX-injection / render-break vector (matches the
        // XML-escaping the MathML path already does, render.rs).
        Expr::Symbol(s) | Expr::Error(s) => out.push_str(&latex_escape(s)),
        Expr::Ident(name) => out.push_str(&ident_to_latex(name)),
        Expr::Group(inner) => {
            out.push_str("\\left(");
            emit(inner, out);
            out.push_str("\\right)");
        }
        Expr::Call { head, args } => {
            if let Expr::Ident(h) = head.as_ref() {
                match (h.as_str(), args.as_slice()) {
                    ("sqrt", [x]) => return wrap_macro(out, "\\sqrt", x),
                    ("cal", [x]) => return wrap_macro(out, "\\mathcal", x),
                    ("bb", [x]) => return wrap_macro(out, "\\mathbb", x),
                    ("frak", [x]) => return wrap_macro(out, "\\mathfrak", x),
                    ("bold" | "bf", [x]) => return wrap_macro(out, "\\mathbf", x),
                    _ => {}
                }
            }
            emit(head, out);
            out.push_str("\\left(");
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                emit(a, out);
            }
            out.push_str("\\right)");
        }
        Expr::Sup { base, exp } => {
            emit(base, out);
            out.push('^');
            emit_braced(exp, out);
        }
        Expr::Sub { base, sub } => {
            emit(base, out);
            out.push('_');
            emit_braced(sub, out);
        }
        Expr::Unary { op, operand } => {
            out.push_str(op.as_str());
            emit(operand, out);
        }
        Expr::Juxtapose(fs) => {
            for (i, f) in fs.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                emit(f, out);
            }
        }
        Expr::Frac { num, den, form } => {
            if Expr::frac_built_up(num, den, *form) {
                // The fraction bar groups, so a numerator/denominator `Group`'s visible
                // parens are dropped (like script grouping) — `(a+b)/c` → `\frac{a + b}{c}`.
                out.push_str("\\frac{");
                emit_ungrouped(num, out);
                out.push_str("}{");
                emit_ungrouped(den, out);
                out.push('}');
            } else {
                emit(num, out);
                out.push('/');
                emit(den, out);
            }
        }
        Expr::Mul { lhs, rhs } => {
            emit(lhs, out);
            out.push_str(" \\cdot ");
            emit(rhs, out);
        }
        Expr::Add { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(' ');
            out.push_str(op.as_str());
            out.push(' ');
            emit(rhs, out);
        }
        Expr::Rel { lhs, op, rhs } => {
            emit(lhs, out);
            out.push(' ');
            out.push_str(rel_to_latex(op));
            out.push(' ');
            emit(rhs, out);
        }
    }
}

/// Emit `^`/`_` argument: a `Group` becomes the LaTeX `{ grouping }` (its visible parens
/// are dropped — script grouping is invisible in LaTeX); anything else is braced as-is.
fn emit_braced(e: &Expr, out: &mut String) {
    out.push('{');
    emit_ungrouped(e, out);
    out.push('}');
}

/// Emit a node, dropping one layer of `Group` parens (used where surrounding LaTeX syntax
/// already provides the grouping: `\frac{}{}`, `^{}`, `_{}`).
fn emit_ungrouped(e: &Expr, out: &mut String) {
    match e {
        Expr::Group(inner) => emit(inner, out),
        _ => emit(e, out),
    }
}

fn wrap_macro(out: &mut String, macro_name: &str, arg: &Expr) {
    out.push_str(macro_name);
    out.push('{');
    if let Expr::Group(inner) = arg {
        emit(inner, out);
    } else {
        emit(arg, out);
    }
    out.push('}');
}

/// Escape the LaTeX special characters in arbitrary atom text, so a `Symbol`/`Error`
/// fragment can never inject macros or break out of grouping/math mode in the emitted
/// LaTeX/KaTeX string. Non-special chars (incl. Unicode glyphs KaTeX can render) pass through.
fn latex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '$' => out.push_str("\\$"),
            '&' => out.push_str("\\&"),
            '#' => out.push_str("\\#"),
            '%' => out.push_str("\\%"),
            '_' => out.push_str("\\_"),
            '^' => out.push_str("\\textasciicircum{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            _ => out.push(c),
        }
    }
    out
}

fn ident_to_latex(name: &str) -> String {
    if NAMES.contains(&name) || FUNCTIONS.contains(&name) {
        format!("\\{name}")
    } else {
        name.to_string()
    }
}

// ── Import: LaTeX → Expr (lenient, total) ────────────────────────────────────

/// Import a LaTeX string into an `Expr` by translating it to `mathmeander` and reparsing.
/// Lenient + total: unknown macros become plain names; malformed input recovers via the
/// parser's `Error` nodes. Frac forms collapse (LaTeX `\frac` and a built-up `/` both map
/// to one built-up form) — full round-trip fidelity is a non-goal (§6.3a).
pub fn import(latex: &str) -> Expr {
    parse(&latex_to_mathmeander(latex))
}

/// Textual LaTeX → `mathmeander` translation (total). Handles macros (with their brace
/// arguments for `\frac`/`\sqrt`/`\mathcal|mathbb|mathfrak`), `{}` grouping → `()`,
/// `\left`/`\right` stripping, and the operator/relation macros.
pub fn latex_to_mathmeander(latex: &str) -> String {
    let chars: Vec<char> = latex.chars().collect();
    let mut i = 0;
    let mut out = String::new();
    translate(&chars, &mut i, &mut out, None);
    out
}

/// Translate until end of input or an unescaped `stop` char (used for `}`-terminated
/// groups). Advances `i`.
fn translate(chars: &[char], i: &mut usize, out: &mut String, stop: Option<char>) {
    while *i < chars.len() {
        let c = chars[*i];
        if Some(c) == stop {
            return;
        }
        match c {
            '\\' => translate_macro(chars, i, out),
            '{' => {
                *i += 1;
                out.push('(');
                translate(chars, i, out, Some('}'));
                if *i < chars.len() && chars[*i] == '}' {
                    *i += 1;
                }
                out.push(')');
            }
            '}' => {
                // Stray close brace (no matching open) — drop it; the parser would only
                // recover it as an error fragment anyway.
                *i += 1;
            }
            '~' => {
                // LaTeX non-breaking space.
                out.push(' ');
                *i += 1;
            }
            _ => {
                out.push(c);
                *i += 1;
            }
        }
    }
}

fn translate_macro(chars: &[char], i: &mut usize, out: &mut String) {
    *i += 1; // consume '\'
    // Read the macro name (letters); a non-letter after '\' is an escaped symbol.
    let start = *i;
    while *i < chars.len() && chars[*i].is_ascii_alphabetic() {
        *i += 1;
    }
    if *i == start {
        // `\` followed by a non-letter: emit that char literally (escaped symbol / `\\`).
        if *i < chars.len() {
            let c = chars[*i];
            if c != '\\' {
                out.push(c);
            } else {
                out.push(' '); // `\\` line break → space
            }
            *i += 1;
        }
        return;
    }
    let name: String = chars[start..*i].iter().collect();
    match name.as_str() {
        "frac" => {
            out.push_str("frac(");
            read_group(chars, i, out);
            out.push_str(", ");
            read_group(chars, i, out);
            out.push(')');
        }
        "sqrt" => {
            out.push_str("sqrt(");
            read_group(chars, i, out);
            out.push(')');
        }
        "mathcal" => wrap_in(chars, i, out, "cal"),
        "mathbb" => wrap_in(chars, i, out, "bb"),
        "mathfrak" => wrap_in(chars, i, out, "frak"),
        "mathbf" | "boldsymbol" => wrap_in(chars, i, out, "bold"),
        "mathrm" | "operatorname" | "text" => {
            // drop the styling wrapper, keep the content
            read_group(chars, i, out);
        }
        "left" | "right" => {
            // strip the sizing command; keep the delimiter that follows (if any)
            if *i < chars.len() {
                let d = chars[*i];
                if d == '{' || d == '}' {
                    // \left\{ etc. handled by the brace path; do nothing here
                } else if d != '.' {
                    out.push(map_delim(d));
                }
                *i += 1;
            }
        }
        "cdot" | "times" | "ast" => out.push('*'),
        "leq" | "le" => out.push_str("<="),
        "geq" | "ge" => out.push_str(">="),
        "neq" | "ne" => out.push_str("!="),
        "to" | "rightarrow" => out.push_str("->"),
        "Rightarrow" | "implies" => out.push_str("=>"),
        "coloneqq" => out.push_str(":="),
        "in" => out.push_str(" in "),
        "notin" => out.push_str(" notin "),
        "subset" => out.push_str(" subset "),
        "subseteq" => out.push_str(" subseteq "),
        // Known names map to themselves (mathmeander name == macro name); unknown macros
        // degrade leniently to their name (a plain identifier).
        _ => out.push_str(&name),
    }
}

/// Read the next `{...}` group's contents (translated) into `out`; if the next char is not
/// `{`, read a single token char (LaTeX allows `\sqrt x`). Total.
fn read_group(chars: &[char], i: &mut usize, out: &mut String) {
    skip_spaces(chars, i);
    if *i < chars.len() && chars[*i] == '{' {
        *i += 1;
        translate(chars, i, out, Some('}'));
        if *i < chars.len() && chars[*i] == '}' {
            *i += 1;
        }
    } else if *i < chars.len() {
        // single-token argument
        let c = chars[*i];
        if c == '\\' {
            translate_macro(chars, i, out);
        } else {
            out.push(c);
            *i += 1;
        }
    }
}

fn wrap_in(chars: &[char], i: &mut usize, out: &mut String, head: &str) {
    out.push_str(head);
    out.push('(');
    read_group(chars, i, out);
    out.push(')');
}

fn skip_spaces(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i] == ' ' {
        *i += 1;
    }
}

fn map_delim(d: char) -> char {
    match d {
        '[' | '{' => '(',
        ']' | '}' => ')',
        other => other,
    }
}
