//! The `mathmeander` Pratt parser (arch doc §6.3a, grammar pinned in `grammar.rs`). It is
//! TOTAL — it never panics and always returns an `Expr`; un-parseable fragments are
//! recovered as `Expr::Error` (preserved verbatim, §2.2) and reported as `ParseError`
//! diagnostics carrying a `ByteSpan`. Precedence and the slash/fraction rule are exactly
//! the pinned table; see `grammar.rs`.

use crate::ast::{AddOp, Expr, FracForm};
use crate::grammar::{
    self, BP_ADD, BP_DIV, BP_JUXTAPOSE, BP_MUL, BP_REL, BP_UNARY_OPERAND, FRAC_HEAD, MAX_DEPTH,
};
use crate::lexer::{Tok, Token, lex};
use crate::span::ByteSpan;

/// A recovered parse problem (the parser is total; this is a diagnostic, not a failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub span: ByteSpan,
}

/// Parse `input` into a (total) `Expr`, discarding diagnostics.
pub fn parse(input: &str) -> Expr {
    parse_with_diagnostics(input).0
}

/// Parse `input` totally, returning the tree and any recovered-error diagnostics.
pub fn parse_with_diagnostics(input: &str) -> (Expr, Vec<ParseError>) {
    let mut p = Parser {
        toks: lex(input),
        pos: 0,
        diags: Vec::new(),
        depth: 0,
    };
    let mut e = p.parse_expr(0);
    // Absorb any leftover tokens (e.g. an unmatched ')') as recovered fragments. Stray
    // terminators are consumed explicitly here (parse_atom leaves them for an enclosing
    // group/call, so without this the loop could not make progress on a top-level ')').
    while let Some(tok) = p.peek().cloned() {
        let frag = match tok {
            Tok::RParen | Tok::Comma => {
                let span = p.peek_span();
                p.bump();
                p.diag("unexpected close/comma", span);
                Expr::Error(tok_text(&tok))
            }
            _ => p.parse_prefix(),
        };
        e = juxtapose(e, frag);
    }
    (e, p.diags)
}

