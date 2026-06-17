//! mathmeander-surface — the owned math surface language (arch doc §5/§6.3a).
//!
//! A pure, I/O-free, framework-free crate that owns the `mathmeander` grammar: the
//! lexer, the Pratt parser, the internal AST (`Expr`), the canonical serializer, the
//! `normalize_fresh` keystone, the char-span model + span-remapping rewrite, the LaTeX
//! import/export adapters, and the KaTeX/MathML render transpilers. `parse_status` is
//! defined by OUR parser, not LaTeX's.
//!
//! Layering (arch doc §5): the integrity core depends on THIS crate, never the reverse —
//! so the surface owns no domain identity (object/expression ids live in the core). The
//! core's `MathExpression` wire type bundles a surface result (`surface_text`,
//! `parse_status`, occurrence spans) with that domain identity; the leaf types the surface
//! *produces* (`CharSpan`, `ParseStatus`, `SurfaceFormat`, `InputSyntax`) live here and are
//! re-exported by the core so the schema artifact carries them unchanged.
//!
//! Built for what's coming (arch doc §6.3a/§14, cheap reservations, not features): the
//! `Expr` AST is **sub-term-addressable** (`StructuralPath` — every node has a stable path)
//! and occurrence resolution is kept **span-based now, sub-term later**, so semantic/type
//! inference and structural (tree) editing are additive rather than rewrites.

#![forbid(unsafe_code)]

pub mod ast;
pub mod grammar;
pub mod latex;
pub mod lexer;
pub mod normalize;
pub mod parser;
pub mod path;
pub mod render;
pub mod rewrite;
pub mod serializer;
pub mod span;
pub mod status;
pub mod syntax;

pub mod migrate;

pub use ast::Expr;
pub use normalize::{Normalized, normalize_fresh};
pub use path::StructuralPath;
pub use rewrite::{RemapOutcome, SurfaceEdit, rewrite_with_remap};
pub use span::{ByteSpan, CharSpan};
pub use status::{InputSyntax, ParseStatus, SurfaceFormat};
pub use syntax::{SyntaxAdapter, adapter_for, transcode};

/// Version of the `mathmeander` GRAMMAR (arch doc §6.3a) — independent of the canonical
/// model's `schema_version`. Pinning the precedence table and the slash/fraction rule
/// (§13a.1) folds the grammar into the same migration discipline: changing the grammar in
/// a way that re-reads stored surfaces requires a `GRAMMAR_VERSION` bump + a registered
/// migration + frozen fixtures (see `migrate.rs` and `tests/grammar_migration.rs`).
pub const GRAMMAR_VERSION: u32 = 1;
