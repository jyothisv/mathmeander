//! napi bindings for mathmeander-core. One-line delegations only — no logic lives here.

use napi_derive::napi;

/// FFI handshake primitive: the compiled core's version.
#[napi]
pub fn core_version() -> String {
    mathmeander_core::core_version().to_string()
}

/// sha256 of the schema artifact derived from the core code this addon was compiled
/// against (embedded at build time). The glue compares it to @mathmeander/schema's
/// generated ARTIFACT_HASH at boot and refuses to start on mismatch.
#[napi]
pub fn artifact_hash() -> String {
    include_str!(concat!(env!("OUT_DIR"), "/artifact_hash.txt")).to_string()
}

/// Application-level schema version of the canonical model (arch doc §6.3).
#[napi]
pub fn current_schema_version() -> u32 {
    mathmeander_core::CURRENT_SCHEMA_VERSION
}

// ── The core api (arch doc §5): JSON strings in, result-envelope JSON out. ──
// Calls are COARSE (whole document per call, never per-field) — the §17 seam stays
// non-hot-path. Domain failures come back as `{ok:false,error}` values, never throws.

/// Create an object: input + server context + space + now → `CreateObjectResult` JSON.
#[napi]
pub fn create_object(
    input_json: String,
    ctx_json: String,
    space_id: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::create_object(&input_json, &ctx_json, &space_id, &now_iso)
}

/// Patch object metadata (pure) → `ObjectResult` JSON.
#[napi]
pub fn apply_title_patch(current_json: String, patch_json: String, now_iso: String) -> String {
    mathmeander_core::api::apply_title_patch(&current_json, &patch_json, &now_iso)
}

/// The read path: stored JSON → migrate → validate → `ObjectResult` JSON.
#[napi]
pub fn parse_and_migrate_object(stored_json: String) -> String {
    mathmeander_core::api::parse_and_migrate_object(&stored_json)
}
