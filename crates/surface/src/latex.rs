//! LaTeX import/export adapters (arch doc §6.3a — LaTeX is an import/export adapter, never
//! the source of truth; KaTeX/MathML are render adapters in `render.rs`). Both directions
//! are pure `Expr ↔ String`. Import is LENIENT and TOTAL: it textually translates LaTeX
//! into `mathmeander` and reparses, so unknown macros degrade to names rather than failing
//! (full LaTeX parity is a non-goal; the exotic tail is the core's `original_input` +
//! `parse_status` escape hatch, §6.3a).

use crate::ast::{Expr, ExprKind, MulOp};
use crate::dictionary::{FUNCTIONS, NAMES, blackboard};
use crate::parser::parse;
use crate::path::StructuralPath;

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

/// Serialize an expression to a LaTeX string (clipboard / KaTeX input). UNTAGGED — byte-identical
/// to the pre-F3 output (the `tag=false` path adds no `\htmlData`).
pub fn export(e: &Expr) -> String {
    let mut s = String::new();
    emit(e, &StructuralPath::root(), &mut s, false);
    s
}

/// Serialize to LaTeX with each sub-term wrapped in KaTeX `\htmlData{path=…}{…}`, so the rendered
/// DOM carries a `data-path` per node (precise click, F3 — requires `katex.render {trust:true}`).
/// The `path` strings match `path::verbatim_paths`/`path::resolve` (same `Expr::children()` order),
/// so a clicked `data-path` resolves to the sub-term whose verbatim `CharSpan` `verbatim_paths`
/// reports.
pub fn export_with_paths(e: &Expr) -> String {
    let mut s = String::new();
    emit(e, &StructuralPath::root(), &mut s, true);
    s
}

/// Dot-join a path for a `\htmlData` value: `[0,1]` → `"0.1"`, root `[]` → `""` (safe — no
/// `,`/`=`/`{`/`}`).
fn join_dots(p: &[usize]) -> String {
    p.iter().map(usize::to_string).collect::<Vec<_>>().join(".")
}

/// Emit `e`; when `tag`, wrap the WHOLE node in `\htmlData{path=…}{…}` (its per-node DOM tag). The
/// per-variant body is `emit_inner`; this wrapper is the only place tagging happens, so `export`
/// (`tag=false`) is byte-identical to the pre-F3 emitter.
fn emit(e: &Expr, path: &StructuralPath, out: &mut String, tag: bool) {
    if tag {
        out.push_str("\\htmlData{path=");
        out.push_str(&join_dots(&path.0));
        out.push_str("}{");
    }
    emit_inner(e, path, out, tag);
    if tag {
        out.push('}');
    }
}

