//! User-defined notation as a post-parse RENDER pass (Tier B — "notation as a register").
//!
//! A notation entry maps a *trigger* (an AST pattern) to an *expansion* (an AST). Notation is **not
//! consumed**: the canonical `surface_text` keeps the literal trigger (e.g. `Z*`); only RENDERING
//! resolves it (`Z*` → `ZZ^*` → ℤ\*). This pass operates on an already-parsed [`Expr`] and never
//! touches the canonical surface — in particular it is kept OUT of `normalize_fresh` (the keystone,
//! whose absence of a scope parameter is the safety invariant). Scope is passed in, never stored,
//! exactly like `NumberingPolicy` is passed into numbering.
//!
//! Hygiene & termination: each entry's expansion is resolved ONCE against the entries defined
//! *before* it (frozen at definition time, excluding the entry's own trigger). So masking works —
//! `NN := ": NN -> NN"` denotes `: ℕ -> ℕ`, with the bodily `NN` left as the builtin (rendered ℕ),
//! no recursion — and a scope is cycle-free by construction. At use time a matched node is replaced
//! by its frozen expansion and **not re-scanned** (match-and-stop), so substitution cannot loop.

use crate::ast::{Expr, ExprKind};
use crate::parser::parse;

/// A generous cap on the nodes produced while building/resolving a notation expansion. Real notation is a
/// handful of nodes; this only trips on pathological input where eager substitution would blow up
/// exponentially (a doubling chain `Ci := C(i-1) + C(i-1)`) or unboundedly deep (a composition chain) and
/// FREEZE the main thread (resolution runs in WASM per render). On overflow the definition is DROPPED
/// (degrade to literal). Bounds depth too (depth ≤ node count), so it also prevents the deep-composition
/// stack overflow.
const NOTATION_NODE_BUDGET: usize = 10_000;

/// Max recursion depth while resolving (matches the parser's own cap). A single parsed expression can't
/// exceed it, but COMPOSITION by substitution can make the combined depth unbounded — a deep-but-thin chain
/// (`Di := (D(i-1)) + 1`) stays under the node budget yet would overflow the wasm stack in `resolve` AND in
/// the render emitter (an uncatchable trap). Capping resolved-tree depth keeps both stack-safe; on overflow
/// the budget is drained so the builder drops the entry (B2).
const MAX_RESOLVE_DEPTH: usize = 256;

/// One notation: a trigger AST pattern → its (frozen) expansion AST.
#[derive(Debug, Clone)]
pub struct NotationEntry {
    pub trigger: Expr,
    pub expansion: Expr,
}

/// A resolved notation registry — the document-scope value passed into rendering. Built in
/// definition order so each expansion freezes against the entries before it.
#[derive(Debug, Clone, Default)]
pub struct NotationScope {
    pub entries: Vec<NotationEntry>,
}

impl NotationScope {
    /// The empty scope. `resolve_notation(e, &empty)` is structurally `e` — today's grammar, unchanged.
    pub fn empty() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Build a scope from `(trigger, expansion)` source pairs, in order. Each expansion is parsed and
    /// resolved against the entries defined *before* it (frozen-prior-scope) — so masking and
    /// composition work and the registry is acyclic by construction (an expansion can only reference
    /// prior entries).
    pub fn from_definitions<S: AsRef<str>>(defs: &[(S, S)]) -> Self {
        let mut scope = Self::empty();
        for (trigger_src, expansion_src) in defs {
            let trigger = parse(trigger_src.as_ref());
            // Skip a trigger that would over-match (C2): an `Empty` or a parse `Error` fragment (e.g.
            // `) := X` → `Error(")")`) structurally equals every such stray node in the doc, so it would
            // rewrite unrelated renders. Such a definition is ignored.
            if !is_matchable_trigger(&trigger) {
                continue;
            }
            // Build the expansion under a NODE BUDGET. Eager substitution against prior entries can blow up
            // exponentially (a doubling chain) or arbitrarily deep (a composition chain); on overflow DROP the
            // entry (its trigger then renders literally) rather than store a multi-million-node expansion that
            // would freeze every render (B1/B2). Real notation is tiny and never trips this.
            let mut budget = NOTATION_NODE_BUDGET;
            let expansion = resolve_bounded(&parse(expansion_src.as_ref()), &scope, &mut budget, 0);
            if budget == 0 {
                continue; // overflow → degrade to literal
            }
            scope.entries.push(NotationEntry { trigger, expansion });
        }
        scope
    }
}

