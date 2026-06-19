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

/// Create a `journal_day` surface: input + context + space + date + now → `CreateJournalDayResult`
/// JSON (§6.5). The glue persists the (object, provenance, detail) triplet in one transaction.
#[napi]
pub fn create_journal_day(
    input_json: String,
    ctx_json: String,
    space_id: String,
    date_str: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::create_journal_day(
        &input_json,
        &ctx_json,
        &space_id,
        &date_str,
        &now_iso,
    )
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

// ── Slice 1c canonical operations: content (+ current rows) + input + ctx + now → ──
// `OpOutcomeResult` JSON. One-line delegations; all logic is in the core.

/// Set a unit's type → `OpOutcomeResult` JSON.
#[napi]
pub fn set_unit_type(
    content_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::set_unit_type(&content_json, &input_json, &ctx_json, &now_iso)
}

/// Split a prose unit → `OpOutcomeResult` JSON.
#[napi]
pub fn split_unit(
    content_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::split_unit(&content_json, &input_json, &ctx_json, &now_iso)
}

/// Merge two prose units (current taggings passed in) → `OpOutcomeResult` JSON.
#[napi]
pub fn merge_units(
    content_json: String,
    current_taggings_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::merge_units(
        &content_json,
        &current_taggings_json,
        &input_json,
        &ctx_json,
        &now_iso,
    )
}

/// Toggle an expression's inline/display placement → `OpOutcomeResult` JSON.
#[napi]
pub fn toggle_expression_placement(
    content_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::toggle_expression_placement(
        &content_json,
        &input_json,
        &ctx_json,
        &now_iso,
    )
}

/// Rewrite a surface, re-anchoring inbound edges (current links passed in) → `OpOutcomeResult` JSON.
#[napi]
pub fn rewrite_surface(
    content_json: String,
    current_links_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::rewrite_surface(
        &content_json,
        &current_links_json,
        &input_json,
        &ctx_json,
        &now_iso,
    )
}

/// Insert a reference edge → `OpOutcomeResult` JSON.
#[napi]
pub fn insert_reference(
    content_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::insert_reference(&content_json, &input_json, &ctx_json, &now_iso)
}

/// Resolve an occurrence to a target → `OpOutcomeResult` JSON.
#[napi]
pub fn resolve_occurrence(
    content_json: String,
    input_json: String,
    ctx_json: String,
    now_iso: String,
) -> String {
    mathmeander_core::api::resolve_occurrence(&content_json, &input_json, &ctx_json, &now_iso)
}

/// Materialize a copy-and-edge object (input carries the source) → `OpOutcomeResult` JSON.
#[napi]
pub fn materialize_object(input_json: String, ctx_json: String, now_iso: String) -> String {
    mathmeander_core::api::materialize_object(&input_json, &ctx_json, &now_iso)
}

/// Re-home a declared subtree into a new object (the §9.y greedy-capture materialize; input carries
/// the host) → `OpOutcomeResult` JSON (a two-object outcome).
#[napi]
pub fn rehome_subtree(input_json: String, ctx_json: String, now_iso: String) -> String {
    mathmeander_core::api::rehome_subtree(&input_json, &ctx_json, &now_iso)
}

/// Dissolve a materialized object back into its host (input carries host + dissolved content + inbound
/// refs) → `OpOutcomeResult` JSON.
#[napi]
pub fn dissolve_object(input_json: String, ctx_json: String, now_iso: String) -> String {
    mathmeander_core::api::dissolve_object(&input_json, &ctx_json, &now_iso)
}

// ── Slice 1d projections + packaging. ──

/// Project display labels (policy passed in) → `NumberingResult` JSON.
#[napi]
pub fn project_numbering(
    units_json: String,
    aliases_json: String,
    handles_json: String,
    policy_json: String,
) -> String {
    mathmeander_core::api::project_numbering(
        &units_json,
        &aliases_json,
        &handles_json,
        &policy_json,
    )
}

/// Build an export bundle → `MathpackResult` JSON.
#[napi]
pub fn export_mathpack(meta_json: String, graph_json: String, now_iso: String) -> String {
    mathmeander_core::api::export_mathpack(&meta_json, &graph_json, &now_iso)
}

/// Validate + migrate + echo an imported bundle → `MathpackImportResult` JSON.
#[napi]
pub fn import_mathpack(bundle_json: String) -> String {
    mathmeander_core::api::import_mathpack(&bundle_json)
}
