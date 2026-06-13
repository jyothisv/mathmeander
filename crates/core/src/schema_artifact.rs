//! The versioned schema artifact (arch doc §7): a single JSON Schema document emitted
//! FROM the core's types, consumed by codegen to produce zod validators + TS types.
//! Pure string-building — the I/O of writing files lives in mathmeander-schema-gen; the
//! hashing lives in the shells (schema-gen, core-node's build.rs).
//!
//! Every exported type is FULLY INLINED under $defs (no cross-$ref) so the TS generator
//! handles each definition independently. Revisit when MathContent's recursive unions
//! land (the bespoke-emitter fallback is behind this same artifact contract).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Value, json};

use crate::api::{CreateObjectResult, CreatedObject, ObjectResult};
use crate::error::{CoreError, ValidationError};
use crate::model::{CanonicalObject, ObjectStatus, ObjectType, Origin, Provenance};
use crate::validate::{CreateContext, CreateObjectInput, ObjectPatch};

/// Version of the ARTIFACT FORMAT itself (not the canonical-model schema_version).
pub const ARTIFACT_VERSION: u32 = 1;

fn inline_schema_for<T: JsonSchema>() -> Value {
    let mut settings = SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    let generator = settings.into_generator();
    let schema = generator.into_root_schema_for::<T>();
    let mut value = serde_json::to_value(schema).expect("schema serializes to JSON");
    // The per-def `$schema` key is noise once defs are embedded in the artifact document.
    if let Some(obj) = value.as_object_mut() {
        obj.remove("$schema");
    }
    value
}

/// The canonical artifact document, deterministically ordered, newline-terminated.
/// The artifact hash everywhere in the system is sha256 over EXACTLY these bytes.
pub fn artifact_json() -> String {
    let mut defs: BTreeMap<&'static str, Value> = BTreeMap::new();
    // Vocabulary
    defs.insert("ObjectType", inline_schema_for::<ObjectType>());
    defs.insert("ObjectStatus", inline_schema_for::<ObjectStatus>());
    defs.insert("Origin", inline_schema_for::<Origin>());
    // Canonical entities
    defs.insert("CanonicalObject", inline_schema_for::<CanonicalObject>());
    defs.insert("Provenance", inline_schema_for::<Provenance>());
    // Request DTOs
    defs.insert(
        "CreateObjectInput",
        inline_schema_for::<CreateObjectInput>(),
    );
    defs.insert("CreateContext", inline_schema_for::<CreateContext>());
    defs.insert("ObjectPatch", inline_schema_for::<ObjectPatch>());
    // Errors + FFI result envelopes
    defs.insert("ValidationError", inline_schema_for::<ValidationError>());
    defs.insert("CoreError", inline_schema_for::<CoreError>());
    defs.insert("CreatedObject", inline_schema_for::<CreatedObject>());
    defs.insert(
        "CreateObjectResult",
        inline_schema_for::<CreateObjectResult>(),
    );
    defs.insert("ObjectResult", inline_schema_for::<ObjectResult>());

    let artifact = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "mathmeander-schema",
        "artifact_version": ARTIFACT_VERSION,
        "schema_version": crate::CURRENT_SCHEMA_VERSION,
        "$defs": defs,
    });

    let mut out = serde_json::to_string_pretty(&artifact).expect("artifact serializes");
    out.push('\n');
    out
}

/// A fully populated sample object, reused across conformance cases so the corpus
/// can't drift from the real shape.
fn sample_object() -> Value {
    json!({
        "id": "0197675f-71f4-7000-8000-000000000001",
        "type": "note",
        "title": "Cauchy sequences",
        "raw_source": "Rough thought: $\\forall \\epsilon > 0$ …\nsecond line ℝ",
        "status": "draft",
        "schema_version": 1,
        "revision": 1,
        "provenance_id": "0197675f-71f4-7000-8000-000000000002",
        "space_id": "0197675f-71f4-7000-8000-000000000003",
        "created_at": "2026-06-12T00:00:00Z",
        "updated_at": "2026-06-12T00:00:00Z"
    })
}