/// Resolve notation in a parsed expression, for RENDERING: structurally replace any subtree equal to a
/// trigger with that trigger's (frozen) expansion — top-down and **match-and-stop** (a substituted
/// expansion is never re-scanned). Operates on the `Expr` only; the canonical surface is untouched.
///
/// Structural equality ignores `span` (see the `PartialEq for Expr` impl in `ast`), so a trigger matches
/// wherever the user typed the same form, regardless of spacing. NOTE — matching is WHOLE-SUB-EXPRESSION
/// only (C1): a trigger matches a complete parsed subtree, and the parse is CONTEXT-SENSITIVE, so an
/// overloaded operator can parse differently in different contexts. E.g. with `Z* := ZZ^*`, a lone `Z*`
/// parses as `Sup{Z,*}` and matches, but in `Z* Z*` the first `Z*` is part of a `Mul` (`*` as multiply) and
/// does NOT match. Triggers are most reliable as self-delimiting forms; this is an inherent limit of
/// register-style notation (never a canonical-surface issue — the literal trigger is always preserved).
pub fn resolve_notation(expr: &Expr, scope: &NotationScope) -> Expr {
    let mut budget = NOTATION_NODE_BUDGET;
    resolve_bounded(expr, scope, &mut budget, 0)
}

/// Resolve under a node budget (decremented per produced node) AND a depth cap. When either is hit,
/// substitution STOPS and the remaining subtree is cloned literally, and the budget is DRAINED to 0 so the
/// builder (`from_definitions`) sees the overflow and drops the offending entry. Total work and resolved-tree
/// depth are therefore both bounded, no matter how explosively/deeply the scope could expand.
fn resolve_bounded(expr: &Expr, scope: &NotationScope, budget: &mut usize, depth: usize) -> Expr {
    if *budget == 0 || depth >= MAX_RESOLVE_DEPTH {
        *budget = 0; // signal overflow (node or depth) to the builder; also stops further work
        return expr.clone(); // degrade to the literal subtree
    }
    *budget -= 1;
    for entry in &scope.entries {
        if *expr == entry.trigger {
            // match-and-stop: splice the FROZEN expansion (never re-scanned for triggers). Re-walk it under
            // the EMPTY scope so its nodes/depth count against the caps — a big expansion can't splice free.
            return resolve_bounded(&entry.expansion, &NotationScope::empty(), budget, depth + 1);
        }
    }
    Expr {
        kind: resolve_kind(&expr.kind, scope, budget, depth),
        span: expr.span,
    }
}

/// A trigger that can match a real sub-expression. `Empty` / parse-`Error` triggers would over-match every
/// such fragment in the doc, so they are excluded from a scope (C2).
fn is_matchable_trigger(trigger: &Expr) -> bool {
    !matches!(trigger.kind, ExprKind::Empty | ExprKind::Error(_))
}

fn boxed(e: &Expr, scope: &NotationScope, budget: &mut usize, depth: usize) -> Box<Expr> {
    Box::new(resolve_bounded(e, scope, budget, depth))
}