struct Parser {
    toks: Vec<Token>,
    pos: usize,
    diags: Vec<ParseError>,
    /// Current recursive-descent depth (nesting). Bounded by `MAX_DEPTH` so untrusted deep
    /// input can never overflow the stack (an abort, not a catchable panic).
    depth: u32,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos).map(|t| &t.tok)
    }

    fn peek_span(&self) -> ByteSpan {
        self.toks
            .get(self.pos)
            .map(|t| t.span)
            .unwrap_or(ByteSpan::new(0, 0))
    }

    fn bump(&mut self) -> Option<Token> {
        let t = self.toks.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn diag(&mut self, message: impl Into<String>, span: ByteSpan) {
        self.diags.push(ParseError {
            message: message.into(),
            span,
        });
    }

    // ── Pratt core ───────────────────────────────────────────────────────────

    fn parse_expr(&mut self, min_bp: u8) -> Expr {
        // Depth guard (totality): all recursive descent funnels through here (group/call
        // args, unary operand, infix RHS, script operand→atom→group). Past the cap, stop
        // descending and recover — the unconsumed tokens are picked up flat by the leftover
        // loop, so nothing is lost and the resulting tree stays shallow enough to drop /
        // serialize without overflowing.
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            self.diag("expression nesting too deep", self.peek_span());
            return Expr::Error(String::new());
        }
        let mut left = self.parse_prefix();
        // `chain` bounds left-associative SPINES (`1+1+…`, built by this loop, not by
        // recursion): each combine deepens the tree by one even though the call stack stays
        // flat, so a long chain must also stop at the depth cap.
        let mut chain = 0u32;
        while let Some(lbp) = self.infix_lbp() {
            if lbp <= min_bp {
                break;
            }
            chain += 1;
            if self.depth + chain > MAX_DEPTH {
                break;
            }
            left = self.parse_infix(left);
        }
        self.depth -= 1;
        left
    }

    /// The left binding power of the token at the cursor, if it can continue an expression
    /// (as an infix operator OR as a juxtaposition value-start). `None` ends the loop.
    /// Scripts (`^`/`_`) are NOT here: they are postfix, consumed in `parse_postfix` right
    /// after their base, so they attach to the base and combine (`x_i^2` = `(x_i)^2`).
    fn infix_lbp(&self) -> Option<u8> {
        match self.peek()? {
            Tok::Slash | Tok::SlashSlash => Some(BP_DIV),
            Tok::Star => Some(BP_MUL),
            Tok::Plus | Tok::Minus => Some(BP_ADD),
            Tok::Rel(_) => Some(BP_REL),
            Tok::Name(s) if grammar::is_word_relation(s) => Some(BP_REL),
            // value-starts → juxtaposition (implicit multiplication)
            Tok::Num(_) | Tok::Name(_) | Tok::LParen | Tok::Sym(_) => Some(BP_JUXTAPOSE),
            // terminators / postfix scripts
            Tok::RParen | Tok::Comma | Tok::Caret | Tok::Underscore => None,
        }
    }

    fn parse_infix(&mut self, left: Expr) -> Expr {
        match self.peek().cloned() {
            Some(Tok::Slash) => {
                self.bump();
                let den = self.parse_expr(BP_DIV);
                Expr::Frac {
                    num: Box::new(left),
                    den: Box::new(den),
                    form: FracForm::Slash,
                }
            }
            Some(Tok::SlashSlash) => {
                self.bump();
                let den = self.parse_expr(BP_DIV);
                Expr::Frac {
                    num: Box::new(left),
                    den: Box::new(den),
                    form: FracForm::SlashSlash,
                }
            }
            Some(Tok::Star) => {
                self.bump();
                let rhs = self.parse_expr(BP_MUL);
                Expr::Mul {
                    lhs: Box::new(left),
                    rhs: Box::new(rhs),
                }
            }
            Some(Tok::Plus) => {
                self.bump();
                let rhs = self.parse_expr(BP_ADD);
                Expr::Add {
                    lhs: Box::new(left),
                    op: AddOp::Plus,
                    rhs: Box::new(rhs),
                }
            }
            Some(Tok::Minus) => {
                self.bump();
                let rhs = self.parse_expr(BP_ADD);
                Expr::Add {
                    lhs: Box::new(left),
                    op: AddOp::Minus,
                    rhs: Box::new(rhs),
                }
            }
            Some(Tok::Rel(op)) => {
                self.bump();
                let rhs = self.parse_expr(BP_REL);
                Expr::Rel {
                    lhs: Box::new(left),
                    op,
                    rhs: Box::new(rhs),
                }
            }
            Some(Tok::Name(s)) if grammar::is_word_relation(&s) => {
                self.bump();
                let rhs = self.parse_expr(BP_REL);
                Expr::Rel {
                    lhs: Box::new(left),
                    op: s,
                    rhs: Box::new(rhs),
                }
            }
            // value-start → juxtaposition: parse one more factor and append.
            Some(Tok::Num(_) | Tok::Name(_) | Tok::LParen | Tok::Sym(_)) => {
                let rhs = self.parse_expr(BP_JUXTAPOSE);
                juxtapose(left, rhs)
            }
            // infix_lbp only returns Some for the arms above, so this is unreachable.
            _ => left,
        }
    }

    // ── Prefix / primary ───────────────────────────────────────────────────────

    /// The left operand of an expression: a unary sign (whose operand is a sub-expression
    /// up to `BP_DIV`, so `-x^2` = `-(x^2)` and `-a/b` = `(-a)/b`) or a scripted primary.
    fn parse_prefix(&mut self) -> Expr {
        match self.peek() {
            Some(Tok::Plus) => {
                self.bump();
                Expr::Unary {
                    op: AddOp::Plus,
                    operand: Box::new(self.parse_expr(BP_UNARY_OPERAND)),
                }
            }
            Some(Tok::Minus) => {
                self.bump();
                Expr::Unary {
                    op: AddOp::Minus,
                    operand: Box::new(self.parse_expr(BP_UNARY_OPERAND)),
                }
            }
            _ => self.parse_postfix(),
        }
    }

    /// An atom followed by zero or more postfix scripts (`^`/`_`), which CHAIN onto the
    /// running base and so combine (`x_i^2` = `(x_i)^2`, `x^2_i` likewise) — the standard
    /// math convention, left-associative. Scripts are the tightest construct (§ grammar).
    fn parse_postfix(&mut self) -> Expr {
        let mut base = self.parse_atom();
        // Like the infix loop, a script CHAIN (`x^x^…`) deepens the tree per iteration
        // without growing the call stack, so it shares the depth cap.
        let mut chain = 0u32;
        loop {
            if self.depth + chain >= MAX_DEPTH {
                break;
            }
            match self.peek() {
                Some(Tok::Caret) => {
                    self.bump();
                    chain += 1;
                    base = Expr::Sup {
                        base: Box::new(base),
                        exp: Box::new(self.parse_script_operand()),
                    };
                }
                Some(Tok::Underscore) => {
                    self.bump();
                    chain += 1;
                    base = Expr::Sub {
                        base: Box::new(base),
                        sub: Box::new(self.parse_script_operand()),
                    };
                }
                _ => break,
            }
        }
        base
    }

    /// A script's argument: a tight operand — an optional unary sign then a single atom
    /// (`x^-1`, `x^(a+b)`, `a_n`). It does NOT grab juxtaposition or its own trailing
    /// scripts, so chaining stays in `parse_postfix`.
    fn parse_script_operand(&mut self) -> Expr {
        match self.peek() {
            Some(Tok::Plus) => {
                self.bump();
                Expr::Unary {
                    op: AddOp::Plus,
                    operand: Box::new(self.parse_atom()),
                }
            }
            Some(Tok::Minus) => {
                self.bump();
                Expr::Unary {
                    op: AddOp::Minus,
                    operand: Box::new(self.parse_atom()),
                }
            }
            _ => self.parse_atom(),
        }
    }

    /// A primary: group, number, name (or call / `frac`), symbol, or recovered error.
    fn parse_atom(&mut self) -> Expr {
        match self.peek().cloned() {
            None => Expr::Empty,
            Some(Tok::LParen) => {
                self.bump();
                let inner = if matches!(self.peek(), Some(Tok::RParen)) {
                    Expr::Empty
                } else {
                    self.parse_expr(0)
                };
                if matches!(self.peek(), Some(Tok::RParen)) {
                    self.bump();
                } else {
                    self.diag("unclosed '('", self.peek_span());
                }
                Expr::Group(Box::new(inner))
            }
            Some(Tok::Num(s)) => {
                self.bump();
                Expr::Number(s)
            }
            Some(Tok::Name(s)) => {
                self.bump();
                // A name immediately followed by '(' is a call (or `frac(..)`).
                if matches!(self.peek(), Some(Tok::LParen)) {
                    let args = self.parse_call_args();
                    if s == FRAC_HEAD && args.len() == 2 {
                        let mut it = args.into_iter();
                        let num = it.next().unwrap_or(Expr::Empty);
                        let den = it.next().unwrap_or(Expr::Empty);
                        Expr::Frac {
                            num: Box::new(num),
                            den: Box::new(den),
                            form: FracForm::FracCall,
                        }
                    } else {
                        Expr::Call {
                            head: Box::new(Expr::Ident(s)),
                            args,
                        }
                    }
                } else {
                    Expr::Ident(s)
                }
            }
            Some(Tok::Sym(s)) => {
                self.bump();
                Expr::Symbol(s)
            }
            // Terminators belong to an enclosing group/call/arg-list: yield Empty WITHOUT
            // consuming (e.g. a missing operator RHS), so the enclosing `)` is not stolen.
            // A genuinely top-level stray terminator is consumed by the leftover loop.
            Some(Tok::RParen | Tok::Comma) => Expr::Empty,
            // A stray prefix operator where a value was expected → recover (consume it).
            Some(other) => {
                let span = self.peek_span();
                self.bump();
                self.diag(format!("unexpected {other:?}"), span);
                Expr::Error(tok_text(&other))
            }
        }
    }

    /// Parse `( arg , arg , … )` after a call head; assumes the cursor is at `(`.
    fn parse_call_args(&mut self) -> Vec<Expr> {
        self.bump(); // consume '('
        let mut args = Vec::new();
        if matches!(self.peek(), Some(Tok::RParen)) {
            self.bump();
            return args;
        }
        loop {
            args.push(self.parse_expr(0));
            match self.peek() {
                Some(Tok::Comma) => {
                    self.bump();
                }
                Some(Tok::RParen) => {
                    self.bump();
                    break;
                }
                None => {
                    self.diag("unclosed call '('", self.peek_span());
                    break;
                }
                // parse_expr(0) stops only at ',' / ')' / EOF, so this is unreachable;
                // bump one token defensively to guarantee progress.
                Some(_) => {
                    self.bump();
                }
            }
        }
        args
    }
}