/// Shared conformance corpus: (type name, candidate JSON value, must-be-valid).
/// The Rust side asserts serde agrees (test below); the TS side asserts the GENERATED
/// zod schemas give identical verdicts (packages/schema/tests/conformance.test.ts).
/// Identical verdicts on both sides of the FFI is what "drift is a build error" means
/// beyond type names.
pub fn conformance_json() -> String {
    let object = sample_object();
    let mut object_minimal = sample_object();
    if let Some(o) = object_minimal.as_object_mut() {
        o.remove("title");
        o.remove("raw_source");
    }
    let mut object_with_unknown = sample_object();
    if let Some(o) = object_with_unknown.as_object_mut() {
        o.insert("from_the_future".into(), json!({ "carried": true }));
    }
    let mut object_missing_id = sample_object();
    if let Some(o) = object_missing_id.as_object_mut() {
        o.remove("id");
    }
    let mut object_bad_status = sample_object();
    if let Some(o) = object_bad_status.as_object_mut() {
        o.insert("status".into(), json!("published"));
    }

    let cases = json!([
        // ── ObjectType ──
        { "type": "ObjectType", "value": "note", "valid": true },
        { "type": "ObjectType", "value": "theorem", "valid": false,
          "note": "formal family arrives in slice 1; not in the vocabulary yet" },
        { "type": "ObjectType", "value": "Note", "valid": false, "note": "case-sensitive" },

        // ── ObjectStatus (full lifecycle) ──
        { "type": "ObjectStatus", "value": "raw", "valid": true },
        { "type": "ObjectStatus", "value": "draft", "valid": true },
        { "type": "ObjectStatus", "value": "ai_drafted", "valid": true },
        { "type": "ObjectStatus", "value": "user_verified", "valid": true },
        { "type": "ObjectStatus", "value": "trusted", "valid": true },
        { "type": "ObjectStatus", "value": "needs_review", "valid": true },
        { "type": "ObjectStatus", "value": "deprecated", "valid": true },
        { "type": "ObjectStatus", "value": "Draft", "valid": false },
        { "type": "ObjectStatus", "value": "published", "valid": false },

        // ── Origin ──
        { "type": "Origin", "value": "user", "valid": true },
        { "type": "Origin", "value": "ai", "valid": true },
        { "type": "Origin", "value": "imported", "valid": true },
        { "type": "Origin", "value": "system", "valid": true },
        { "type": "Origin", "value": "llm", "valid": false },

        // ── CanonicalObject ──
        { "type": "CanonicalObject", "value": object, "valid": true },
        { "type": "CanonicalObject", "value": object_minimal, "valid": true,
          "note": "title/raw_source absent — unset is a valid state (§6.3 tri-state)" },
        { "type": "CanonicalObject", "value": object_with_unknown, "valid": true,
          "note": "unknown fields are CARRIED, not rejected (§2.2 preservation)" },
        { "type": "CanonicalObject", "value": object_missing_id, "valid": false },
        { "type": "CanonicalObject", "value": object_bad_status, "valid": false },

        // ── Provenance (uuid / datetime / Option probes) ──
        { "type": "Provenance",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "origin": "user",
                     "created_by": "user-1", "occurred_at": "2026-06-12T00:00:00Z" },
          "valid": true },
        { "type": "Provenance",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "origin": "system",
                     "occurred_at": "2026-06-12T00:00:00Z" },
          "valid": true, "note": "created_by absent — Option means absent is fine at SHAPE level" },
        { "type": "Provenance",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "origin": "system",
                     "created_by": null, "occurred_at": "2026-06-12T00:00:00Z" },
          "valid": true, "note": "created_by explicitly null" },
        { "type": "Provenance",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "origin": "user",
                     "created_by": "user-1", "occurred_at": "2026-06-12T02:00:00+02:00" },
          "valid": true, "note": "RFC3339 offset form — chrono accepts; zod must match" },
        { "type": "Provenance",
          "value": { "id": "not-a-uuid", "origin": "user",
                     "created_by": "user-1", "occurred_at": "2026-06-12T00:00:00Z" },
          "valid": false },
        { "type": "Provenance",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "origin": "user",
                     "created_by": "user-1", "occurred_at": "yesterday" },
          "valid": false },
        { "type": "Provenance",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "origin": "user",
                     "created_by": "user-1" },
          "valid": false, "note": "occurred_at missing" },

        // ── CreateObjectInput (ids are STRINGS at shape level — semantics live in the core) ──
        { "type": "CreateObjectInput",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "type": "note" },
          "valid": true },
        { "type": "CreateObjectInput",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001", "type": "note",
                     "title": "", "raw_source": "$x$" },
          "valid": true, "note": "empty title is a VALUE (tri-state)" },
        { "type": "CreateObjectInput",
          "value": { "id": "not-even-a-uuid", "type": "theorem" },
          "valid": true,
          "note": "shape-valid: id format and type vocabulary are CORE semantics (typed errors), not transport shape" },
        { "type": "CreateObjectInput",
          "value": { "id": "0197675f-71f4-7000-8000-000000000001" },
          "valid": false, "note": "type missing" },

        // ── CreateContext ──
        { "type": "CreateContext",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-000000000002",
                     "origin": "user", "created_by": "user-1" },
          "valid": true },
        { "type": "CreateContext",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-000000000002",
                     "origin": "system" },
          "valid": true },
        { "type": "CreateContext",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-000000000002",
                     "origin": "llm" },
          "valid": false },

        // ── ObjectPatch (the tri-state wire shape: absent / null / value) ──
        { "type": "ObjectPatch", "value": { "expected_revision": 1 }, "valid": true,
          "note": "title absent = leave unchanged" },
        { "type": "ObjectPatch", "value": { "expected_revision": 1, "title": null },
          "valid": true, "note": "null = clear to unset" },
        { "type": "ObjectPatch", "value": { "expected_revision": 1, "title": "New name" },
          "valid": true },
        { "type": "ObjectPatch", "value": { "expected_revision": 1, "title": "" },
          "valid": true, "note": "empty string is a VALUE, not a clear" },
        { "type": "ObjectPatch", "value": { "title": "x" }, "valid": false,
          "note": "expected_revision required (§6.4)" },

        // ── ValidationError (internally tagged union — the hard case) ──
        { "type": "ValidationError",
          "value": { "code": "unknown_object_type", "given": "theorem" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "title_too_long", "max_chars": 1024, "given_chars": 2000 },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "missing_created_by", "origin": "user" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "origin_not_producible", "origin": "ai" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "schema_version_from_the_future", "given": 9, "current": 1 },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "not_a_real_code" }, "valid": false, "note": "unknown tag" },
        { "type": "ValidationError",
          "value": { "code": "title_too_long", "max_chars": 1024 }, "valid": false,
          "note": "missing variant field" },
        { "type": "ValidationError",
          "value": { "given": "theorem" }, "valid": false, "note": "tag missing entirely" },

        // ── CoreError (tag + flattened inner union) ──
        { "type": "CoreError",
          "value": { "kind": "malformed_input", "context": "create input",
                     "message": "expected value at line 1" },
          "valid": true },
        { "type": "CoreError",
          "value": { "kind": "validation", "code": "title_too_long",
                     "max_chars": 1024, "given_chars": 2000 },
          "valid": true, "note": "validation errors flatten inline behind kind" },
        { "type": "CoreError", "value": { "kind": "validation" }, "valid": false,
          "note": "flattened inner error missing" },
        { "type": "CoreError", "value": { "kind": "panic" }, "valid": false },

        // ── ObjectResult (the FFI envelope every call parses) ──
        { "type": "ObjectResult", "value": { "ok": true, "value": sample_object() },
          "valid": true },
        { "type": "ObjectResult",
          "value": { "ok": false,
                     "error": { "kind": "validation", "code": "not_uuid_v7", "field": "id" } },
          "valid": true },
        { "type": "ObjectResult", "value": { "ok": true }, "valid": false,
          "note": "ok without value" },
    ]);

    let mut out = serde_json::to_string_pretty(&cases).expect("conformance serializes");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Rust half of the cross-validation suite: serde's verdicts must match the
    /// corpus. (The TS half runs the same corpus through the GENERATED zod schemas.)
    #[test]
    fn serde_verdicts_match_conformance_corpus() {
        let cases: Vec<Value> = serde_json::from_str(&conformance_json()).expect("corpus parses");
        for case in cases {
            let type_name = case["type"].as_str().expect("type");
            let value = case["value"].clone();
            let expected_valid = case["valid"].as_bool().expect("valid");
            let actual_valid = match type_name {
                "ObjectType" => serde_json::from_value::<ObjectType>(value.clone()).is_ok(),
                "ObjectStatus" => serde_json::from_value::<ObjectStatus>(value.clone()).is_ok(),
                "Origin" => serde_json::from_value::<Origin>(value.clone()).is_ok(),
                "CanonicalObject" => {
                    serde_json::from_value::<CanonicalObject>(value.clone()).is_ok()
                }
                "Provenance" => serde_json::from_value::<Provenance>(value.clone()).is_ok(),
                "CreateObjectInput" => {
                    serde_json::from_value::<CreateObjectInput>(value.clone()).is_ok()
                }
                "CreateContext" => serde_json::from_value::<CreateContext>(value.clone()).is_ok(),
                "ObjectPatch" => serde_json::from_value::<ObjectPatch>(value.clone()).is_ok(),
                "ValidationError" => {
                    serde_json::from_value::<ValidationError>(value.clone()).is_ok()
                }
                "CoreError" => serde_json::from_value::<CoreError>(value.clone()).is_ok(),
                "ObjectResult" => serde_json::from_value::<ObjectResult>(value.clone()).is_ok(),
                other => panic!("conformance corpus names unknown type {other}"),
            };
            assert_eq!(
                actual_valid, expected_valid,
                "serde verdict mismatch for {type_name} on {value}"
            );
        }
    }

    #[test]
    fn artifact_is_deterministic() {
        assert_eq!(artifact_json(), artifact_json());
        assert_eq!(conformance_json(), conformance_json());
    }
}
