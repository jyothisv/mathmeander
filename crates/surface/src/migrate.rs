//! Grammar migration (arch doc §6.3a/§13a.1) — the surface's mirror of the core's
//! schema-version migration discipline (`mathmeander-core::migrate`). Pinning grammar v1
//! means a later change to the precedence table or the slash/fraction rule that re-reads
//! stored surfaces is a `GRAMMAR_VERSION` bump, gated by `tests/grammar_migration.rs`:
//! bumping requires a registered migration fn for every prior version AND frozen
//! `fixtures/grammar_v{n}/`. With `GRAMMAR_VERSION = 1` there is nothing to register yet.

use crate::GRAMMAR_VERSION;

/// A total grammar migration step `v_n → v_{n+1}` over a stored surface string. Must be
/// non-destructive (it re-canonicalizes the surface under the new grammar).
pub type GrammarMigrationFn = fn(&str) -> String;

/// Registry: `migration_from(n)` returns the step taking grammar `n` to `n + 1`.
pub fn migration_from(version: u32) -> Option<GrammarMigrationFn> {
    #[allow(clippy::match_single_binding)] // the registry's shape is the point
    match version {
        _ => None,
    }
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