fn emit_inner(e: &Expr, path: &StructuralPath, out: &mut String, tag: bool) {
    match &e.kind {
        ExprKind::Empty => {}
        // A `Number` is `[0-9.]` plus any combining marks `absorb_combining` folded onto it — none are
        // LaTeX-special, so `latex_escape` is byte-identical here; we escape anyway so the safety is
        // MECHANICAL (a future lexer/emitter change can't silently turn this into an injection vector).
        ExprKind::Number(s) => out.push_str(&latex_escape(s)),
        // Symbols and recovered error fragments carry ARBITRARY text (pasted glyphs, raw
        // input), so they MUST be escaped before going into a LaTeX/KaTeX string — otherwise
        // a crafted `\`/`{`/`$` is a KaTeX-injection / render-break vector (matches the
        // XML-escaping the MathML path already does, render.rs). (\htmlData also needs trust.)
        ExprKind::Symbol(s) => out.push_str(&symbol_to_latex(s)),
        ExprKind::Error(s) => out.push_str(&latex_escape(s)),
        ExprKind::Ident(name) => out.push_str(&ident_to_latex(name)),
        // A `"…"` text literal → upright `\text{…}`; content is arbitrary user text, so escape it.
        ExprKind::Text(s) => {
            out.push_str("\\text{");
            out.push_str(&latex_escape(s));
            out.push('}');
        }
        ExprKind::Group(inner) => {
            out.push_str("\\left(");
            emit(inner, &path.child(0), out, tag);
            out.push_str("\\right)");
        }
        ExprKind::Call { head, args } => {
            if let ExprKind::Ident(h) = &head.kind {
                match (h.as_str(), args.as_slice()) {
                    ("sqrt", [x]) => return wrap_macro(out, "\\sqrt", x, path, tag),
                    ("cal", [x]) => return wrap_macro(out, "\\mathcal", x, path, tag),
                    ("bb", [x]) => return wrap_macro(out, "\\mathbb", x, path, tag),
                    ("frak", [x]) => return wrap_macro(out, "\\mathfrak", x, path, tag),
                    ("bold" | "bf", [x]) => return wrap_macro(out, "\\mathbf", x, path, tag),
                    // `cases(row0, row1, …)` → the piecewise environment (args are rows; head elided).
                    ("cases", _) => {
                        out.push_str("\\begin{cases}");
                        for (i, a) in args.iter().enumerate() {
                            if i > 0 {
                                out.push_str(" \\\\ ");
                            }
                            emit(a, &path.child(1 + i), out, tag);
                        }
                        out.push_str("\\end{cases}");
                        return;
                    }
                    _ => {}
                }
            }
            emit(head, &path.child(0), out, tag);
            out.push_str("\\left(");
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                emit(a, &path.child(1 + i), out, tag);
            }
            out.push_str("\\right)");
        }
        ExprKind::Sup { base, exp } => {
            emit(base, &path.child(0), out, tag);
            out.push('^');
            emit_braced(exp, &path.child(1), out, tag);
        }
        ExprKind::Sub { base, sub } => {
            emit(base, &path.child(0), out, tag);
            out.push('_');
            emit_braced(sub, &path.child(1), out, tag);
        }
        ExprKind::Unary { op, operand } => {
            out.push_str(op.as_str());
            emit(operand, &path.child(0), out, tag);
        }
        ExprKind::Juxtapose(fs) => {
            for (i, f) in fs.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                emit(f, &path.child(i), out, tag);
            }
        }
        ExprKind::Frac { num, den, form } => {
            if Expr::frac_built_up(num, den, *form) {
                // The fraction bar groups, so a numerator/denominator `Group`'s visible
                // parens are dropped (like script grouping) — `(a+b)/c` → `\frac{a + b}{c}`.
                out.push_str("\\frac{");
                emit_ungrouped(num, &path.child(0), out, tag);
                out.push_str("}{");
                emit_ungrouped(den, &path.child(1), out, tag);
                out.push('}');
            } else {
                emit(num, &path.child(0), out, tag);
                out.push('/');
                emit(den, &path.child(1), out, tag);
            }
        }
        ExprKind::Mul { lhs, op, rhs } => {
            emit(lhs, &path.child(0), out, tag);
            out.push_str(match op {
                MulOp::Cdot => " \\cdot ",
                MulOp::Cross => " \\times ",
            });
            emit(rhs, &path.child(1), out, tag);
        }
        ExprKind::Add { lhs, op, rhs } => {
            emit(lhs, &path.child(0), out, tag);
            out.push(' ');
            out.push_str(op.as_str());
            out.push(' ');
            emit(rhs, &path.child(1), out, tag);
        }
        ExprKind::Rel { lhs, op, rhs } => {
            emit(lhs, &path.child(0), out, tag);
            out.push(' ');
            out.push_str(rel_to_latex(op));
            out.push(' ');
            emit(rhs, &path.child(1), out, tag);
        }
    }
}

/// Emit `^`/`_` argument: a `Group` becomes the LaTeX `{ grouping }` (its visible parens
/// are dropped — script grouping is invisible in LaTeX); anything else is braced as-is.
fn emit_braced(e: &Expr, path: &StructuralPath, out: &mut String, tag: bool) {
    out.push('{');
    emit_ungrouped(e, path, out, tag);
    out.push('}');
}

/// Emit a node, dropping one layer of `Group` parens (used where surrounding LaTeX syntax
/// already provides the grouping: `\frac{}{}`, `^{}`, `_{}`). A dropped `Group` is still a real
/// child — descend into its child 0 so the threaded path stays aligned with `children()`.
fn emit_ungrouped(e: &Expr, path: &StructuralPath, out: &mut String, tag: bool) {
    match &e.kind {
        ExprKind::Group(inner) => emit(inner, &path.child(0), out, tag),
        _ => emit(e, path, out, tag),
    }
}

