//! `rewrite_with_remap` — the ONLY post-anchor re-canonicalization path (arch doc §6.3a,
//! the §6.0a `rewrite_surface` operation's engine). Unlike `normalize_fresh`, it is GIVEN
//! the existing anchor spans explicitly and returns their remapped positions, so no anchor
//! is ever silently invalidated: an anchor that cannot be re-placed comes back `None`
//! (the core marks that edge stale / to-review, never dropped — §6.1b).

use crate::ast::{Expr, ExprKind};
use crate::normalize::parse_status;
use crate::parser::parse;
use crate::serializer::serialize_with_sites;
use crate::span::CharSpan;
use crate::status::ParseStatus;

/// A surface edit applied across a whole expression. v1 ships the rename/symbol-swap that
/// `rewrite_surface` needs (a variable rename); the set grows additively.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceEdit {
    /// Rename every identifier atom named `from` to `to` (a variable rename / symbol swap).
    RenameIdent { from: String, to: String },
}

/// The result of a span-remapping rewrite.
pub struct RemapOutcome {
    /// The new canonical surface text.
    pub new_text: String,
    /// For each input span (parallel), its remapped position in `new_text`, or `None` if
    /// it could not be re-anchored (→ the edge goes stale, never silently dropped).
    pub remapped: Vec<Option<CharSpan>>,
    /// `parse_status` of the rewritten surface.
    pub parse_status: ParseStatus,
}

/// Apply `edit` to the canonical surface `old`, remapping the given anchor `spans`.
/// `old` is expected to be canonical surface text (anchors index into it); the function
/// re-derives the old occurrence sites to match anchors structurally.
pub fn rewrite_with_remap(old: &str, edit: &SurfaceEdit, spans: &[CharSpan]) -> RemapOutcome {
    let before = parse(old);
    // Old occurrence sites in the canonical coordinates the anchors index into.
    let (_old_canon, old_sites) = serialize_with_sites(&before);
    let after = apply_edit(&before, edit);
    let (after_text, _) = serialize_with_sites(&after);

    // Re-derive the canonical STORED form + its sites + status by RE-PARSING (what a reload
    // will see), NOT from the in-memory edited tree. A rename whose target is a keyword/word-
    // relation (`f → frac`, `y → in`) makes the edited tree serialize to a string that
    // re-parses to a DIFFERENT structure (`frac(a,b)` → `Frac`, no head occurrence). Reading
    // sites off the edited tree would report an anchor the stored form doesn't have — a WRONG
    // anchor. Reading off the re-parsed text keeps the keystone invariant: an anchor is
    // either correctly remapped or stale, never wrong (§6.1b). `new_text` is the re-parsed
    // serialization, so it is canonical and `new_sites` index into it.
    let reparsed = parse(&after_text);
    let (new_text, new_sites) = serialize_with_sites(&reparsed);

    let remapped: Vec<Option<CharSpan>> = if new_sites.len() == old_sites.len() {
        // Structure preserved: the i-th occurrence corresponds across the edit. An anchor
        // remaps by finding which old site it names (exact span) and reading the same index.
        spans
            .iter()
            .map(|sp| {
                old_sites
                    .iter()
                    .position(|s| s.span == *sp)
                    .and_then(|i| new_sites.get(i).map(|s| s.span))
            })
            .collect()
    } else {
        // The occurrence count changed → the edit reshaped the parse (e.g. an identifier
        // became a keyword). The correspondence is gone; mark EVERY anchor stale rather than
        // risk a wrong one. The glue routes stale edges to review (§6.1b).
        spans.iter().map(|_| None).collect()
    };

    RemapOutcome {
        new_text,
        remapped,
        parse_status: parse_status(&reparsed),
    }
}

/// Apply a surface edit to a tree (pure, recursive).
fn apply_edit(e: &Expr, edit: &SurfaceEdit) -> Expr {
    match edit {
        SurfaceEdit::RenameIdent { from, to } => rename_ident(e, from, to),
    }
}

fn rename_ident(e: &Expr, from: &str, to: &str) -> Expr {
    // The rewritten tree is re-serialized then re-parsed (the canonical stored form), so the
    // synthetic spans here never surface — `Expr::synthetic` keeps construction terse.
    let rec = |x: &Expr| Box::new(rename_ident(x, from, to));
    match &e.kind {
        ExprKind::Ident(s) if s == from => Expr::synthetic(ExprKind::Ident(to.to_string())),
        ExprKind::Empty
        | ExprKind::Number(_)
        | ExprKind::Ident(_)
        | ExprKind::Symbol(_)
        | ExprKind::Error(_) => e.clone(),
        ExprKind::Group(inner) => Expr::synthetic(ExprKind::Group(rec(inner))),
        ExprKind::Call { head, args } => Expr::synthetic(ExprKind::Call {
            head: rec(head),
            args: args.iter().map(|a| rename_ident(a, from, to)).collect(),
        }),
        ExprKind::Sup { base, exp } => Expr::synthetic(ExprKind::Sup {
            base: rec(base),
            exp: rec(exp),
        }),
        ExprKind::Sub { base, sub } => Expr::synthetic(ExprKind::Sub {
            base: rec(base),
            sub: rec(sub),
        }),
        ExprKind::Unary { op, operand } => Expr::synthetic(ExprKind::Unary {
            op: *op,
            operand: rec(operand),
        }),
        ExprKind::Juxtapose(fs) => Expr::synthetic(ExprKind::Juxtapose(
            fs.iter().map(|f| rename_ident(f, from, to)).collect(),
        )),
        ExprKind::Frac { num, den, form } => Expr::synthetic(ExprKind::Frac {
            num: rec(num),
            den: rec(den),
            form: *form,
        }),
        ExprKind::Mul { lhs, rhs } => Expr::synthetic(ExprKind::Mul {
            lhs: rec(lhs),
            rhs: rec(rhs),
        }),
        ExprKind::Add { lhs, op, rhs } => Expr::synthetic(ExprKind::Add {
            lhs: rec(lhs),
            op: *op,
            rhs: rec(rhs),
        }),
        ExprKind::Rel { lhs, op, rhs } => Expr::synthetic(ExprKind::Rel {
            lhs: rec(lhs),
            op: op.clone(),
            rhs: rec(rhs),
        }),
    }
}
