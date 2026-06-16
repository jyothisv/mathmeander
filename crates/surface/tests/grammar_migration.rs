//! The grammar-migration harness (arch doc §6.3a/§13a.1) — the surface's mirror of the
//! core's schema-migration harness. It GATES `GRAMMAR_VERSION`: every version up to current
//! must have a non-empty `fixtures/grammar_v{n}/`, and every version below current must
//! have a registered migration fn. The frozen fixtures are canonical surfaces that must
//! still round-trip under the current grammar — pinning the precedence + slash/fraction
//! rule (changing them so a fixture no longer round-trips requires a `GRAMMAR_VERSION` bump
//! + migration, not a silent change).
//!
//! NOTE: string round-trip is invariant under some precedence/associativity flips, so the
//! numeric ladder is pinned SEPARATELY by SHAPE in
//! `tests/grammar.rs::precedence_and_associativity_are_pinned_by_shape` — a flip there is a
//! red build, which is the migration discipline working (bump + migrate, don't flip silently).

use mathmeander_surface::GRAMMAR_VERSION;
use mathmeander_surface::migrate::migration_from;
use mathmeander_surface::parser::parse;
use mathmeander_surface::serializer::serialize;

// Reading fixture files is the documented test-only exception to the crate's no-fs
// discipline (the crate itself stays pure; this is an integration test binary).
#[allow(clippy::disallowed_methods)]
fn fixture_surfaces(version: u32) -> Vec<(String, String)> {
    let dir = format!("{}/fixtures/grammar_v{version}", env!("CARGO_MANIFEST_DIR"));
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|_| {
        panic!(
            "fixtures/grammar_v{version}/ is missing. Every grammar version up to \
             GRAMMAR_VERSION ({GRAMMAR_VERSION}) must have frozen fixtures."
        )
    });
    let mut files: Vec<(String, String)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "txt"))
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path()).expect("fixture readable");
            (name, text.trim().to_string())
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

#[test]
fn every_grammar_version_has_fixtures_and_a_migration_path() {
    for version in 1..=GRAMMAR_VERSION {
        let files = fixture_surfaces(version);
        assert!(
            !files.is_empty(),
            "fixtures/grammar_v{version}/ is empty — freeze at least one canonical surface"
        );
        if version < GRAMMAR_VERSION {
            assert!(
                migration_from(version).is_some(),
                "no grammar migration registered for v{version} -> v{} — register it in \
                 crates/surface/src/migrate.rs before bumping GRAMMAR_VERSION",
                version + 1
            );
        }
    }
}

#[test]
fn frozen_fixtures_are_canonical_under_the_current_grammar() {
    for version in 1..=GRAMMAR_VERSION {
        for (name, surface) in fixture_surfaces(version) {
            let label = format!("fixtures/grammar_v{version}/{name}");
            // The fixture is canonical: parsing then serializing reproduces it exactly,
            // and re-parsing is stable (the pinned grammar still reads it the same way).
            assert_eq!(
                serialize(&parse(&surface)),
                surface,
                "{label}: no longer canonical under the current grammar — bump \
                 GRAMMAR_VERSION + add a migration, don't change the grammar silently"
            );
        }
    }
}
