//! The internal `mathmeander` AST (arch doc §6.3a). NEVER serialized and NEVER in the
//! schema artifact — the wire form is the core's `MathExpression`, whose `surface_text` is
//! THIS tree's canonical serialization (`serializer.rs`). Designed **sub-term-addressable**
//! (every node reached by a `StructuralPath`, `path.rs`) so structural (tree) editing and
//! sub-term occurrence resolution are additive later (§14), not rewrites.

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

/// One `mathmeander` expression node. Constructed only by the parser (or, later, by
/// structural-editing operations); the parser is TOTAL, so any input yields a valid tree
/// (with `Error` nodes for recovered fragments).
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
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
    /// Explicit grouping `( .. )` — REMEMBERED (not flattened): both the slash/fraction
    /// rule and faithful round-trip depend on whether an operand was parenthesized.
    Group(Box<Expr>),
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
    /// Explicit binary multiplication `a * b`.
    Mul { lhs: Box<Expr>, rhs: Box<Expr> },
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

impl Expr {
    /// Children in canonical order — the basis for `StructuralPath` addressing (`path.rs`).
    pub fn children(&self) -> Vec<&Expr> {
        match self {
            Expr::Empty | Expr::Number(_) | Expr::Ident(_) | Expr::Symbol(_) | Expr::Error(_) => {
                vec![]
            }
            Expr::Group(e) => vec![e.as_ref()],
            Expr::Call { head, args } => {
                let mut v = vec![head.as_ref()];
                v.extend(args.iter());
                v
            }
            Expr::Sup { base, exp } => vec![base.as_ref(), exp.as_ref()],
            Expr::Sub { base, sub } => vec![base.as_ref(), sub.as_ref()],
            Expr::Unary { operand, .. } => vec![operand.as_ref()],
            Expr::Juxtapose(fs) => fs.iter().collect(),
            Expr::Frac { num, den, .. } => vec![num.as_ref(), den.as_ref()],
            Expr::Mul { lhs, rhs } => vec![lhs.as_ref(), rhs.as_ref()],
            Expr::Add { lhs, rhs, .. } => vec![lhs.as_ref(), rhs.as_ref()],
            Expr::Rel { lhs, rhs, .. } => vec![lhs.as_ref(), rhs.as_ref()],
        }
    }

    /// Whether this node is "structured" for the slash/fraction rule (arch doc §6.3a): a
    /// grouped/structured operand makes a bare `/` build up.
    pub fn is_structured(&self) -> bool {
        matches!(
            self,
            Expr::Group(_)
                | Expr::Call { .. }
                | Expr::Sup { .. }
                | Expr::Sub { .. }
                | Expr::Frac { .. }
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
        matches!(self, Expr::Error(_)) || self.children().iter().any(|c| c.has_error())
    }

    /// Whether the tree carries any real (non-empty, non-error) content.
    pub fn has_content(&self) -> bool {
        match self {
            Expr::Empty | Expr::Error(_) => false,
            Expr::Number(_) | Expr::Ident(_) | Expr::Symbol(_) => true,
            _ => self.children().iter().any(|c| c.has_content()),
        }
    }
}
