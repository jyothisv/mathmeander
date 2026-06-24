//! Grammar migration (arch doc §6.3a/§13a.1) — the surface's mirror of the core's
//! schema-version migration discipline (`mathmeander-core::migrate`). A change to the
//! precedence table / slash-fraction rule / tokenization that re-reads stored surfaces is a
//! `GRAMMAR_VERSION` bump, gated by `tests/grammar_migration.rs`: bumping requires a registered
//! migration fn for every prior version AND frozen `fixtures/grammar_v{n}/`.

use crate::GRAMMAR_VERSION;
use crate::parser::parse;
use crate::serializer::serialize;

/// A total grammar migration step `v_n → v_{n+1}` over a stored surface string. Must be
/// non-destructive (it re-canonicalizes the surface under the new grammar).
pub type GrammarMigrationFn = fn(&str) -> String;

/// Registry: `migration_from(n)` returns the step taking grammar `n` to `n + 1`.
pub fn migration_from(version: u32) -> Option<GrammarMigrationFn> {
    match version {
        1 | 2 => Some(recanonicalize),
        _ => None,
    }
}

/// Re-canonicalize a stored surface under the CURRENT grammar (the v1→v2 step, and the shape of
/// any reparse-based step). `serialize∘parse` is a fixpoint, so chaining these collapses to a
/// single reparse-under-current — exactly the current canonical form. Under v2's dictionary
/// segmentation this turns e.g. a stored `dy/dx` into `d y/d x` (the multi-letter `dy`/`dx` now
/// read as the products `d·y`/`d·x`; an author who meant the differential re-authors as `"dy"`).
fn recanonicalize(surface: &str) -> String {
    serialize(&parse(surface))
}

/// Migrate a stored surface from grammar version `from` up to the current `GRAMMAR_VERSION`
/// (total). An unregistered step stops the walk rather than panicking — the *gate* is the
/// migration harness test, not a runtime failure.
pub fn migrate_surface_to_current(surface: &str, from: u32) -> String {
    let mut s = surface.to_string();
    let mut v = from;
    while v < GRAMMAR_VERSION {
        match migration_from(v) {
            Some(f) => {
                s = f(&s);
                v += 1;
            }
            None => break,
        }
    }
    s
}
