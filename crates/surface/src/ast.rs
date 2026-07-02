//! The internal `mathmeander` AST (arch doc §6.3a). NEVER serialized and NEVER in the
//! schema artifact — the wire form is the core's `MathExpression`, whose `surface_text` is
//! THIS tree's canonical serialization (`serializer.rs`). Designed **sub-term-addressable**
//! (every node reached by a `StructuralPath`, `path.rs`) so structural (tree) editing and
//! sub-term occurrence resolution are additive later (§14), not rewrites.
//!
//! Every node carries the `CharSpan` of the VERBATIM source it was parsed from (`Expr::span`),
//! so a `StructuralPath` maps to the exact source range no matter how the user typed it
//! (spacing, brackets, packing). This is the foundation for precise click + sub-expression
//! annotations: the click→source mapping reads `node.span` directly (`path::verbatim_paths`),
//! never a re-serialized canonical span. The span is metadata — `PartialEq` ignores it, so
//! equality stays purely STRUCTURAL (two trees are equal iff their `kind`s are).

use crate::span::CharSpan;

/// Author's syntactic fraction form (Model A, pure-lexical — the style lives in the
/// surface). The DISPLAY (built-up vs inline slash) is DERIVED from the form + operand
/// structure (`Expr::frac_built_up`), never a render-time policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FracForm {
    /// `a/b` — structural default: built up iff an operand is structured (the grammar rule).
    Slash,
    /// `a//b` — an explicit inline slash, always.
    SlashSlash,
    /// `frac(a, b)` — an explicit built-up fraction, always.
    FracCall,
}

/// Additive / unary sign.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddOp {
    Plus,
    Minus,
}

impl AddOp {
    pub fn as_str(self) -> &'static str {
        match self {
            AddOp::Plus => "+",
            AddOp::Minus => "-",
        }
    }
}

/// Multiplicative operator: `·` (scalar/ring, from `*`) vs `×` (Cartesian/cross, from `times`).
/// Same precedence (`BP_MUL`); only the rendered/serialized operator differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MulOp {
    /// `a * b` → `\cdot` (⋅).
    Cdot,
    /// `a times b` → `\times` (×).
    Cross,
}

/// One `mathmeander` expression node = its `kind` + the `span` of the verbatim source it was
/// parsed from. Constructed only by the parser (which stamps the real span) or by
/// structural-editing helpers (`Expr::synthetic`, span ignored — re-serialized/re-parsed). The
/// parser is TOTAL, so any input yields a valid tree (with `Error` nodes for recovered fragments).
#[derive(Debug, Clone)]
pub struct Expr {
    pub kind: ExprKind,
    /// The verbatim source range (`CharSpan`, code points) this node was parsed from. Excludes
    /// surrounding whitespace; includes structural delimiters the node owns (a `Group`'s parens,
    /// a `Call`'s `(...)`). `CharSpan::new(0,0)` on synthetically-built nodes (never reach
    /// `verbatim_paths`). NOT part of equality — see the `PartialEq` impl below.
    pub span: CharSpan,
}

/// `Expr` without its source span — the structural shape. Equality/`matches!` over an `Expr`
/// compares `kind` only (the manual `PartialEq` on `Expr`), so the span never affects it.
#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    /// Empty input (serializes to "").
    Empty,
    /// A numeric literal, verbatim ("42", "3.14").
    Number(String),
    /// A name atom — an ASCII identifier/name ("x", "alpha", "sum", "RR"). Rendered to a
    /// glyph by the render adapter; stored as the ASCII name (names-canonical, §6.3a).
    Ident(String),
    /// A single non-identifier symbol (e.g. a stray `!`, `|`, or a pasted Unicode glyph)
    /// preserved verbatim for round-trip and rendering.
    Symbol(String),
    /// A recovered un-parseable fragment, preserved VERBATIM (totality + §2.2). Marks the
    /// surface `partially_resolved` (some good content) or `invalid` (nothing usable).
    Error(String),
    /// A double-quoted text literal `"…"` (Typst): an upright multi-letter name or label (the
    /// escape hatch now that bare letter-runs segment). Content WITHOUT the quotes; renders
    /// `\text{…}` / `<mtext>`.
    Text(String),
    /// Explicit grouping `( .. )` — REMEMBERED (not flattened): both the slash/fraction
    /// rule and faithful round-trip depend on whether an operand was parenthesized.
    Group(Box<Expr>),
    /// A SET literal `{a, b, c}` (`{}` = the empty set): comma-separated elements between
    /// curly braces — first-class so a set is one addressable sub-term (annotation/click
    /// anchors bind the whole set, §6.2), rendered `\{a, b, c\}`.
    Set(Vec<Expr>),
    /// A TUPLE literal: a BARE parenthesized list of ≥2 comma-separated elements
    /// (`(a, b)`, `(Q, Sigma, delta)`) — first-class so a tuple is one addressable sub-term
    /// (§6.2), and STRICTLY distinct from the other paren roles: `(a + b)` (one element, no
    /// comma) stays `Group` (grouping semantics), and `f(x, y)` stays `Call` (head present).
    Tuple(Vec<Expr>),
    /// A TOP-LEVEL comma SEQUENCE — an enumeration with NO brackets (`a = L, R, S`,
    /// `x = 1, y = 2`): the loosest-binding construct, formed only at the parse root where a
    /// comma is not a bracket's element separator. Distinct from `Tuple` (parenthesized) so it
    /// serializes verbatim (`a, b`, never `(a, b)`); each element is one addressable sub-term.
    List(Vec<Expr>),
    /// Function application / structured form `head(args)`: `f(x)`, `sqrt(x)`, `cal(F)`,
    /// `mat(...)`. (`frac(a,b)` is parsed into `Frac` instead.)
    Call { head: Box<Expr>, args: Vec<Expr> },
    /// Superscript `base^exp` (postfix, tightest; chains onto the base, see `grammar`).
    Sup { base: Box<Expr>, exp: Box<Expr> },
    /// Subscript `base_sub` (postfix, tightest; chains onto the base, see `grammar`).
    Sub { base: Box<Expr>, sub: Box<Expr> },
    /// Unary sign `-x` / `+x`.
    Unary { op: AddOp, operand: Box<Expr> },
    /// Implicit multiplication by juxtaposition: `2 x`, `a b c` (always ≥ 2 factors).
    Juxtapose(Vec<Expr>),
    /// A fraction; `form` records the author's syntactic choice (display is derived).
    Frac {
        num: Box<Expr>,
        den: Box<Expr>,
        form: FracForm,
    },
    /// Explicit binary multiplication: `a * b` (`·`, `MulOp::Cdot`) or `a times b` (`×`, `Cross`).
    Mul {
        lhs: Box<Expr>,
        op: MulOp,
        rhs: Box<Expr>,
    },
    /// Additive `a + b` / `a - b`.
    Add {
        lhs: Box<Expr>,
        op: AddOp,
        rhs: Box<Expr>,
    },
    /// A relation `a = b`, `a <= b`, `x in S`, … (loosest; left-assoc). `op` is the
    /// canonical relation token (`grammar::RELATIONS`).
    Rel {
        lhs: Box<Expr>,
        op: String,
        rhs: Box<Expr>,
    },
}