fn resolve_kind(
    kind: &ExprKind,
    scope: &NotationScope,
    budget: &mut usize,
    depth: usize,
) -> ExprKind {
    let d = depth + 1; // children are one level deeper
    match kind {
        // Leaves — nothing to recurse into.
        ExprKind::Empty
        | ExprKind::Number(_)
        | ExprKind::Ident(_)
        | ExprKind::Symbol(_)
        | ExprKind::Error(_)
        | ExprKind::Text(_) => kind.clone(),

        ExprKind::Group(inner) => ExprKind::Group(boxed(inner, scope, budget, d)),
        ExprKind::Tuple(elems) => ExprKind::Tuple(
            elems
                .iter()
                .map(|el| resolve_bounded(el, scope, budget, d))
                .collect(),
        ),
        ExprKind::List(elems) => ExprKind::List(
            elems
                .iter()
                .map(|el| resolve_bounded(el, scope, budget, d))
                .collect(),
        ),
        ExprKind::Set(elems) => ExprKind::Set(
            elems
                .iter()
                .map(|el| resolve_bounded(el, scope, budget, d))
                .collect(),
        ),
        ExprKind::Call { head, args } => ExprKind::Call {
            head: boxed(head, scope, budget, d),
            args: args
                .iter()
                .map(|a| resolve_bounded(a, scope, budget, d))
                .collect(),
        },
        ExprKind::Sup { base, exp } => ExprKind::Sup {
            base: boxed(base, scope, budget, d),
            exp: boxed(exp, scope, budget, d),
        },
        ExprKind::Sub { base, sub } => ExprKind::Sub {
            base: boxed(base, scope, budget, d),
            sub: boxed(sub, scope, budget, d),
        },
        ExprKind::Unary { op, operand } => ExprKind::Unary {
            op: *op,
            operand: boxed(operand, scope, budget, d),
        },
        ExprKind::Juxtapose(items) => ExprKind::Juxtapose(
            items
                .iter()
                .map(|i| resolve_bounded(i, scope, budget, d))
                .collect(),
        ),
        ExprKind::Frac { num, den, form } => ExprKind::Frac {
            num: boxed(num, scope, budget, d),
            den: boxed(den, scope, budget, d),
            form: *form,
        },
        ExprKind::Mul { lhs, op, rhs } => ExprKind::Mul {
            lhs: boxed(lhs, scope, budget, d),
            op: *op,
            rhs: boxed(rhs, scope, budget, d),
        },
        ExprKind::Add { lhs, op, rhs } => ExprKind::Add {
            lhs: boxed(lhs, scope, budget, d),
            op: *op,
            rhs: boxed(rhs, scope, budget, d),
        },
        ExprKind::Rel { lhs, op, rhs } => ExprKind::Rel {
            lhs: boxed(lhs, scope, budget, d),
            op: op.clone(),
            rhs: boxed(rhs, scope, budget, d),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four worked examples from the plan, in definition order.
    fn scope4() -> NotationScope {
        NotationScope::from_definitions(&[
            ("Z*", "ZZ^*"),
            ("Z*2", "ZZ^* times ZZ^*"),
            ("NN", ": NN -> NN"),
            ("N2NN", "NN -> NN x NN"),
        ])
    }

    #[test]
    fn empty_scope_is_identity() {
        let e = parse("Z* + 1");
        assert_eq!(resolve_notation(&e, &NotationScope::empty()), e);
    }

    #[test]
    fn z_star_resolves_to_blackboard() {
        let scope = NotationScope::from_definitions(&[("Z*", "ZZ^*")]);
        assert_eq!(resolve_notation(&parse("Z*"), &scope), parse("ZZ^*"));
    }

    #[test]
    fn z_star_resolves_in_context_keeping_surroundings() {
        let scope = NotationScope::from_definitions(&[("Z*", "ZZ^*")]);
        assert_eq!(
            resolve_notation(&parse("Z* + 1"), &scope),
            parse("ZZ^* + 1")
        );
    }

    #[test]
    fn superscript_attaches_outside_the_trigger() {
        // Boxing-safe: in `(Z*)^2` the base expands and the `^2` stays outside the substitution.
        let scope = NotationScope::from_definitions(&[("Z*", "ZZ^*")]);
        assert_eq!(
            resolve_notation(&parse("(Z*)^2"), &scope),
            parse("(ZZ^*)^2")
        );
    }

    #[test]
    fn nn_masks_to_its_redefinition_without_recursion() {
        let scope = scope4();
        // `NN` denotes `: NN -> NN`; the bodily `NN` are the builtin (render ℕ). Returning at all
        // proves there is no infinite expansion (match-and-stop).
        assert_eq!(resolve_notation(&parse("NN"), &scope), parse(": NN -> NN"));
    }

    #[test]
    fn n2nn_freezes_against_the_prior_redefinition() {
        let scope = scope4();
        let resolved = resolve_notation(&parse("N2NN"), &scope);
        // Its own trigger is gone (it expanded) ...
        assert_ne!(resolved, parse("N2NN"));
        // ... and it froze the redefined `NN` in, so it differs from the naive, un-frozen body.
        assert_ne!(resolved, parse("NN -> NN x NN"));
    }

    #[test]
    fn original_symbol_reachable_via_canonical_form() {
        let scope = scope4();
        // Notation shadows the *spelling* `NN`, not the symbol — `bb(N)` is never touched.
        assert_eq!(resolve_notation(&parse("bb(N)"), &scope), parse("bb(N)"));
    }

    /// Count the nodes of an `Expr` (test helper for the expansion caps).
    fn node_count(e: &Expr) -> usize {
        1 + match &e.kind {
            ExprKind::Empty
            | ExprKind::Number(_)
            | ExprKind::Ident(_)
            | ExprKind::Symbol(_)
            | ExprKind::Error(_)
            | ExprKind::Text(_) => 0,
            ExprKind::Group(inner) | ExprKind::Unary { operand: inner, .. } => node_count(inner),
            ExprKind::Set(elems) | ExprKind::Tuple(elems) | ExprKind::List(elems) => {
                elems.iter().map(node_count).sum()
            }
            ExprKind::Call { head, args } => {
                node_count(head) + args.iter().map(node_count).sum::<usize>()
            }
            ExprKind::Sup { base: a, exp: b }
            | ExprKind::Sub { base: a, sub: b }
            | ExprKind::Frac { num: a, den: b, .. }
            | ExprKind::Mul { lhs: a, rhs: b, .. }
            | ExprKind::Add { lhs: a, rhs: b, .. }
            | ExprKind::Rel { lhs: a, rhs: b, .. } => node_count(a) + node_count(b),
            ExprKind::Juxtapose(items) => items.iter().map(node_count).sum(),
        }
    }

    #[test]
    fn doubling_chain_is_bounded_not_exponential() {
        // `Ci := C(i-1) + C(i-1)` is 2^i nodes unguarded (a measured multi-second main-thread freeze). The
        // node budget drops entries that would overflow, so the build COMPLETES (this test returning at all
        // is the no-freeze proof) and every render stays within the budget.
        let mut defs: Vec<(String, String)> = vec![("C0".into(), "x".into())];
        for i in 1..40 {
            defs.push((format!("C{i}"), format!("C{} + C{}", i - 1, i - 1)));
        }
        let scope = NotationScope::from_definitions(&defs);
        let resolved = resolve_notation(&parse("C39"), &scope);
        assert!(node_count(&resolved) <= NOTATION_NODE_BUDGET + 1);
    }

    #[test]
    fn deep_composition_chain_is_bounded() {
        // `Di := (D(i-1)) + 1` composes unbounded DEPTH (would overflow the wasm stack in resolve + the
        // render emitter). The depth cap bounds it, so resolution returns instead of trapping.
        let mut defs: Vec<(String, String)> = vec![("D0".into(), "x".into())];
        for i in 1..500 {
            defs.push((format!("D{i}"), format!("(D{}) + 1", i - 1)));
        }
        let scope = NotationScope::from_definitions(&defs);
        let resolved = resolve_notation(&parse("D499"), &scope);
        assert!(node_count(&resolved) <= NOTATION_NODE_BUDGET + 1);
    }

    #[test]
    fn deeply_nested_def_source_is_safe() {
        // The PARSE-time boundary the resolve caps don't cover: a single def whose SOURCE is pathologically
        // deep. The parser's own MAX_DEPTH cap recovers it (an `Error` fragment past the cap, the rest picked
        // up flat), so building the scope can't overflow the stack at parse time, and the stored/rendered tree
        // stays bounded. Returning here at all is the no-overflow proof.
        let deep = format!("{}1{}", "(".repeat(5000), ")".repeat(5000));
        let scope = NotationScope::from_definitions(&[("X", deep.as_str())]);
        let resolved = resolve_notation(&parse("X + 1"), &scope);
        assert!(node_count(&resolved) <= NOTATION_NODE_BUDGET + 1);
    }

    #[test]
    fn unmatchable_triggers_are_skipped() {
        // A parse-error / empty trigger would structurally match stray error fragments across the doc; both
        // are excluded, so a scope built from only such defs is empty (an unrelated `)`-error is untouched).
        let scope = NotationScope::from_definitions(&[(")", "X"), ("", "Y")]);
        assert!(scope.entries.is_empty());
    }
}
