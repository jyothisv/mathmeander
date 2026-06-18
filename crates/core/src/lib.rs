//! mathmeander-core — the integrity core (arch doc §5).
//!
//! A pure, I/O-free, framework-free crate: canonical types, validation, schema
//! migration, serialization, the canonical operations (`ops`), the numbering/display-name
//! projection (`numbering`), and the `.mathpack` manifest (`mathpack`). It never reads a
//! clock, file, environment variable, or socket — time and identity context are always
//! passed in by the caller.
//!
//! Design principle (arch doc §6): the core models mathematics in mathematicians'
//! vocabulary and must not be conflated with the editor/renderer layer (ProseMirror,
//! KaTeX), which lives only in the frontend adapters. A name may appear in both layers
//! (a graph `node` vs an editor `node`) when each is independently well-motivated in its
//! layer; what's forbidden is presentation concepts or shapes driving the core model.
//! Honored in design review, not by a name check.

#![forbid(unsafe_code)]
// The conformance corpus is one large json! literal (schema_artifact.rs).
#![recursion_limit = "1024"]

pub mod api;
pub mod error;
pub mod ids;
pub mod mathpack;
pub mod migrate;
pub mod model;
pub mod numbering;
pub mod ops;
pub mod patch;
#[cfg(feature = "schema-artifact")]
pub mod schema_artifact;
pub mod validate;

/// Application-level schema version of the canonical model (arch doc §6.3). Bumping it
/// requires a total migration function + frozen fixtures — enforced by the migration
/// harness (setup step 5), which gates this constant itself.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The core crate version (compile-time constant; the FFI handshake primitive).
pub fn core_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn core_version_matches_workspace() {
        assert_eq!(super::core_version(), "0.1.0");
    }
}
