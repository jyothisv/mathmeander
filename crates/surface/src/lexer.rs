//! The `mathmeander` lexer (arch doc §6.3a). TOTAL: every input character becomes some
//! token (unknown characters — including pasted Unicode glyphs — become `Sym`, preserved
//! verbatim for round-trip), so the lexer never fails. Whitespace is skipped but its
//! presence is recorded (`preceded_by_space`) so the parser can tell `f(x)` (a call) from
//! `f (x)` is NOT needed in v1 — kept for future use. Byte spans are tracked; the
//! parser/boundary convert them to wire `CharSpan`s.

use crate::dictionary::is_known_name;
use crate::span::ByteSpan;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tok {
    /// A numeric literal (digits with at most one interior `.`).
    Num(String),
    /// An ASCII identifier/name. v2: a maximal letter-run is one `Name` only if it's a known
    /// dictionary name (`sin`, `RR`, `in`, …); otherwise it splits into one single-letter `Name`
    /// per letter (so `aa` → `a`,`a`). Trailing combining marks fold onto the (last) letter.
    Name(String),
    /// A double-quoted text literal `"…"` (Typst): the content WITHOUT the surrounding quotes.
    Str(String),
    Plus,
    Minus,
    Star,
    /// `/`
    Slash,
    /// `//`
    SlashSlash,
    /// `^`
    Caret,
    /// `_`
    Underscore,
    LParen,
    RParen,
    Comma,
    /// A symbolic relation operator (one of `grammar::SYMBOLIC_RELATIONS`).
    Rel(String),
    /// Any other single character (preserved verbatim): `!`, `|`, `&`, Unicode glyphs, …
    Sym(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub tok: Tok,
    pub span: ByteSpan,
    /// Whether whitespace immediately preceded this token (reserved; unused in v1).
    pub preceded_by_space: bool,
}

/// Tokenize `input` totally. The returned vector never includes whitespace; spans index
/// into `input` bytes.
pub fn lex(input: &str) -> Vec<Token> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut pending_space = false;
    let n = bytes.len();

    while i < n {
        let start = i;
        let c = bytes[i];

        // Whitespace (ASCII only; other Unicode spaces fall through to Sym, harmlessly).
        if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
            i += 1;
            pending_space = true;
            continue;
        }

        let mk = |tok: Tok, start: usize, end: usize, sp: bool| Token {
            tok,
            span: ByteSpan::new(start, end),
            preceded_by_space: sp,
        };

        // Numbers: digits with at most one interior '.'.
        if c.is_ascii_digit() {
            i += 1;
            let mut seen_dot = false;
            while i < n {
                let d = bytes[i];
                if d.is_ascii_digit() {
                    i += 1;
                } else if d == b'.' && !seen_dot && i + 1 < n && bytes[i + 1].is_ascii_digit() {
                    seen_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            absorb_combining(input, &mut i);
            out.push(mk(
                Tok::Num(input[start..i].to_string()),
                start,
                i,
                pending_space,
            ));
            pending_space = false;
            continue;
        }

        // Names: a maximal run of ASCII letters (+ trailing combining marks). v2 segmentation:
        // a KNOWN dictionary name stays ONE `Name`; any other run splits into one single-letter
        // `Name` per letter, so `aa`→`a`,`a` while `sin`/`RR`/`in` stay whole. Each split letter
        // gets its own span (so each is independently addressable via `path::verbatim_paths`).
        if c.is_ascii_alphabetic() {
            i += 1;
            while i < n && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            let letters_end = i;
            absorb_combining(input, &mut i);
            let combine_end = i;
            let run = &input[start..letters_end]; // pure ASCII letters (no combining marks)
            if is_known_name(run) {
                // Whole name; combining marks fold onto it (as in v1).
                out.push(mk(
                    Tok::Name(input[start..combine_end].to_string()),
                    start,
                    combine_end,
                    pending_space,
                ));
            } else {
                // Split per letter. The LAST letter absorbs any trailing combining-mark suffix
                // (so a base+mark grapheme is never split). Letters are ASCII (1 byte each), so
                // byte index == char boundary throughout — totality preserved.
                let mut first = true;
                for j in start..letters_end {
                    let end = if j == letters_end - 1 {
                        combine_end
                    } else {
                        j + 1
                    };
                    out.push(mk(
                        Tok::Name(input[j..end].to_string()),
                        j,
                        end,
                        first && pending_space,
                    ));
                    first = false;
                }
            }
            pending_space = false;
            continue;
        }

        // String/text literal `"…"` (Typst): the content WITHOUT the quotes, verbatim. Total — an
        // unterminated string runs to EOF. No escapes in v1 (a `"` always closes), so the content
        // can never contain a `"` and round-trips as `"…"`.
        if c == b'"' {
            let content_start = (i + 1).min(n);
            i = content_start;
            while i < n && bytes[i] != b'"' {
                i = (i + utf8_char_len(bytes[i])).min(n); // advance whole chars (no mid-char slice)
            }
            let content = input.get(content_start..i).unwrap_or("").to_string();
            if i < n {
                i += 1; // consume the closing quote
            }
            out.push(mk(Tok::Str(content), start, i, pending_space));
            pending_space = false;
            continue;
        }

        // Multi-char and single-char operators (longest match first). Matching is on raw
        // BYTES — every operator is ASCII, and byte-slicing into a multibyte char would
        // panic (totality), so the non-ASCII tail falls straight through to the Sym arm.
        let next = bytes.get(i + 1).copied();
        let tok = match (c, next) {
            (b'/', Some(b'/')) => {
                i += 2;
                Tok::SlashSlash
            }
            (b'<', Some(b'=')) => {
                i += 2;
                Tok::Rel("<=".into())
            }
            (b'>', Some(b'=')) => {
                i += 2;
                Tok::Rel(">=".into())
            }
            (b'!', Some(b'=')) => {
                i += 2;
                Tok::Rel("!=".into())
            }
            (b':', Some(b'=')) => {
                i += 2;
                Tok::Rel(":=".into())
            }
            (b'-', Some(b'>')) => {
                i += 2;
                Tok::Rel("->".into())
            }
            (b'=', Some(b'>')) => {
                i += 2;
                Tok::Rel("=>".into())
            }
            (b'/', _) => {
                i += 1;
                Tok::Slash
            }
            (b'+', _) => {
                i += 1;
                Tok::Plus
            }
            (b'-', _) => {
                i += 1;
                Tok::Minus
            }
            (b'*', _) => {
                i += 1;
                Tok::Star
            }
            (b'^', _) => {
                i += 1;
                Tok::Caret
            }
            (b'_', _) => {
                i += 1;
                Tok::Underscore
            }
            (b'(', _) => {
                i += 1;
                Tok::LParen
            }
            (b')', _) => {
                i += 1;
                Tok::RParen
            }
            (b',', _) => {
                i += 1;
                Tok::Comma
            }
            (b'=', _) => {
                i += 1;
                Tok::Rel("=".into())
            }
            (b'<', _) => {
                i += 1;
                Tok::Rel("<".into())
            }
            (b'>', _) => {
                i += 1;
                Tok::Rel(">".into())
            }
            _ => {
                // Any other byte/char: consume ONE full UTF-8 char, plus any trailing
                // combining marks, preserved verbatim as one Sym.
                let ch_len = utf8_char_len(bytes[i]);
                let mut end = (i + ch_len).min(n);
                absorb_combining(input, &mut end);
                let sym = input.get(i..end).unwrap_or("\u{FFFD}").to_string();
                i = end;
                Tok::Sym(sym)
            }
        };
        out.push(mk(tok, start, i, pending_space));
        pending_space = false;
    }

    out
}

/// Advance `*at` over any run of Unicode combining marks starting there, so a mark binds
/// to the preceding atom instead of lexing as a standalone `Sym` (which the serializer
/// would then juxtapose with a space, splitting the grapheme: `e`+U+0301 → `e ́`). Char-safe.
fn absorb_combining(input: &str, at: &mut usize) {
    while *at < input.len() {
        match input[*at..].chars().next() {
            Some(c) if is_combining(c) => *at += c.len_utf8(),
            _ => break,
        }
    }
}

/// Whether `c` is a combining mark (the Unicode blocks that attach to a base glyph,
/// including the math-relevant "Combining Diacritical Marks for Symbols" — e.g. the
/// combining vector arrow U+20D7). Not exhaustive of all `Mark` categories, but covers the
/// blocks that occur on math atoms; the standard library exposes no category table and the
/// pure crate may not pull a Unicode-data dependency.
fn is_combining(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F   // Combining Diacritical Marks
        | 0x1AB0..=0x1AFF // Combining Diacritical Marks Extended
        | 0x1DC0..=0x1DFF // Combining Diacritical Marks Supplement
        | 0x20D0..=0x20FF // Combining Diacritical Marks for Symbols
        | 0xFE20..=0xFE2F // Combining Half Marks
    )
}

/// Byte length of the UTF-8 char beginning with `lead` (1..=4); 1 for any continuation/
/// invalid lead, so progress is always made (totality).
fn utf8_char_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead >> 5 == 0b110 {
        2
    } else if lead >> 4 == 0b1110 {
        3
    } else if lead >> 3 == 0b11110 {
        4
    } else {
        1
    }
}
