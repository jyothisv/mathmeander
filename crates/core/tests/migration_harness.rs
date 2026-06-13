//! The migration-fixture harness (arch doc §6.3: "migration tests run against old
//! fixtures from day one"). This test GATES `CURRENT_SCHEMA_VERSION` itself:
//!   - every version 1..=CURRENT must have a non-empty `fixtures/v{n}/` directory
//!     (frozen serialized objects of that era), and
//!   - every version < CURRENT must have a registered migration function.
//!
//! Bumping the version without both is a red build — the harness can never be
//! "added later".

use mathmeander_core::CURRENT_SCHEMA_VERSION;
use mathmeander_core::migrate::{migration_from, parse_and_migrate_object};

// Reading fixture files is the documented test-only exception to the core's no-fs
// discipline (the crate itself stays pure; this is an integration test binary).
#[allow(clippy::disallowed_methods)]
fn fixture_files(version: u32) -> Vec<(String, serde_json::Value)> {
    let dir = format!("{}/fixtures/v{version}", env!("CARGO_MANIFEST_DIR"));
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|_| {
        panic!(
            "fixtures/v{version}/ is missing. Every schema version up to \
             CURRENT_SCHEMA_VERSION ({CURRENT_SCHEMA_VERSION}) must have frozen \
             fixtures — freeze the previous version's fixtures before bumping."
        )
    });
    let mut files: Vec<(String, serde_json::Value)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path()).expect("fixture readable");
            let value: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|err| panic!("fixture {name} is not valid JSON: {err}"));
            (name, value)
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

#[test]
fn every_version_has_fixtures_and_a_migration_path() {
    for version in 1..=CURRENT_SCHEMA_VERSION {
        let files = fixture_files(version);
        assert!(
            !files.is_empty(),
            "fixtures/v{version}/ exists but is empty — freeze at least one real fixture"
        );
        if version < CURRENT_SCHEMA_VERSION {
            assert!(
                migration_from(version).is_some(),
                "no migration registered for v{version} -> v{} — register it in \
                 crates/core/src/migrate.rs before bumping CURRENT_SCHEMA_VERSION",
                version + 1
            );
        }
    }
}

#[test]
fn fixtures_migrate_forward_non_destructively() {
    for version in 1..=CURRENT_SCHEMA_VERSION {
        for (name, stored) in fixture_files(version) {
            let label = format!("fixtures/v{version}/{name}");
            let object = parse_and_migrate_object(stored.clone())
                .unwrap_or_else(|e| panic!("{label} failed to migrate+parse: {e:?}"));

            assert_eq!(
                object.schema_version, CURRENT_SCHEMA_VERSION,
                "{label}: migrated object must land on the current version"
            );

            // Non-destructive: nothing the fixture carried may be lost or defaulted.
            let reserialized = serde_json::to_value(&object).expect("reserializes");
            let stored_obj = stored.as_object().expect("fixture is an object");
            for (key, original) in stored_obj {
                if key == "schema_version" {
                    continue; // the one field migration is ALLOWED to advance
                }
                let after = &reserialized[key];
                assert_eq!(
                    after, original,
                    "{label}: field {key} changed across migrate+parse+serialize \
                     (was {original}, now {after}) — migrations must be non-destructive"
                );
            }

            // Tri-state: a previously-unset field stays unset (never backfilled, §6.3).
            for tri_state_field in ["title", "raw_source"] {
                if !stored_obj.contains_key(tri_state_field) {
                    assert!(
                        reserialized
                            .get(tri_state_field)
                            .is_none_or(serde_json::Value::is_null),
                        "{label}: unset {tri_state_field} was backfilled by migration"
                    );
                }
            }
        }
    }
}

#[test]
fn future_schema_versions_are_refused_loudly() {
    let mut stored = fixture_files(1).remove(0).1;
    stored["schema_version"] = serde_json::json!(CURRENT_SCHEMA_VERSION + 1);
    let err = parse_and_migrate_object(stored).expect_err("future version must be refused");
    let serialized = serde_json::to_value(&err).expect("error serializes");
    assert_eq!(serialized["code"], "schema_version_from_the_future");
}
