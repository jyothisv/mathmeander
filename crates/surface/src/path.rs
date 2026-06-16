//! Sub-term addressing — the reserved `StructuralPath` (arch doc §6.3a/§6.1d/§14). A path
//! is the sequence of child indices (in the AST's canonical `Expr::children` order) from a
//! root expression to a sub-term. This is the shared foundation for future structural
//! (tree) editing and sub-term occurrence resolution: declared and *usable* now
//! (addressing + enumeration), but no slice-1 operation depends on it — a cheap
//! reservation, not a feature.

use crate::ast::Expr;

/// A stable path from an expression root to a sub-term (child indices, canonical order).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StructuralPath(pub Vec<usize>);

impl StructuralPath {
    pub fn root() -> Self {
        StructuralPath(Vec::new())
    }

    /// The path to the `i`-th child of the node this path addresses.
    pub fn child(&self, i: usize) -> Self {
        let mut v = self.0.clone();
        v.push(i);
        StructuralPath(v)
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }
}

/// Resolve a path against an expression, returning the addressed sub-term if it exists.
pub fn resolve<'a>(root: &'a Expr, path: &StructuralPath) -> Option<&'a Expr> {
    let mut cur = root;
    for &i in &path.0 {
        cur = *cur.children().get(i)?;
    }
    Some(cur)
}

/// Enumerate every sub-term with its path (pre-order) — the AST is sub-term-addressable.
pub fn enumerate(root: &Expr) -> Vec<(StructuralPath, &Expr)> {
    let mut out = Vec::new();
    walk(root, StructuralPath::root(), &mut out);
    out
}

fn walk<'a>(e: &'a Expr, path: StructuralPath, out: &mut Vec<(StructuralPath, &'a Expr)>) {
    let children = e.children();
    out.push((path.clone(), e));
    for (i, c) in children.into_iter().enumerate() {
        walk(c, path.child(i), out);
    }
}
