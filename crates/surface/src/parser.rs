//! The `mathmeander` Pratt parser (arch doc §6.3a, grammar pinned in `grammar.rs`). It is
//! TOTAL — it never panics and always returns an `Expr`; un-parseable fragments are
//! recovered as `Expr::Error` (preserved verbatim, §2.2) and reported as `ParseError`
//! diagnostics carrying a `ByteSpan`. Precedence and the slash/fraction rule are exactly
//! the pinned table; see `grammar.rs`.
//!
//! Every node is stamped with the `CharSpan` (code points) of the VERBATIM source it was
//! parsed from — the span runs from the first consumed token's start to the last consumed
//! token's end, so it EXCLUDES surrounding whitespace and INCLUDES the delimiters a node owns
//! (a `Group`'s parens, a `Call`'s `(...)`). This is what makes precise click / sub-expression
//! addressing robust regardless of how the user typed the surface (`path::verbatim_paths`).

use crate::ast::{AddOp, Expr, ExprKind, FracForm, MulOp};
use crate::dictionary;
use crate::grammar::{
    self, BP_ADD, BP_DIV, BP_JUXTAPOSE, BP_MUL, BP_REL, BP_UNARY_OPERAND, FRAC_HEAD, MAX_DEPTH,
};
use crate::lexer::{Tok, Token, lex};
use crate::span::{ByteSpan, CharSpan};

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
    // Prefix map byte offset → char count (code points before that byte), so token `ByteSpan`s
    // convert to wire `CharSpan`s in O(1). Token boundaries are always char boundaries, so only
    // boundary lookups matter; interior bytes carry the leading char's count (never read).
    let mut byte_to_char = vec![0u32; input.len() + 1];
    let mut chars = 0u32;
    for (b, c) in input.char_indices() {
        for slot in &mut byte_to_char[b..b + c.len_utf8()] {
            *slot = chars;
        }
        chars += 1;
    }
    byte_to_char[input.len()] = chars;

    let mut p = Parser {
        toks: lex(input),
        pos: 0,
        diags: Vec::new(),
        depth: 0,
        byte_to_char,
    };
    let mut e = p.parse_expr(0);
    // TOP-LEVEL comma SEQUENCE (`a = L, R, S` — an enumeration): a comma outside every bracket
    // separates co-equal expressions into a `List`, the loosest-binding construct. Root-only by
    // construction: inside `(…)`/`{…}` the bracket loops own their commas (Tuple/Set/Call
    // elements) and `parse_expr` stops at a comma, so one only reaches here at the root.
    // DEGENERATE commas never form a List (a bare `,`, a leading/trailing/double comma): a List
    // with Empty elements would serialize `", "` for a 1-char slice and break the verbatim
    // span property — those commas stay recovered `Error` fragments as before.
    if !matches!(e.kind, ExprKind::Empty) && matches!(p.peek(), Some(Tok::Comma)) {
        let mut elems = vec![e];
        while matches!(p.peek(), Some(Tok::Comma))
            && !matches!(
                p.toks.get(p.pos + 1).map(|t| &t.tok),
                None | Some(Tok::Comma) | Some(Tok::RParen) | Some(Tok::RBrace)
            )
        {
            p.bump();
            elems.push(p.parse_expr(0));
        }
        if elems.len() >= 2 {
            let span = CharSpan {
                start: elems.first().map_or(0, |x| x.span.start),
                end: elems.last().map_or(0, |x| x.span.end),
            };
            e = Expr::new(ExprKind::List(elems), span);
        } else {
            e = elems.pop().expect("the head element is always present");
        }
    }
    // Absorb any leftover tokens (e.g. an unmatched ')') as recovered fragments. Stray
    // terminators are consumed explicitly here (parse_atom leaves them for an enclosing
    // group/call, so without this the loop could not make progress on a top-level ')').
    while let Some(tok) = p.peek().cloned() {
        let frag = match tok {
            Tok::RParen | Tok::RBrace | Tok::Comma => {
                let span = p.peek_span();
                p.bump();
                p.diag("unexpected close/comma", span);
                Expr::new(ExprKind::Error(tok_text(&tok)), p.cspan(span))
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
    /// `byte_to_char[b]` = number of code points before byte `b` (for `ByteSpan → CharSpan`).
    byte_to_char: Vec<u32>,
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

    // ── Source-span bookkeeping ──────────────────────────────────────────────

    /// Byte offset of the next token to consume (a node's span START is captured here, before
    /// its first token is bumped). At EOF there is no token → use the end of the last one.
    fn mark(&self) -> usize {
        self.toks
            .get(self.pos)
            .map(|t| t.span.start)
            .unwrap_or_else(|| self.last_end())
    }

    /// Byte offset just past the last CONSUMED token (a node's span END, read after it's built).
    fn last_end(&self) -> usize {
        if self.pos == 0 {
            0
        } else {
            self.toks[self.pos - 1].span.end
        }
    }

    fn ch(&self, byte: usize) -> u32 {
        self.byte_to_char.get(byte).copied().unwrap_or(0)
    }

    fn cspan(&self, b: ByteSpan) -> CharSpan {
        CharSpan::new(self.ch(b.start), self.ch(b.end))
    }

    /// The span of a node whose first token started at byte `start` and whose last token has
    /// just been consumed (`start .. last_end()`, in code points).
    fn node_span(&self, start: usize) -> CharSpan {
        CharSpan::new(self.ch(start), self.ch(self.last_end()))
    }

    /// Like `node_span`, but the start is an already-computed CHAR offset (a left operand's
    /// `span.start`) — used by the Pratt folds, which extend a running `left`.
    fn span_from_char(&self, start_char: u32) -> CharSpan {
        CharSpan::new(start_char, self.ch(self.last_end()))
    }

    /// A zero-width span at byte `byte` (for `Empty`/`Error` recovery nodes that consume nothing).
    fn zero_at(&self, byte: usize) -> CharSpan {
        let c = self.ch(byte);
        CharSpan::new(c, c)
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
            return Expr::new(ExprKind::Error(String::new()), self.zero_at(self.mark()));
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
            Tok::Name(s) if dictionary::is_product_word(s) => Some(BP_MUL), // `times` → ×
            // value-starts → juxtaposition (implicit multiplication)
            Tok::Num(_) | Tok::Name(_) | Tok::Str(_) | Tok::LParen | Tok::LBrace | Tok::Sym(_) => {
                Some(BP_JUXTAPOSE)
            }
            // terminators / postfix scripts
            Tok::RParen | Tok::RBrace | Tok::Comma | Tok::Caret | Tok::Underscore => None,
        }
    }

    fn parse_infix(&mut self, left: Expr) -> Expr {
        // The whole infix node spans from the left operand's start to the RHS's end.
        let start = left.span.start;
        match self.peek().cloned() {
            Some(Tok::Slash) => {
                self.bump();
                let den = Box::new(self.parse_expr(BP_DIV));
                Expr::new(
                    ExprKind::Frac {
                        num: Box::new(left),
                        den,
                        form: FracForm::Slash,
                    },
                    self.span_from_char(start),
                )
            }
            Some(Tok::SlashSlash) => {
                self.bump();
                let den = Box::new(self.parse_expr(BP_DIV));
                Expr::new(
                    ExprKind::Frac {
                        num: Box::new(left),
                        den,
                        form: FracForm::SlashSlash,
                    },
                    self.span_from_char(start),
                )
            }
            Some(Tok::Star) => {
                self.bump();
                let rhs = Box::new(self.parse_expr(BP_MUL));
                Expr::new(
                    ExprKind::Mul {
                        lhs: Box::new(left),
                        op: MulOp::Cdot,
                        rhs,
                    },
                    self.span_from_char(start),
                )
            }
            // `times` (a product operator-word) → the × / Cartesian product.
            Some(Tok::Name(s)) if dictionary::is_product_word(&s) => {
                self.bump();
                let rhs = Box::new(self.parse_expr(BP_MUL));
                Expr::new(
                    ExprKind::Mul {
                        lhs: Box::new(left),
                        op: MulOp::Cross,
                        rhs,
                    },
                    self.span_from_char(start),
                )
            }
            Some(Tok::Plus) => {
                self.bump();
                let rhs = Box::new(self.parse_expr(BP_ADD));
                Expr::new(
                    ExprKind::Add {
                        lhs: Box::new(left),
                        op: AddOp::Plus,
                        rhs,
                    },
                    self.span_from_char(start),
                )
            }
            Some(Tok::Minus) => {
                self.bump();
                let rhs = Box::new(self.parse_expr(BP_ADD));
                Expr::new(
                    ExprKind::Add {
                        lhs: Box::new(left),
                        op: AddOp::Minus,
                        rhs,
                    },
                    self.span_from_char(start),
                )
            }
            Some(Tok::Rel(op)) => {
                self.bump();
                let rhs = Box::new(self.parse_expr(BP_REL));
                Expr::new(
                    ExprKind::Rel {
                        lhs: Box::new(left),
                        op,
                        rhs,
                    },
                    self.span_from_char(start),
                )
            }
            Some(Tok::Name(s)) if grammar::is_word_relation(&s) => {
                self.bump();
                let rhs = Box::new(self.parse_expr(BP_REL));
                Expr::new(
                    ExprKind::Rel {
                        lhs: Box::new(left),
                        op: s,
                        rhs,
                    },
                    self.span_from_char(start),
                )
            }
            // value-start → juxtaposition: parse one more factor and append.
            Some(Tok::Num(_) | Tok::Name(_) | Tok::Str(_) | Tok::LParen | Tok::Sym(_)) => {
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
        let start = self.mark();
        match self.peek() {
            Some(Tok::Plus) => {
                self.bump();
                let operand = Box::new(self.parse_expr(BP_UNARY_OPERAND));
                Expr::new(
                    ExprKind::Unary {
                        op: AddOp::Plus,
                        operand,
                    },
                    self.node_span(start),
                )
            }
            Some(Tok::Minus) => {
                self.bump();
                let operand = Box::new(self.parse_expr(BP_UNARY_OPERAND));
                Expr::new(
                    ExprKind::Unary {
                        op: AddOp::Minus,
                        operand,
                    },
                    self.node_span(start),
                )
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
                    let exp = Box::new(self.parse_script_operand());
                    let span = self.span_from_char(base.span.start);
                    base = Expr::new(
                        ExprKind::Sup {
                            base: Box::new(base),
                            exp,
                        },
                        span,
                    );
                }
                Some(Tok::Underscore) => {
                    self.bump();
                    chain += 1;
                    let sub = Box::new(self.parse_script_operand());
                    let span = self.span_from_char(base.span.start);
                    base = Expr::new(
                        ExprKind::Sub {
                            base: Box::new(base),
                            sub,
                        },
                        span,
                    );
                }
                // Postfix variant star: a `*` NOT followed by an operand (so it can't be the `·`
                // product `a*b`) and on a star-able base is the set-variant star `Z*` → desugar to
                // `Z^*` (a `Sup` with a `*` Symbol exp). An operand-following `*` is left for the
                // infix loop (the product); a NUMBER base (`2*`) is too (no `2^*` — see
                // `takes_postfix_star`).
                Some(Tok::Star)
                    if !self.is_operand_start_at(self.pos + 1) && takes_postfix_star(&base) =>
                {
                    let star_span = self.cspan(self.peek_span());
                    self.bump();
                    chain += 1;
                    let span = self.span_from_char(base.span.start);
                    base = Expr::new(
                        ExprKind::Sup {
                            base: Box::new(base),
                            exp: Box::new(Expr::new(ExprKind::Symbol("*".to_string()), star_span)),
                        },
                        span,
                    );
                }
                _ => break,
            }
        }
        base
    }

    /// Whether the token at `pos` BEGINS an operand (a value) — distinguishes an infix `*` (`a*b`,
    /// a value follows) from a postfix variant star (`Z*`, `Z* + 1`, `Z* in G`, EOF, …). A `Name`
    /// is an operand UNLESS it's a relation-word (`in`) or product-word (`times`), which are
    /// operators. Unary `+`/`-` are deliberately NOT operands here, so `Z* + 1` reads as `(Z*) + 1`
    /// (write `a*(-b)` for the rare "times a negative").
    fn is_operand_start_at(&self, pos: usize) -> bool {
        match self.toks.get(pos).map(|t| &t.tok) {
            Some(Tok::Num(_) | Tok::Str(_) | Tok::LParen | Tok::Sym(_)) => true,
            Some(Tok::Name(s)) => !grammar::is_word_relation(s) && !dictionary::is_product_word(s),
            _ => false,
        }
    }

    /// A script's argument: a tight operand — an optional unary sign then a single atom
    /// (`x^-1`, `x^(a+b)`, `a_n`). It does NOT grab juxtaposition or its own trailing
    /// scripts, so chaining stays in `parse_postfix`.
    fn parse_script_operand(&mut self) -> Expr {
        let start = self.mark();
        match self.peek() {
            Some(Tok::Plus) => {
                self.bump();
                let operand = Box::new(self.parse_atom());
                Expr::new(
                    ExprKind::Unary {
                        op: AddOp::Plus,
                        operand,
                    },
                    self.node_span(start),
                )
            }
            Some(Tok::Minus) => {
                self.bump();
                let operand = Box::new(self.parse_atom());
                Expr::new(
                    ExprKind::Unary {
                        op: AddOp::Minus,
                        operand,
                    },
                    self.node_span(start),
                )
            }
            _ => self.parse_atom(),
        }
    }

    /// A primary: group, number, name (or call / `frac`), symbol, or recovered error.
    fn parse_atom(&mut self) -> Expr {
        let start = self.mark();
        match self.peek().cloned() {
            // A non-consuming recovery node (missing operand at EOF) sits at `last_end()` — the end of
            // CONSUMED input — not at `start` (the next token's byte): with whitespace skipped, `start`
            // can fall PAST the enclosing node's end (which is also `last_end()`), so a zero-width Empty
            // there would escape its parent's span (breaking the child⊆parent nesting click/anchoring rely on).
            None => Expr::new(ExprKind::Empty, self.zero_at(self.last_end())),
            Some(Tok::LParen) => {
                self.bump();
                // A lone `(` sitting directly on a terminator (`(,` / `(}` / `(` at EOF) recovers as the
                // VERBATIM symbol — a `Group(Empty)` here would SERIALIZE as `()`, silently inserting a
                // paren the author never typed (the `{(, ], [}` → `{(), ], [}` bug). Mid-typing lenience is
                // preserved below: a NON-empty unclosed group (`(a + b`) still auto-closes.
                if !matches!(self.peek(), Some(Tok::RParen)) {
                    let empty_inner = matches!(self.peek(), None | Some(Tok::Comma | Tok::RBrace));
                    if empty_inner {
                        self.diag("unclosed '('", self.peek_span());
                        return Expr::new(ExprKind::Symbol("(".to_string()), self.node_span(start));
                    }
                }
                let inner = if matches!(self.peek(), Some(Tok::RParen)) {
                    Expr::new(ExprKind::Empty, self.zero_at(self.mark()))
                } else {
                    self.parse_expr(0)
                };
                // A comma after the first element makes this a BARE TUPLE `(e1, e2, …)` — first-class and
                // strictly distinct from `Group` (one element, grouping semantics) and `Call` (a head owns
                // its `(…)` and is parsed on the Name path, never here).
                if matches!(self.peek(), Some(Tok::Comma)) {
                    let mut elems = vec![inner];
                    while matches!(self.peek(), Some(Tok::Comma)) {
                        self.bump();
                        elems.push(self.parse_expr(0));
                    }
                    if matches!(self.peek(), Some(Tok::RParen)) {
                        self.bump();
                    } else {
                        self.diag("unclosed '('", self.peek_span());
                    }
                    return Expr::new(ExprKind::Tuple(elems), self.node_span(start));
                }
                if matches!(self.peek(), Some(Tok::RParen)) {
                    self.bump();
                } else {
                    self.diag("unclosed '('", self.peek_span());
                }
                Expr::new(ExprKind::Group(Box::new(inner)), self.node_span(start))
            }
            // The SET literal `{a, b, c}` (`{}` = the empty set): comma-separated elements, mirroring
            // `parse_call_args`. First-class so the whole set is ONE addressable sub-term (an annotation
            // or precise click binds `{L, S, R}` itself, not loose `{`/`,`/`}` fragments).
            Some(Tok::LBrace) => {
                self.bump();
                // A lone `{` sitting directly on a terminator recovers VERBATIM (mirrors the `(` rule):
                // a `Set` here would auto-close to `{}` and swallow the enclosing list's separators.
                if matches!(self.peek(), None | Some(Tok::Comma | Tok::RParen)) {
                    self.diag("unclosed '{'", self.peek_span());
                    return Expr::new(ExprKind::Symbol("{".to_string()), self.node_span(start));
                }
                let mut elems = Vec::new();
                if matches!(self.peek(), Some(Tok::RBrace)) {
                    self.bump();
                } else {
                    loop {
                        elems.push(self.parse_expr(0));
                        match self.peek() {
                            Some(Tok::Comma) => {
                                self.bump();
                            }
                            Some(Tok::RBrace) => {
                                self.bump();
                                break;
                            }
                            None => {
                                self.diag("unclosed '{'", self.peek_span());
                                break;
                            }
                            // parse_expr(0) stops only at ',' / ')' / '}' / EOF; bump defensively.
                            Some(_) => {
                                self.bump();
                            }
                        }
                    }
                }
                Expr::new(ExprKind::Set(elems), self.node_span(start))
            }
            Some(Tok::Num(s)) => {
                self.bump();
                Expr::new(ExprKind::Number(s), self.node_span(start))
            }
            Some(Tok::Name(s)) => {
                self.bump();
                // A name immediately followed by '(' is a call (or `frac(..)`).
                if matches!(self.peek(), Some(Tok::LParen)) {
                    let head_span = self.node_span(start); // just the name, before its args
                    let args = self.parse_call_args();
                    if s == FRAC_HEAD && args.len() == 2 {
                        let mut it = args.into_iter();
                        let num = Box::new(
                            it.next()
                                .unwrap_or_else(|| Expr::synthetic(ExprKind::Empty)),
                        );
                        let den = Box::new(
                            it.next()
                                .unwrap_or_else(|| Expr::synthetic(ExprKind::Empty)),
                        );
                        Expr::new(
                            ExprKind::Frac {
                                num,
                                den,
                                form: FracForm::FracCall,
                            },
                            self.node_span(start),
                        )
                    } else {
                        let head = Box::new(Expr::new(ExprKind::Ident(s), head_span));
                        Expr::new(ExprKind::Call { head, args }, self.node_span(start))
                    }
                } else {
                    Expr::new(ExprKind::Ident(s), self.node_span(start))
                }
            }
            Some(Tok::Str(s)) => {
                self.bump();
                Expr::new(ExprKind::Text(s), self.node_span(start))
            }
            Some(Tok::Sym(s)) => {
                self.bump();
                Expr::new(ExprKind::Symbol(s), self.node_span(start))
            }
            // A bare `*` in atom/script-operand position is the asterisk SYMBOL (not an error): it's
            // the exp of a variant star `Z^*` (and the desugar of postfix `Z*`), so both forms parse
            // to the SAME `Sup{exp: Symbol("*")}` tree — `Z^*` (the canonical/exported form) round-
            // trips cleanly instead of recovering as `Error("*")`. Infix `*` is consumed earlier.
            Some(Tok::Star) => {
                self.bump();
                Expr::new(ExprKind::Symbol("*".to_string()), self.node_span(start))
            }
            // Terminators belong to an enclosing group/call/arg-list: yield Empty WITHOUT
            // consuming (e.g. a missing operator RHS), so the enclosing `)` is not stolen.
            // A genuinely top-level stray terminator is consumed by the leftover loop.
            // Anchor at `last_end()` (not the terminator's byte): skipped whitespace before the
            // terminator would otherwise place this zero-width Empty past the parent's end (e.g.
            // `a+ )`), escaping the parent span — see the EOF arm above.
            Some(Tok::RParen | Tok::RBrace | Tok::Comma) => {
                Expr::new(ExprKind::Empty, self.zero_at(self.last_end()))
            }
            // A stray prefix operator where a value was expected → recover (consume it).
            Some(other) => {
                let span = self.peek_span();
                self.bump();
                self.diag(format!("unexpected {other:?}"), span);
                Expr::new(ExprKind::Error(tok_text(&other)), self.cspan(span))
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

/// Combine two expressions by juxtaposition, flattening and absorbing `Empty`. The resulting
/// `Juxtapose` node spans from the first factor's start to the last factor's end (a free
/// function, so it derives its span from the children's already-recorded spans).
fn juxtapose(left: Expr, right: Expr) -> Expr {
    if matches!(left.kind, ExprKind::Empty) {
        return right;
    }
    if matches!(right.kind, ExprKind::Empty) {
        return left;
    }
    let mut fs = into_factors(left);
    fs.extend(into_factors(right));
    let span = CharSpan::new(
        fs.first().map(|f| f.span.start).unwrap_or(0),
        fs.last().map(|f| f.span.end).unwrap_or(0),
    );
    Expr::new(ExprKind::Juxtapose(fs), span)
}

/// Flatten a node into juxtaposition factors: a `Juxtapose` spreads into its factors (each
/// keeps its own span); anything else is a single factor (keeping its span).
fn into_factors(e: Expr) -> Vec<Expr> {
    match e.kind {
        ExprKind::Juxtapose(v) => v,
        kind => vec![Expr { kind, span: e.span }],
    }
}

/// Whether the postfix variant star applies to `e`. The variant star is meaningful on a set/name
/// (`Z*`, `G^2*`, `(A×B)*`) but NOT on a bare NUMBER — `2^*` is nonsense, so `2*` is left to read as
/// an (incomplete) `·` product instead. `Empty`/`Error` bases (degenerate) are excluded too.
fn takes_postfix_star(e: &Expr) -> bool {
    !matches!(
        e.kind,
        ExprKind::Number(_) | ExprKind::Empty | ExprKind::Error(_)
    )
}

/// The raw surface text of a token (for verbatim `Expr::Error` recovery).
fn tok_text(t: &Tok) -> String {
    match t {
        Tok::Str(s) => format!("\"{s}\""),
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
        Tok::LBrace => "{".into(),
        Tok::RBrace => "}".into(),
        Tok::Comma => ",".into(),
    }
}
