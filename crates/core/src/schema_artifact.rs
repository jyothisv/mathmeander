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
use crate::model::{
    Alias, AliasKind, AliasScope, CanonicalObject, CharSpan, ContentLocator, DeclaredBy,
    DefinitionDetail, EmbedTarget, ExampleKind, ExtractedStructureEnvelope, Handle, HandleScope,
    HandleStatus, Inline, InputSyntax, Link, LinkStatus, LinkType, MathExpression, ObjectStatus,
    ObjectType, ObjectVersion, Occurrence, OccurrenceTarget, Origin, ParseStatus, Provenance,
    ProvenanceDerivation, ReferenceTarget, SurfaceFormat, Tag, Tagging, TargetSelector, Unit,
    UnitContent, UnitStatus, UnitType,
};
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
    // Slice 1 vocabularies (text-backed, never PG enums — §6 enum-vs-text)
    defs.insert("UnitType", inline_schema_for::<UnitType>());
    defs.insert("UnitStatus", inline_schema_for::<UnitStatus>());
    defs.insert("DeclaredBy", inline_schema_for::<DeclaredBy>());
    defs.insert("ExampleKind", inline_schema_for::<ExampleKind>());
    defs.insert("LinkType", inline_schema_for::<LinkType>());
    defs.insert("LinkStatus", inline_schema_for::<LinkStatus>());
    defs.insert("AliasKind", inline_schema_for::<AliasKind>());
    defs.insert("AliasScope", inline_schema_for::<AliasScope>());
    defs.insert("HandleScope", inline_schema_for::<HandleScope>());
    defs.insert("HandleStatus", inline_schema_for::<HandleStatus>());
    defs.insert("SurfaceFormat", inline_schema_for::<SurfaceFormat>());
    defs.insert("InputSyntax", inline_schema_for::<InputSyntax>());
    defs.insert("ParseStatus", inline_schema_for::<ParseStatus>());
    // Slice 1 content model + tagged unions (§6.0/§6.1d/§6.3a)
    defs.insert("CharSpan", inline_schema_for::<CharSpan>());
    defs.insert("MathExpression", inline_schema_for::<MathExpression>());
    defs.insert("Occurrence", inline_schema_for::<Occurrence>());
    defs.insert("OccurrenceTarget", inline_schema_for::<OccurrenceTarget>());
    defs.insert("ContentLocator", inline_schema_for::<ContentLocator>());
    defs.insert("TargetSelector", inline_schema_for::<TargetSelector>());
    defs.insert("EmbedTarget", inline_schema_for::<EmbedTarget>());
    defs.insert("ReferenceTarget", inline_schema_for::<ReferenceTarget>());
    defs.insert("Inline", inline_schema_for::<Inline>());
    defs.insert("UnitContent", inline_schema_for::<UnitContent>());
    defs.insert(
        "ExtractedStructureEnvelope",
        inline_schema_for::<ExtractedStructureEnvelope>(),
    );
    // Canonical entities
    defs.insert("CanonicalObject", inline_schema_for::<CanonicalObject>());
    defs.insert("Provenance", inline_schema_for::<Provenance>());
    // Slice 1 entity rows (§6.0b/§6.1/§6.3b)
    defs.insert("Unit", inline_schema_for::<Unit>());
    defs.insert("Link", inline_schema_for::<Link>());
    defs.insert("Alias", inline_schema_for::<Alias>());
    defs.insert("Handle", inline_schema_for::<Handle>());
    defs.insert("Tag", inline_schema_for::<Tag>());
    defs.insert("Tagging", inline_schema_for::<Tagging>());
    defs.insert("ObjectVersion", inline_schema_for::<ObjectVersion>());
    defs.insert("DefinitionDetail", inline_schema_for::<DefinitionDetail>());
    defs.insert(
        "ProvenanceDerivation",
        inline_schema_for::<ProvenanceDerivation>(),
    );
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