/// STRUCTURAL equality — the source span is metadata, never part of identity (so `parse(s) ==
/// parse(canonical(s))` and the round-trip/idempotence proptests hold regardless of spacing).
/// `ExprKind`'s derived `PartialEq` recurses through `Box<Expr>`/`Vec<Expr>` children back into
/// this impl, so the span is ignored at every depth.
impl PartialEq for Expr {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind
    }
}

impl Expr {
    /// A node carrying its real verbatim source span (the parser's constructor).
    pub fn new(kind: ExprKind, span: CharSpan) -> Self {
        Expr { kind, span }
    }

    /// A node with no meaningful source span — for synthetically built trees (rewrite/import)
    /// that get re-serialized and re-parsed, so their spans never reach `verbatim_paths`.
    pub fn synthetic(kind: ExprKind) -> Self {
        Expr {
            kind,
            span: CharSpan::new(0, 0),
        }
    }

    /// Children in canonical order — the basis for `StructuralPath` addressing (`path.rs`).
    pub fn children(&self) -> Vec<&Expr> {
        match &self.kind {
            ExprKind::Empty
            | ExprKind::Number(_)
            | ExprKind::Ident(_)
            | ExprKind::Symbol(_)
            | ExprKind::Error(_)
            | ExprKind::Text(_) => {
                vec![]
            }
            ExprKind::Group(e) => vec![e.as_ref()],
            ExprKind::Set(elems) | ExprKind::Tuple(elems) | ExprKind::List(elems) => {
                elems.iter().collect()
            }
            ExprKind::Call { head, args } => {
                let mut v = vec![head.as_ref()];
                v.extend(args.iter());
                v
            }
            ExprKind::Sup { base, exp } => vec![base.as_ref(), exp.as_ref()],
            ExprKind::Sub { base, sub } => vec![base.as_ref(), sub.as_ref()],
            ExprKind::Unary { operand, .. } => vec![operand.as_ref()],
            ExprKind::Juxtapose(fs) => fs.iter().collect(),
            ExprKind::Frac { num, den, .. } => vec![num.as_ref(), den.as_ref()],
            ExprKind::Mul { lhs, rhs, .. } => vec![lhs.as_ref(), rhs.as_ref()],
            ExprKind::Add { lhs, rhs, .. } => vec![lhs.as_ref(), rhs.as_ref()],
            ExprKind::Rel { lhs, rhs, .. } => vec![lhs.as_ref(), rhs.as_ref()],
        }
    }

    /// Whether this node is "structured" for the slash/fraction rule (arch doc §6.3a): a
    /// grouped/structured operand makes a bare `/` build up.
    pub fn is_structured(&self) -> bool {
        matches!(
            &self.kind,
            ExprKind::Group(_)
                | ExprKind::Call { .. }
                | ExprKind::Sup { .. }
                | ExprKind::Sub { .. }
                | ExprKind::Frac { .. }
        )
    }

    /// Whether a fraction DISPLAYS built-up (vs an inline slash) — the derived Model-A
    /// decision the render adapters consult. Pure function of form + operand structure.
    pub fn frac_built_up(num: &Expr, den: &Expr, form: FracForm) -> bool {
        match form {
            FracForm::FracCall => true,
            FracForm::SlashSlash => false,
            FracForm::Slash => num.is_structured() || den.is_structured(),
        }
    }

    /// Whether the tree contains any recovered `Error` fragment.
    pub fn has_error(&self) -> bool {
        matches!(&self.kind, ExprKind::Error(_)) || self.children().iter().any(|c| c.has_error())
    }

    /// Whether the tree carries any real (non-empty, non-error) content.
    pub fn has_content(&self) -> bool {
        match &self.kind {
            ExprKind::Empty | ExprKind::Error(_) => false,
            ExprKind::Number(_) | ExprKind::Ident(_) | ExprKind::Symbol(_) | ExprKind::Text(_) => {
                true
            }
            _ => self.children().iter().any(|c| c.has_content()),
        }
    }
}
