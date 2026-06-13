//! Schema migration (arch doc §5/§6.3): total, non-destructive functions
//! `v_n → v_{n+1}` over serialized canonical values. The registry + fixture harness
//! land from DAY ONE (§6.3) — bumping `CURRENT_SCHEMA_VERSION` without registering a
//! migration function AND freezing fixtures for the prior version is a red build
//! (see the harness test in `tests/migration_harness.rs`).
//!
//! `migrate_to_current` sits on the PRODUCTION READ PATH (every object read flows
//! through it via `api::parse_and_migrate_object`), so migration is wired into the
//! system, not a test-only artifact.

use serde_json::Value;

use crate::CURRENT_SCHEMA_VERSION;
use crate::error::{CoreError, ValidationError};
use crate::model::CanonicalObject;

/// A total migration step from version `n` to `n + 1`. Must be non-destructive:
/// unknown fields pass through untouched; never-set fields are never backfilled
/// with defaults (§6.3 tri-state discipline).
pub type MigrationFn = fn(Value) -> Result<Value, CoreError>;

/// The registry. `migration_from(n)` returns the step taking `n` to `n + 1`.
/// With CURRENT_SCHEMA_VERSION = 1 there is nothing to register yet; the first real
/// entry arrives with the first shape change, gated by the harness.
pub fn migration_from(version: u32) -> Option<MigrationFn> {
    #[allow(clippy::match_single_binding)] // the registry's shape is the point
    match version {
        _ => None,
    }
}

fn stored_schema_version(value: &Value) -> Result<u32, CoreError> {
    value
        .get("schema_version")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| CoreError::MalformedInput {
            context: "stored object".into(),
            message: "missing or non-integer schema_version".into(),
        })
}

/// Migrate a stored canonical-object value to the current schema version.
pub fn migrate_to_current(mut value: Value) -> Result<Value, CoreError> {
    let given = stored_schema_version(&value)?;
    if given > CURRENT_SCHEMA_VERSION {
        // Refusing loudly beats misreading user data (§2.2).
        return Err(ValidationError::SchemaVersionFromTheFuture {
            given,
            current: CURRENT_SCHEMA_VERSION,
        }
        .into());
    }
    for step in given..CURRENT_SCHEMA_VERSION {
        let migrate = migration_from(step).ok_or_else(|| CoreError::MalformedInput {
            context: "migration registry".into(),
            message: format!("no migration registered for v{step} -> v{}", step + 1),
        })?;
        value = migrate(value)?;
        let now_at = stored_schema_version(&value)?;
        if now_at != step + 1 {
            return Err(CoreError::MalformedInput {
                context: "migration registry".into(),
                message: format!(
                    "migration for v{step} produced schema_version {now_at}, expected {}",
                    step + 1
                ),
            });
        }
    }
    Ok(value)
}

/// The read path: stored JSON → migrated → validated canonical object.
pub fn parse_and_migrate_object(stored: Value) -> Result<CanonicalObject, CoreError> {
    let migrated = migrate_to_current(stored)?;
    serde_json::from_value(migrated).map_err(|e| CoreError::MalformedInput {
        context: "stored object".into(),
        message: e.to_string(),
    })
}