/// A valid `MathExpression` value, reused wherever one is embedded (inline math, a `math`
/// unit, the MathExpression case itself) so those cases can't drift from the real shape.
fn sample_expr() -> Value {
    json!({
        "id": "0197675f-71f4-7000-8000-0000000000c1",
        "surface_text": "a/b",
        "surface_format": "mathmeander",
        "input_syntax": "latex",
        "original_input": "\\frac{a}{b}",
        "parse_status": "renderable",
        "occurrences": []
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
        { "type": "ObjectType", "value": "theorem", "valid": true,
          "note": "formal family lands in slice 1 — now valid vocabulary" },
        { "type": "ObjectType", "value": "journal_day", "valid": true,
          "note": "reserved vocabulary: valid on read, not producible (TypeNotProducibleYet)" },
        { "type": "ObjectType", "value": "Note", "valid": false, "note": "case-sensitive" },
        { "type": "ObjectType", "value": "proof_step", "valid": false,
          "note": "proof_step is a UNIT type, never an object type (§6.0b)" },

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

        // ════════════════ Slice 1 canonical object core ════════════════
        // Shape only (serde ≡ zod). Semantic invariants (exactly-one-target, etc.) are
        // CORE validation, not transport shape, so a shape-valid-but-invariant-violating
        // value is "valid" here — those are exercised as ValidationError cases below.

        // ── Unit vocabularies ──
        { "type": "UnitType", "value": "theorem", "valid": true },
        { "type": "UnitType", "value": "proof_step", "valid": true },
        { "type": "UnitType", "value": "group", "valid": false,
          "note": "forms are content.kind values, never types (§6.0b)" },
        { "type": "UnitType", "value": "Theorem", "valid": false, "note": "case-sensitive" },
        { "type": "UnitStatus", "value": "rough", "valid": true },
        { "type": "UnitStatus", "value": "user_verified", "valid": true },
        { "type": "UnitStatus", "value": "draft", "valid": false,
          "note": "draft is an OBJECT status, not a unit status" },
        { "type": "DeclaredBy", "value": "user", "valid": true },
        { "type": "DeclaredBy", "value": "deterministic", "valid": true },
        { "type": "DeclaredBy", "value": "ai", "valid": false,
          "note": "declared_by can never be ai (§6.0)" },
        { "type": "ExampleKind", "value": "non_example", "valid": true },
        { "type": "ExampleKind", "value": "counterexample", "valid": false },

        // ── Edge / alias / handle vocabularies ──
        { "type": "LinkType", "value": "proves", "valid": true,
          "note": "dec. E — proves added; the enum is source of truth" },
        { "type": "LinkType", "value": "element_of", "valid": true,
          "note": "reserved for type inference (§14) — declared, unused" },
        { "type": "LinkType", "value": "depends_on", "valid": false,
          "note": "not in the vocabulary (uses/proves carry these meanings)" },
        { "type": "LinkStatus", "value": "active", "valid": true },
        { "type": "LinkStatus", "value": "pending", "valid": false },
        { "type": "AliasKind", "value": "standard", "valid": true },
        { "type": "AliasKind", "value": "nickname", "valid": false },
        { "type": "AliasScope", "value": "trail", "valid": true },
        { "type": "AliasScope", "value": "world", "valid": false },
        { "type": "HandleScope", "value": "space", "valid": true },
        { "type": "HandleScope", "value": "global", "valid": false,
          "note": "handle scope is object|space (alias scope has global)" },
        { "type": "HandleStatus", "value": "stale", "valid": true },
        { "type": "HandleStatus", "value": "deprecated", "valid": false },

        // ── MathExpression surface vocabularies ──
        { "type": "SurfaceFormat", "value": "mathmeander", "valid": true },
        { "type": "SurfaceFormat", "value": "typst", "valid": true, "note": "reserved, declared" },
        { "type": "SurfaceFormat", "value": "mathml", "valid": false,
          "note": "mathml is a render adapter target, not a surface format" },
        { "type": "InputSyntax", "value": "mixed", "valid": true },
        { "type": "InputSyntax", "value": "unknown", "valid": true },
        { "type": "InputSyntax", "value": "voice", "valid": false },
        { "type": "ParseStatus", "value": "partially_resolved", "valid": true },
        { "type": "ParseStatus", "value": "ok", "valid": false },

        // ── CharSpan ──
        { "type": "CharSpan", "value": { "start": 0, "end": 5 }, "valid": true },
        { "type": "CharSpan", "value": { "start": 3 }, "valid": false, "note": "end missing" },
        { "type": "CharSpan", "value": { "start": -1, "end": 5 }, "valid": false,
          "note": "offsets are u32" },

        // ── MathExpression ──
        { "type": "MathExpression", "value": sample_expr(), "valid": true },
        { "type": "MathExpression",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000c1", "surface_text": "x",
                     "surface_format": "mathmeander", "original_input": "x",
                     "parse_status": "renderable", "occurrences": [] },
          "valid": true, "note": "input_syntax absent — tri-state (absent ≠ unknown)" },
        { "type": "MathExpression",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000c1", "surface_text": "x",
                     "surface_format": "mathmeander", "original_input": "x",
                     "parse_status": "renderable" },
          "valid": false, "note": "occurrences is required (always present, [] when none)" },
        { "type": "MathExpression",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000c1",
                     "surface_format": "mathmeander", "original_input": "x",
                     "parse_status": "renderable", "occurrences": [] },
          "valid": false, "note": "surface_text missing" },

        // ── Occurrence + OccurrenceTarget ──
        { "type": "Occurrence",
          "value": { "selector": { "start": 0, "end": 1 },
                     "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" } },
          "valid": true },
        { "type": "Occurrence", "value": { "selector": { "start": 0, "end": 1 } }, "valid": true,
          "note": "target absent — unresolved (the edge carries unresolved_text)" },
        { "type": "Occurrence", "value": { "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" } },
          "valid": false, "note": "selector missing" },
        { "type": "OccurrenceTarget",
          "value": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" }, "valid": true },
        { "type": "OccurrenceTarget",
          "value": { "kind": "notation", "notation_id": "0197675f-71f4-7000-8000-0000000000a1" },
          "valid": false, "note": "notation arm reserved until slice 2" },
        { "type": "OccurrenceTarget", "value": { "kind": "object" }, "valid": false,
          "note": "object_id missing" },

        // ── ContentLocator ──
        { "type": "ContentLocator", "value": { "kind": "prose_span", "start": 0, "end": 3 }, "valid": true },
        { "type": "ContentLocator",
          "value": { "kind": "expression_span", "expression_id": "0197675f-71f4-7000-8000-0000000000c1",
                     "start": 0, "end": 3 }, "valid": true },
        { "type": "ContentLocator", "value": { "kind": "whole_unit" }, "valid": true },
        { "type": "ContentLocator", "value": { "kind": "prose_span", "start": 0 }, "valid": false,
          "note": "end missing" },
        { "type": "ContentLocator", "value": { "kind": "char_span", "start": 0, "end": 3 }, "valid": false,
          "note": "unknown tag" },

        // ── TargetSelector ──
        { "type": "TargetSelector",
          "value": { "kind": "expression_ref", "expression_id": "0197675f-71f4-7000-8000-0000000000c1" },
          "valid": true, "note": "span optional" },
        { "type": "TargetSelector",
          "value": { "kind": "expression_ref", "expression_id": "0197675f-71f4-7000-8000-0000000000c1",
                     "span": { "start": 1, "end": 4 } }, "valid": true },
        { "type": "TargetSelector",
          "value": { "kind": "structural_path", "expression_id": "0197675f-71f4-7000-8000-0000000000c1",
                     "term_path": [0, 1] }, "valid": false, "note": "StructuralPath reserved, not declared in slice 1" },
        { "type": "TargetSelector", "value": { "kind": "expression_ref" }, "valid": false,
          "note": "expression_id missing" },

        // ── EmbedTarget + ReferenceTarget ──
        { "type": "EmbedTarget",
          "value": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" }, "valid": true },
        { "type": "EmbedTarget",
          "value": { "kind": "source_excerpt", "object_id": "0197675f-71f4-7000-8000-0000000000a1" },
          "valid": false, "note": "source_excerpt arm reserved until slice 3" },
        { "type": "ReferenceTarget",
          "value": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" }, "valid": true },
        { "type": "ReferenceTarget", "value": { "kind": "object" }, "valid": false },

        // ── Inline ──
        { "type": "Inline",
          "value": { "kind": "mark", "span": { "start": 0, "end": 4 }, "style": "emph" }, "valid": true },
        { "type": "Inline",
          "value": { "kind": "math", "span": { "start": 5, "end": 8 }, "expr": sample_expr() }, "valid": true },
        { "type": "Inline",
          "value": { "kind": "reference", "span": { "start": 0, "end": 2 }, "text": "BW",
                     "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" } },
          "valid": true },
        { "type": "Inline",
          "value": { "kind": "reference", "span": { "start": 0, "end": 2 }, "text": "BW" },
          "valid": true, "note": "reference target optional (unresolved)" },
        { "type": "Inline", "value": { "kind": "mark", "span": { "start": 0, "end": 4 } }, "valid": false,
          "note": "style missing" },
        { "type": "Inline", "value": { "kind": "italic", "span": { "start": 0, "end": 4 } }, "valid": false,
          "note": "unknown tag" },

        // ── UnitContent (every kind + negatives) ──
        { "type": "UnitContent",
          "value": { "kind": "prose", "text": "Compactness prevents escape.", "inline": [] }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "math", "expr": sample_expr() }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "list", "ordered": true }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "derivation" }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "case_split" }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "group" }, "valid": true },
        { "type": "UnitContent",
          "value": { "kind": "embed", "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" } },
          "valid": true },
        { "type": "UnitContent", "value": { "kind": "prose", "text": "hi" }, "valid": false,
          "note": "inline required (always present, [] when none)" },
        { "type": "UnitContent", "value": { "kind": "list" }, "valid": false, "note": "ordered missing" },
        { "type": "UnitContent", "value": { "kind": "matrix" }, "valid": false, "note": "unknown kind" },

        // ── ExtractedStructureEnvelope ──
        { "type": "ExtractedStructureEnvelope",
          "value": { "kind": "hypothesis_conclusion_decomposition", "schema_version": 1,
                     "generated_by": "llm:proposer-v2", "base_object_revision": 4 },
          "valid": true, "note": "accepted_into optional (None until accepted)" },
        { "type": "ExtractedStructureEnvelope",
          "value": { "kind": "x", "schema_version": 1, "generated_by": "y" },
          "valid": false, "note": "base_object_revision missing" },

        // ── Unit ──
        { "type": "Unit",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000b1",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "parent_unit_id": null, "position": 0, "slot": null, "type": "theorem",
                     "example_kind": null, "status": "rough", "declared_by": "user",
                     "extracted_structure": null,
                     "content": { "kind": "prose", "text": "Every bounded sequence…", "inline": [] },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": true },
        { "type": "Unit",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000b1",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1", "position": 0,
                     "status": "rough", "declared_by": "user", "content": { "kind": "group" },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": true, "note": "optional columns absent (type/slot/example_kind/parent/extracted_structure)" },
        { "type": "Unit",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000b1",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1", "position": 0,
                     "status": "rough", "declared_by": "ai", "content": { "kind": "group" },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": false, "note": "declared_by = ai is not in the vocabulary (§6.0)" },
        { "type": "Unit",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000b1",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1", "position": 0,
                     "status": "rough", "declared_by": "user",
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": false, "note": "content missing" },

        // ── Link (both slice-1 target arms, shape only) ──
        { "type": "Link",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000a3",
                     "source_object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "target_object_id": "0197675f-71f4-7000-8000-0000000000a2",
                     "target_unit_id": null, "unresolved_text": null, "target_selector": null,
                     "type": "proves", "status": "active", "from_content": false,
                     "source_unit_id": null, "content_locator": null,
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "created_at": "2026-06-12T00:00:00Z" },
          "valid": true },
        { "type": "Link",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000a3",
                     "source_object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "unresolved_text": "[[Bolzano–Weierstrass]]", "type": "related",
                     "status": "active", "from_content": true,
                     "content_locator": { "kind": "prose_span", "start": 6, "end": 28 },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "created_at": "2026-06-12T00:00:00Z" },
          "valid": true, "note": "unresolved arm; optional target columns absent" },
        { "type": "Link",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000a3",
                     "source_object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "type": "uses", "status": "active", "from_content": false,
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": false, "note": "created_at missing" },
        { "type": "Link",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000a3",
                     "source_object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "status": "active", "from_content": false,
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "created_at": "2026-06-12T00:00:00Z" },
          "valid": false, "note": "type missing" },

        // ── Alias ──
        { "type": "Alias",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000b",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1", "name": "BW",
                     "kind": "user", "scope": "global", "scope_ref": null }, "valid": true },
        { "type": "Alias",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000b",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "kind": "user", "scope": "global" }, "valid": false, "note": "name missing" },

        // ── Handle ──
        { "type": "Handle",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000c",
                     "space_id": "0197675f-71f4-7000-8000-0000000000e1", "name": "(★)",
                     "target_object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "target_unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "target_expression_id": null, "status": "active", "scope": "object",
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" }, "valid": true },
        { "type": "Handle",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000c",
                     "space_id": "0197675f-71f4-7000-8000-0000000000e1", "name": "(★)",
                     "target_unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "status": "active", "scope": "object",
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": false, "note": "target_object_id missing (handles always bind the owning object)" },

        // ── Tag + Tagging ──
        { "type": "Tag",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000f1",
                     "space_id": "0197675f-71f4-7000-8000-0000000000e1", "name": "central" },
          "valid": true },
        { "type": "Tag",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000f1",
                     "space_id": "0197675f-71f4-7000-8000-0000000000e1" }, "valid": false,
          "note": "name missing" },
        { "type": "Tagging",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000d",
                     "tag_id": "0197675f-71f4-7000-8000-0000000000f1",
                     "tagged_object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "tagged_unit_id": null, "created_at": "2026-06-12T00:00:00Z" }, "valid": true },
        { "type": "Tagging",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000d",
                     "tag_id": "0197675f-71f4-7000-8000-0000000000f1",
                     "tagged_object_id": "0197675f-71f4-7000-8000-0000000000a1" }, "valid": false,
          "note": "created_at missing" },

        // ── ObjectVersion (snapshot is an arbitrary value) ──
        { "type": "ObjectVersion",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000a",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1", "version_no": 1,
                     "snapshot": { "id": "…", "units": [] },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "created_at": "2026-06-12T00:00:00Z" }, "valid": true },
        { "type": "ObjectVersion",
          "value": { "id": "0197675f-71f4-7000-8000-00000000000a",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "snapshot": {}, "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "created_at": "2026-06-12T00:00:00Z" }, "valid": false,
          "note": "version_no missing" },

        // ── DefinitionDetail + ProvenanceDerivation ──
        { "type": "DefinitionDetail",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000a1", "term": "compact" },
          "valid": true },
        { "type": "DefinitionDetail",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000a1" }, "valid": false,
          "note": "term missing" },
        { "type": "ProvenanceDerivation",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "derived_from_provenance_id": "0197675f-71f4-7000-8000-0000000000d2" },
          "valid": true },
        { "type": "ProvenanceDerivation",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" }, "valid": false,
          "note": "derived_from_provenance_id missing" },

        // ── ValidationError (the new §6.1a invariant codes) ──
        { "type": "ValidationError",
          "value": { "code": "type_not_producible_yet", "object_type": "trail" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "link_target_not_exactly_one", "given": 2 }, "valid": true },
        { "type": "ValidationError", "value": { "code": "off_graph_deliberate_edge" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "typed_edge_requires_object_target", "link_type": "proves" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "detail_type_mismatch", "expected": "definition", "given": "theorem" },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "alias_scope_ref_mismatch", "scope": "source" }, "valid": true },
        { "type": "ValidationError", "value": { "code": "declared_by_ai" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "tagging_target_not_exactly_one" }, "valid": false,
          "note": "missing variant field `given`" },
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
                // ── Slice 1 vocabularies ──
                "UnitType" => serde_json::from_value::<UnitType>(value.clone()).is_ok(),
                "UnitStatus" => serde_json::from_value::<UnitStatus>(value.clone()).is_ok(),
                "DeclaredBy" => serde_json::from_value::<DeclaredBy>(value.clone()).is_ok(),
                "ExampleKind" => serde_json::from_value::<ExampleKind>(value.clone()).is_ok(),
                "LinkType" => serde_json::from_value::<LinkType>(value.clone()).is_ok(),
                "LinkStatus" => serde_json::from_value::<LinkStatus>(value.clone()).is_ok(),
                "AliasKind" => serde_json::from_value::<AliasKind>(value.clone()).is_ok(),
                "AliasScope" => serde_json::from_value::<AliasScope>(value.clone()).is_ok(),
                "HandleScope" => serde_json::from_value::<HandleScope>(value.clone()).is_ok(),
                "HandleStatus" => serde_json::from_value::<HandleStatus>(value.clone()).is_ok(),
                "SurfaceFormat" => serde_json::from_value::<SurfaceFormat>(value.clone()).is_ok(),
                "InputSyntax" => serde_json::from_value::<InputSyntax>(value.clone()).is_ok(),
                "ParseStatus" => serde_json::from_value::<ParseStatus>(value.clone()).is_ok(),
                // ── Slice 1 content model + unions ──
                "CharSpan" => serde_json::from_value::<CharSpan>(value.clone()).is_ok(),
                "MathExpression" => serde_json::from_value::<MathExpression>(value.clone()).is_ok(),
                "Occurrence" => serde_json::from_value::<Occurrence>(value.clone()).is_ok(),
                "OccurrenceTarget" => {
                    serde_json::from_value::<OccurrenceTarget>(value.clone()).is_ok()
                }
                "ContentLocator" => serde_json::from_value::<ContentLocator>(value.clone()).is_ok(),
                "TargetSelector" => serde_json::from_value::<TargetSelector>(value.clone()).is_ok(),
                "EmbedTarget" => serde_json::from_value::<EmbedTarget>(value.clone()).is_ok(),
                "ReferenceTarget" => {
                    serde_json::from_value::<ReferenceTarget>(value.clone()).is_ok()
                }
                "Inline" => serde_json::from_value::<Inline>(value.clone()).is_ok(),
                "UnitContent" => serde_json::from_value::<UnitContent>(value.clone()).is_ok(),
                "ExtractedStructureEnvelope" => {
                    serde_json::from_value::<ExtractedStructureEnvelope>(value.clone()).is_ok()
                }
                // ── Slice 1 entity rows ──
                "Unit" => serde_json::from_value::<Unit>(value.clone()).is_ok(),
                "Link" => serde_json::from_value::<Link>(value.clone()).is_ok(),
                "Alias" => serde_json::from_value::<Alias>(value.clone()).is_ok(),
                "Handle" => serde_json::from_value::<Handle>(value.clone()).is_ok(),
                "Tag" => serde_json::from_value::<Tag>(value.clone()).is_ok(),
                "Tagging" => serde_json::from_value::<Tagging>(value.clone()).is_ok(),
                "ObjectVersion" => serde_json::from_value::<ObjectVersion>(value.clone()).is_ok(),
                "DefinitionDetail" => {
                    serde_json::from_value::<DefinitionDetail>(value.clone()).is_ok()
                }
                "ProvenanceDerivation" => {
                    serde_json::from_value::<ProvenanceDerivation>(value.clone()).is_ok()
                }
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