/// Combine two expressions by juxtaposition, flattening and absorbing `Empty`.
fn juxtapose(left: Expr, right: Expr) -> Expr {
    match (left, right) {
        (Expr::Empty, r) => r,
        (l, Expr::Empty) => l,
        (Expr::Juxtapose(mut fs), Expr::Juxtapose(rs)) => {
            fs.extend(rs);
            Expr::Juxtapose(fs)
        }
        (Expr::Juxtapose(mut fs), r) => {
            fs.push(r);
            Expr::Juxtapose(fs)
        }
        (l, Expr::Juxtapose(rs)) => {
            let mut fs = vec![l];
            fs.extend(rs);
            Expr::Juxtapose(fs)
        }
        (l, r) => Expr::Juxtapose(vec![l, r]),
    }
}

/// The raw surface text of a token (for verbatim `Expr::Error` recovery).
fn tok_text(t: &Tok) -> String {
    match t {
        Tok::Num(s) | Tok::Name(s) | Tok::Rel(s) | Tok::Sym(s) => s.clone(),
        Tok::Plus => "+".into(),
        Tok::Minus => "-".into(),
        Tok::Star => "*".into(),
        Tok::Slash => "/".into(),
        Tok::SlashSlash => "//".into(),
        Tok::Caret => "^".into(),
        Tok::Underscore => "_".into(),
        Tok::LParen => "(".into(),
        Tok::RParen => ")".into(),
        Tok::Comma => ",".into(),
    }
}