/// Emit a `\sqrt`/`\mathcal`/… macro: `arg` is the Call's child 1 (the head ident is child 0,
/// elided here — it has no rendered span, so no `data-path`; the char-span side still records it).
fn wrap_macro(out: &mut String, macro_name: &str, arg: &Expr, path: &StructuralPath, tag: bool) {
    out.push_str(macro_name);
    out.push('{');
    match &arg.kind {
        ExprKind::Group(inner) => emit(inner, &path.child(1).child(0), out, tag),
        _ => emit(arg, &path.child(1), out, tag),
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
    if let Some(letter) = blackboard(name) {
        // Blackboard shorthand: `RR` → `\mathbb{R}` (NOT `\RR`, which isn't a macro).
        format!("\\mathbb{{{letter}}}")
    } else if NAMES.contains(&name) || FUNCTIONS.contains(&name) {
        format!("\\{name}")
    } else {
        // A plain identifier: `[A-Za-z]` + folded combining marks (no LaTeX-special chars), so this is
        // byte-identical — escaped defensively to keep the no-injection guarantee mechanical, not by-comment.
        latex_escape(name)
    }
}

/// A `Symbol`'s LaTeX. Most pass through `latex_escape` (so `{`/`}` → `\{`/`\}`); `|` becomes
/// `\mid` for proper set-builder/divides spacing (Typst's `{ x | P }`).
fn symbol_to_latex(s: &str) -> String {
    match s {
        "|" => "\\mid".to_string(),
        _ => latex_escape(s),
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
        "text" => {
            // `\text{…}` → a `"…"` text literal (round-trips our `Text` node through LaTeX).
            out.push('"');
            read_group(chars, i, out);
            out.push('"');
        }
        "mathrm" | "operatorname" => {
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
        "cdot" | "ast" => out.push('*'),
        "times" => out.push_str(" times "), // import × as the product operator-word (not `·`)
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
        "begin" => {
            // `\begin{cases} r0 \\ r1 … \end{cases}` → `cases(r0, r1, …)`. Other environments
            // degrade to their name (lenient — full env parity is a non-goal §6.3a).
            skip_spaces(chars, i);
            let env = read_brace_name(chars, i);
            if env == "cases" {
                out.push_str("cases(");
                translate_cases_body(chars, i, out);
                out.push(')');
            } else {
                out.push_str(&env);
            }
        }
        "end" => {
            // A stray `\end` (no matching `\begin` reached here) — consume its `{name}`, emit nothing.
            skip_spaces(chars, i);
            let _ = read_brace_name(chars, i);
        }
        // Known names map to themselves (mathmeander name == macro name); unknown macros
        // degrade leniently to their name (a plain identifier).
        _ => out.push_str(&name),
    }
}

/// Translate a `\begin{cases}` body into `cases(…)` ARGS: rows split on `\\` (→ `, `), column
/// separators `&` dropped (alignment isn't modeled yet). Consumes the closing `\end{…}`. Total.
fn translate_cases_body(chars: &[char], i: &mut usize, out: &mut String) {
    while *i < chars.len() {
        match chars[*i] {
            '\\' => {
                if chars[*i..].starts_with(&['\\', 'e', 'n', 'd']) {
                    *i += 4; // past `\end`
                    skip_spaces(chars, i);
                    let _ = read_brace_name(chars, i); // `{cases}`
                    return;
                }
                if *i + 1 < chars.len() && chars[*i + 1] == '\\' {
                    out.push_str(", "); // `\\` row separator
                    *i += 2;
                    continue;
                }
                translate_macro(chars, i, out);
            }
            '{' => {
                *i += 1;
                out.push('(');
                translate(chars, i, out, Some('}'));
                if *i < chars.len() && chars[*i] == '}' {
                    *i += 1;
                }
                out.push(')');
            }
            '}' => *i += 1, // stray close
            '&' => *i += 1, // alignment column — dropped (not modeled)
            '~' => {
                out.push(' ');
                *i += 1;
            }
            c => {
                out.push(c);
                *i += 1;
            }
        }
    }
}

/// Read a `{name}` group (e.g. after `\begin`/`\end`), returning `name` and consuming through `}`.
fn read_brace_name(chars: &[char], i: &mut usize) -> String {
    if *i < chars.len() && chars[*i] == '{' {
        *i += 1;
        let start = *i;
        while *i < chars.len() && chars[*i] != '}' {
            *i += 1;
        }
        let name: String = chars[start..*i].iter().collect();
        if *i < chars.len() {
            *i += 1; // consume `}`
        }
        name
    } else {
        String::new()
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
