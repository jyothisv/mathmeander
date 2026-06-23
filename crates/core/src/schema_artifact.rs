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

use crate::api::{
    CreateJournalDayResult, CreateObjectResult, CreatedJournalDay, CreatedObject,
    MathpackImportResult, MathpackResult, NumberingResult, ObjectResult, OpOutcomeResult,
};
use crate::error::{CoreError, ValidationError};
use crate::mathpack::{
    AssetChecksum, Mathpack, MathpackCounts, MathpackGraph, MathpackImport, MathpackManifest,
    MathpackMeta,
};
use crate::model::{
    Alias, AliasKind, AliasScope, CanonicalObject, CharSpan, ContentLocator, DeclaredBy,
    DefinitionDetail, EmbedTarget, ExampleKind, ExtractedStructureEnvelope, Handle, HandleScope,
    HandleStatus, Inline, InputSyntax, JournalDayDetail, Link, LinkStatus, LinkType,
    MathExpression, ObjectStatus, ObjectType, ObjectVersion, Occurrence, OccurrenceTarget, Origin,
    ParseStatus, Provenance, ProvenanceDerivation, ReferenceTarget, RowRelation, SurfaceFormat,
    Tag, Tagging, TargetSelector, Unit, UnitContent, UnitStatus, UnitType,
};
use crate::numbering::{DisplayLabels, NumberingPolicy, UnitLabel};
use crate::ops::{
    DissolveObjectInput, EquationRowInput, ExpressionIdRemap, InsertEquationsInput,
    InsertReferenceInput, LinkDraft, MaterializeObjectInput, MathContent, MergeUnitsInput,
    OpContext, OpOutcome, RehomeSubtreeInput, ResolveOccurrenceInput, ResolveTarget,
    RewriteSurfaceInput, SetUnitTypeInput, SplitUnitInput, ToggleExpressionPlacementInput,
    UnitIdRemap,
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
    defs.insert("RowRelation", inline_schema_for::<RowRelation>());
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
    defs.insert("JournalDayDetail", inline_schema_for::<JournalDayDetail>());
    defs.insert(
        "ProvenanceDerivation",
        inline_schema_for::<ProvenanceDerivation>(),
    );
    // Slice 1c canonical operations (§6.0a) — carriers, the outcome bundle, and op DTOs
    defs.insert("MathContent", inline_schema_for::<MathContent>());
    defs.insert("OpContext", inline_schema_for::<OpContext>());
    defs.insert("OpOutcome", inline_schema_for::<OpOutcome>());
    defs.insert(
        "ExpressionIdRemap",
        inline_schema_for::<ExpressionIdRemap>(),
    );
    defs.insert("UnitIdRemap", inline_schema_for::<UnitIdRemap>());
    defs.insert("SetUnitTypeInput", inline_schema_for::<SetUnitTypeInput>());
    defs.insert("SplitUnitInput", inline_schema_for::<SplitUnitInput>());
    defs.insert("MergeUnitsInput", inline_schema_for::<MergeUnitsInput>());
    defs.insert(
        "ToggleExpressionPlacementInput",
        inline_schema_for::<ToggleExpressionPlacementInput>(),
    );
    defs.insert(
        "RewriteSurfaceInput",
        inline_schema_for::<RewriteSurfaceInput>(),
    );
    defs.insert(
        "InsertEquationsInput",
        inline_schema_for::<InsertEquationsInput>(),
    );
    defs.insert("EquationRowInput", inline_schema_for::<EquationRowInput>());
    defs.insert("LinkDraft", inline_schema_for::<LinkDraft>());
    defs.insert(
        "InsertReferenceInput",
        inline_schema_for::<InsertReferenceInput>(),
    );
    defs.insert("ResolveTarget", inline_schema_for::<ResolveTarget>());
    defs.insert(
        "ResolveOccurrenceInput",
        inline_schema_for::<ResolveOccurrenceInput>(),
    );
    defs.insert(
        "MaterializeObjectInput",
        inline_schema_for::<MaterializeObjectInput>(),
    );
    defs.insert(
        "RehomeSubtreeInput",
        inline_schema_for::<RehomeSubtreeInput>(),
    );
    defs.insert(
        "DissolveObjectInput",
        inline_schema_for::<DissolveObjectInput>(),
    );
    // Slice 1d projections + packaging (§6.3b numbering, §10 .mathpack)
    defs.insert("NumberingPolicy", inline_schema_for::<NumberingPolicy>());
    defs.insert("UnitLabel", inline_schema_for::<UnitLabel>());
    defs.insert("DisplayLabels", inline_schema_for::<DisplayLabels>());
    defs.insert("AssetChecksum", inline_schema_for::<AssetChecksum>());
    defs.insert("MathpackMeta", inline_schema_for::<MathpackMeta>());
    defs.insert("MathpackCounts", inline_schema_for::<MathpackCounts>());
    defs.insert("MathpackManifest", inline_schema_for::<MathpackManifest>());
    defs.insert("MathpackGraph", inline_schema_for::<MathpackGraph>());
    defs.insert("Mathpack", inline_schema_for::<Mathpack>());
    defs.insert("MathpackImport", inline_schema_for::<MathpackImport>());
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
    defs.insert(
        "CreatedJournalDay",
        inline_schema_for::<CreatedJournalDay>(),
    );
    defs.insert(
        "CreateJournalDayResult",
        inline_schema_for::<CreateJournalDayResult>(),
    );
    defs.insert("ObjectResult", inline_schema_for::<ObjectResult>());
    // Slice 1d FFI envelopes (ops + projections + packaging)
    defs.insert("OpOutcomeResult", inline_schema_for::<OpOutcomeResult>());
    defs.insert("NumberingResult", inline_schema_for::<NumberingResult>());
    defs.insert("MathpackResult", inline_schema_for::<MathpackResult>());
    defs.insert(
        "MathpackImportResult",
        inline_schema_for::<MathpackImportResult>(),
    );

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

/// A `Unit` value with one inline math element, reused by the slice-1c composite cases
/// (`MathContent`/`OpOutcome`) so they can't drift from the real `Unit`/`MathExpression`
/// shapes. (Positives for deep composites are built from sub-samples; the Rust verdict test
/// re-parses them, so any shape drift goes red rather than silent.)
fn sample_unit() -> Value {
    json!({
        "id": "0197675f-71f4-7000-8000-0000000000b1",
        "object_id": "0197675f-71f4-7000-8000-0000000000a1",
        "parent_unit_id": null, "position": 0, "slot": null, "type": "theorem",
        "example_kind": null, "status": "rough", "declared_by": "user",
        "extracted_structure": null,
        "content": { "kind": "prose", "text": "By x ...",
                     "inline": [ { "kind": "math", "span": { "start": 3, "end": 3 },
                                   "expr": sample_expr() } ] },
        "provenance_id": "0197675f-71f4-7000-8000-0000000000d1"
    })
}

/// A `MathContent` value (the slice-1c working aggregate).
fn sample_math_content() -> Value {
    json!({
        "object_id": "0197675f-71f4-7000-8000-0000000000a1",
        "revision": 3,
        "units": [ sample_unit() ]
    })
}

/// An `ObjectVersion` value (the per-op snapshot).
fn sample_object_version() -> Value {
    json!({
        "id": "0197675f-71f4-7000-8000-00000000000a",
        "object_id": "0197675f-71f4-7000-8000-0000000000a1",
        "version_no": 4, "snapshot": { "object_id": "…", "revision": 4, "units": [] },
        "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
        "created_at": "2026-06-12T00:00:00Z"
    })
}

/// A `LinkDraft` value (object arm; optional refinement columns absent).
fn sample_link_draft() -> Value {
    json!({
        "id": "0197675f-71f4-7000-8000-0000000000a3",
        "source_object_id": "0197675f-71f4-7000-8000-0000000000a1",
        "target_object_id": "0197675f-71f4-7000-8000-0000000000a2",
        "link_type": "proves", "from_content": false
    })
}

/// A `MathpackCounts` value (slice-1d packaging). Shape-only — counts need not match a graph.
fn sample_mathpack_counts() -> Value {
    json!({
        "objects": 1, "units": 1, "links": 0, "aliases": 0, "handles": 0, "tags": 0,
        "taggings": 0, "object_versions": 1, "definition_details": 0, "journal_day_details": 0,
        "provenance": 1, "provenance_derivations": 0
    })
}

/// A `MathpackManifest` value, reused by the `Mathpack`/`MathpackImport` composite cases.
fn sample_mathpack_manifest() -> Value {
    json!({
        "format": "mathmeander.mathpack", "format_version": 1, "schema_version": 1,
        "created_at": "2026-06-12T00:00:00Z",
        "space_id": "0197675f-71f4-7000-8000-000000000003",
        "counts": sample_mathpack_counts(), "assets": []
    })
}

/// A `MathpackGraph` value built from the real sub-samples (so it can't drift), with the
/// deferred-but-present slice-1 sections as empty arrays.
fn sample_mathpack_graph() -> Value {
    json!({
        "objects": [ sample_object() ],
        "provenance": [], "provenance_derivations": [],
        "content": [ sample_math_content() ],
        "links": [], "aliases": [], "handles": [], "tags": [], "taggings": [],
        "object_versions": [ sample_object_version() ],
        "definition_details": [],
        "journal_day_details": []
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
          "note": "formal family: valid vocabulary, producible via materialize, not directly creatable" },
        { "type": "ObjectType", "value": "journal_day", "valid": true,
          "note": "producible since slice 2b via its §6.5 surface (create_journal_day); a raw typed POST still 422s (TypeNotDirectlyCreatable)" },
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
        { "type": "LinkType", "value": "derived_from", "valid": true,
          "note": "dec. — materialize copy-and-edge points back at the origin (slice 1c)" },
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
          "value": { "kind": "math", "span": { "start": 5, "end": 5 }, "expr": sample_expr() }, "valid": true,
          "note": "inline math is a zero-width atom (content in expr, not prose text)" },
        { "type": "Inline",
          "value": { "kind": "reference", "span": { "start": 0, "end": 0 }, "text": "BW",
                     "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" } },
          "valid": true },
        { "type": "Inline",
          "value": { "kind": "reference", "span": { "start": 0, "end": 0 }, "text": "BW" },
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
        { "type": "UnitContent", "value": { "kind": "equations" }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "case_split" }, "valid": true },
        { "type": "UnitContent", "value": { "kind": "group" }, "valid": true },
        { "type": "UnitContent",
          "value": { "kind": "embed", "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a1" } },
          "valid": true },
        { "type": "UnitContent", "value": { "kind": "prose", "text": "hi" }, "valid": false,
          "note": "inline required (always present, [] when none)" },
        { "type": "UnitContent", "value": { "kind": "list" }, "valid": false, "note": "ordered missing" },
        { "type": "UnitContent", "value": { "kind": "matrix" }, "valid": false, "note": "unknown kind" },

        // ── RowRelation (a sample of variants + negatives) ──
        { "type": "RowRelation", "value": "eq", "valid": true },
        { "type": "RowRelation", "value": "le", "valid": true },
        { "type": "RowRelation", "value": "implies", "valid": true },
        { "type": "RowRelation", "value": "in", "valid": true },
        { "type": "RowRelation", "value": "subseteq", "valid": true },
        { "type": "RowRelation", "value": "=", "valid": false, "note": "wire vocab is the variant name, not the symbol" },
        { "type": "RowRelation", "value": "equals", "valid": false, "note": "unknown variant" },

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
        { "type": "Unit",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000b1",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1",
                     "parent_unit_id": "0197675f-71f4-7000-8000-0000000000b0", "position": 1,
                     "row_relation": "eq", "status": "rough", "declared_by": "user",
                     "content": { "kind": "math", "expr": sample_expr() },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": true, "note": "a co-equal Equations row carrying its leading relation" },
        { "type": "Unit",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000b1",
                     "object_id": "0197675f-71f4-7000-8000-0000000000a1", "position": 0,
                     "row_relation": "nope", "status": "rough", "declared_by": "user",
                     "content": { "kind": "prose", "text": "x", "inline": [] },
                     "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" },
          "valid": false, "note": "row_relation not in the vocabulary" },

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

        // ── DefinitionDetail + JournalDayDetail + ProvenanceDerivation ──
        { "type": "DefinitionDetail",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000a1", "term": "compact" },
          "valid": true },
        { "type": "DefinitionDetail",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000a1" }, "valid": false,
          "note": "term missing" },
        { "type": "JournalDayDetail",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000b1", "date": "2026-06-18" },
          "valid": true },
        { "type": "JournalDayDetail",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000b1" }, "valid": false,
          "note": "date missing (the §6.5 day's identity); ISO YYYY-MM-DD validity is core-strict" },
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
          "value": { "code": "type_not_directly_creatable", "object_type": "theorem" }, "valid": true },
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
          "value": { "code": "content_save_invalid", "reason": "unit X changes a semantic facet" },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "tagging_target_not_exactly_one" }, "valid": false,
          "note": "missing variant field `given`" },

        // ════════════════ Slice 1c canonical operations ════════════════
        // Shape only (serde ≡ zod). The §6.1a semantic invariants are CORE validation, not
        // transport shape, so a shape-valid-but-invariant-violating value is "valid" here.

        // ── Carriers ──
        { "type": "OpContext",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-0000000000d1",
                     "version_id": "0197675f-71f4-7000-8000-00000000000a" }, "valid": true },
        { "type": "OpContext",
          "value": { "provenance_id": "0197675f-71f4-7000-8000-0000000000d1" }, "valid": false,
          "note": "version_id missing" },
        { "type": "MathContent", "value": sample_math_content(), "valid": true },
        { "type": "MathContent",
          "value": { "object_id": "0197675f-71f4-7000-8000-0000000000a1", "revision": 0 },
          "valid": false, "note": "units missing (always present, [] when none)" },
        { "type": "ExpressionIdRemap",
          "value": { "from": "0197675f-71f4-7000-8000-0000000000c1",
                     "to": "0197675f-71f4-7000-8000-0000000000c2" }, "valid": true },
        { "type": "ExpressionIdRemap",
          "value": { "from": "0197675f-71f4-7000-8000-0000000000c1" }, "valid": false,
          "note": "to missing" },
        { "type": "UnitIdRemap",
          "value": { "from": "0197675f-71f4-7000-8000-0000000000b1",
                     "to": "0197675f-71f4-7000-8000-0000000000b2" }, "valid": true },
        { "type": "UnitIdRemap",
          "value": { "to": "0197675f-71f4-7000-8000-0000000000b2" }, "valid": false,
          "note": "from missing" },

        // ── OpOutcome (deep composite; positive built from real sub-samples) ──
        // Single-object write: the §2a two-object channels are null/empty (the real wire shape —
        // `host_content` serializes as null for `None`, never omitted).
        { "type": "OpOutcome",
          "value": { "content": sample_math_content(), "links_upserted": [], "links_staled": [],
                     "expression_id_remap": [], "version_snapshot": sample_object_version(),
                     "new_objects": [], "taggings_propagated": [],
                     "host_content": null, "host_version_snapshot": null, "objects_removed": [] },
          "valid": true },
        // Two-object write (`rehome_subtree`): the host channels are populated alongside the new
        // object's `content`/`version_snapshot`.
        { "type": "OpOutcome",
          "value": { "content": sample_math_content(), "links_upserted": [], "links_staled": [],
                     "expression_id_remap": [], "version_snapshot": sample_object_version(),
                     "new_objects": [], "taggings_propagated": [],
                     "host_content": sample_math_content(),
                     "host_version_snapshot": sample_object_version(), "objects_removed": [] },
          "valid": true },
        { "type": "OpOutcome",
          "value": { "content": sample_math_content(), "links_upserted": [], "links_staled": [],
                     "expression_id_remap": [], "new_objects": [], "taggings_propagated": [],
                     "objects_removed": [] },
          "valid": false, "note": "version_snapshot missing (every op snapshots)" },

        // ── SetUnitTypeInput (the Patch tri-state) ──
        { "type": "SetUnitTypeInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1" },
          "valid": true, "note": "unit_type absent = leave unchanged" },
        { "type": "SetUnitTypeInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "unit_type": null }, "valid": true, "note": "null = clear to plain content" },
        { "type": "SetUnitTypeInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "unit_type": "lemma" }, "valid": true },
        { "type": "SetUnitTypeInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "unit_type": "group" }, "valid": false,
          "note": "group is a content kind, never a unit type (§6.0b)" },
        { "type": "SetUnitTypeInput", "value": { "expected_revision": 2 }, "valid": false,
          "note": "unit_id missing" },

        // ── SplitUnitInput / MergeUnitsInput ──
        { "type": "SplitUnitInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "at": 4, "new_unit_id": "0197675f-71f4-7000-8000-0000000000b2",
                     "propagate_taggings": [], "new_tagging_ids": [] }, "valid": true },
        { "type": "SplitUnitInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "new_unit_id": "0197675f-71f4-7000-8000-0000000000b2",
                     "propagate_taggings": [], "new_tagging_ids": [] }, "valid": false,
          "note": "at missing" },
        { "type": "MergeUnitsInput",
          "value": { "expected_revision": 2, "first_unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "second_unit_id": "0197675f-71f4-7000-8000-0000000000b2" }, "valid": true },
        { "type": "MergeUnitsInput",
          "value": { "expected_revision": 2, "first_unit_id": "0197675f-71f4-7000-8000-0000000000b1" },
          "valid": false, "note": "second_unit_id missing" },

        // ── ToggleExpressionPlacementInput / RewriteSurfaceInput ──
        { "type": "ToggleExpressionPlacementInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "expression_id": "0197675f-71f4-7000-8000-0000000000c1",
                     "display_unit_id": "0197675f-71f4-7000-8000-0000000000b2",
                     "trailing_unit_id": "0197675f-71f4-7000-8000-0000000000b3" }, "valid": true },
        { "type": "ToggleExpressionPlacementInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "display_unit_id": "0197675f-71f4-7000-8000-0000000000b2",
                     "trailing_unit_id": "0197675f-71f4-7000-8000-0000000000b3" }, "valid": false,
          "note": "expression_id missing" },
        { "type": "RewriteSurfaceInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "expression_id": "0197675f-71f4-7000-8000-0000000000c1",
                     "from": "x", "to": "y" }, "valid": true },
        { "type": "RewriteSurfaceInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "expression_id": "0197675f-71f4-7000-8000-0000000000c1", "from": "x" },
          "valid": false, "note": "to missing" },

        // ── InsertEquationsInput / EquationRowInput ──
        { "type": "InsertEquationsInput",
          "value": { "expected_revision": 2, "anchor_unit_id": "0197675f-71f4-7000-8000-0000000000b0",
                     "container_unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "rows": [ { "unit_id": "0197675f-71f4-7000-8000-0000000000b2",
                                 "content": { "kind": "math", "expr": sample_expr() }, "row_relation": "eq" },
                               { "unit_id": "0197675f-71f4-7000-8000-0000000000b3",
                                 "content": { "kind": "math", "expr": sample_expr() } } ] },
          "valid": true, "note": "per-row row_relation optional" },
        { "type": "InsertEquationsInput",
          "value": { "expected_revision": 2, "container_unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "rows": [] }, "valid": false, "note": "anchor_unit_id missing" },
        { "type": "EquationRowInput",
          "value": { "unit_id": "0197675f-71f4-7000-8000-0000000000b2",
                     "content": { "kind": "prose", "text": "where x>0", "inline": [] } },
          "valid": true, "note": "row_relation absent (None)" },
        { "type": "EquationRowInput",
          "value": { "content": { "kind": "math", "expr": sample_expr() } }, "valid": false,
          "note": "unit_id missing" },

        // ── LinkDraft / InsertReferenceInput ──
        { "type": "LinkDraft", "value": sample_link_draft(), "valid": true,
          "note": "optional refinement columns absent" },
        { "type": "LinkDraft",
          "value": { "id": "0197675f-71f4-7000-8000-0000000000a3", "link_type": "related",
                     "from_content": true }, "valid": false, "note": "source_object_id missing" },
        { "type": "InsertReferenceInput",
          "value": { "expected_revision": 2, "link": sample_link_draft() }, "valid": true },
        { "type": "InsertReferenceInput", "value": { "expected_revision": 2 }, "valid": false,
          "note": "link missing" },

        // ── ResolveTarget (deliberate notation asymmetry) ──
        { "type": "ResolveTarget",
          "value": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a2" },
          "valid": true },
        { "type": "ResolveTarget",
          "value": { "kind": "notation", "notation_id": "ntn-1" }, "valid": true,
          "note": "notation is SHAPE-valid here (unlike OccurrenceTarget); rejected at RUNTIME with target_kind_not_available_yet (slice 2)" },
        { "type": "ResolveTarget", "value": { "kind": "object" }, "valid": false,
          "note": "object_id missing" },
        { "type": "ResolveTarget", "value": { "kind": "symbol" }, "valid": false,
          "note": "unknown kind" },
        { "type": "ResolveOccurrenceInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "expression_id": "0197675f-71f4-7000-8000-0000000000c1", "occurrence_index": 0,
                     "link_id": "0197675f-71f4-7000-8000-0000000000a3",
                     "target": { "kind": "object", "object_id": "0197675f-71f4-7000-8000-0000000000a2" } },
          "valid": true },
        { "type": "ResolveOccurrenceInput",
          "value": { "expected_revision": 2, "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                     "expression_id": "0197675f-71f4-7000-8000-0000000000c1", "occurrence_index": 0,
                     "link_id": "0197675f-71f4-7000-8000-0000000000a3" }, "valid": false,
          "note": "target missing" },

        // ── MaterializeObjectInput ──
        { "type": "MaterializeObjectInput",
          "value": { "expected_revision": 2, "source_object": sample_object(),
                     "source_content": sample_math_content(),
                     "new_object_id": "0197675f-71f4-7000-8000-0000000000a9",
                     "new_provenance_id": "0197675f-71f4-7000-8000-0000000000d9",
                     "edge_link_id": "0197675f-71f4-7000-8000-0000000000a8",
                     "expr_id_map": [], "unit_id_map": [] }, "valid": true },
        { "type": "MaterializeObjectInput",
          "value": { "expected_revision": 2, "source_object": sample_object(),
                     "new_object_id": "0197675f-71f4-7000-8000-0000000000a9",
                     "new_provenance_id": "0197675f-71f4-7000-8000-0000000000d9",
                     "edge_link_id": "0197675f-71f4-7000-8000-0000000000a8",
                     "expr_id_map": [], "unit_id_map": [] }, "valid": false,
          "note": "source_content missing" },

        // ── RehomeSubtreeInput / DissolveObjectInput (slice 2a — the §9.y ownership ops) ──
        { "type": "RehomeSubtreeInput",
          "value": { "expected_revision": 1, "host_object": sample_object(),
                     "host_content": sample_math_content(),
                     "subtree_root": "0197675f-71f4-7000-8000-0000000000b1",
                     "new_object_id": "0197675f-71f4-7000-8000-0000000000a9",
                     "type": "theorem",
                     "embed_unit_id": "0197675f-71f4-7000-8000-0000000000b9",
                     "new_version_id": "0197675f-71f4-7000-8000-0000000000c9" }, "valid": true },
        { "type": "RehomeSubtreeInput",
          "value": { "expected_revision": 1, "host_object": sample_object(),
                     "host_content": sample_math_content(),
                     "new_object_id": "0197675f-71f4-7000-8000-0000000000a9",
                     "type": "theorem",
                     "embed_unit_id": "0197675f-71f4-7000-8000-0000000000b9",
                     "new_version_id": "0197675f-71f4-7000-8000-0000000000c9" }, "valid": false,
          "note": "subtree_root missing" },
        { "type": "DissolveObjectInput",
          "value": { "expected_revision": 2, "expected_dissolved_revision": 1,
                     "host_content": sample_math_content(),
                     "embed_unit_id": "0197675f-71f4-7000-8000-0000000000b9",
                     "dissolved_object_id": "0197675f-71f4-7000-8000-0000000000a9",
                     "dissolved_content": sample_math_content(),
                     "inbound_references": [] }, "valid": true },
        { "type": "DissolveObjectInput",
          "value": { "expected_revision": 2,
                     "host_content": sample_math_content(),
                     "embed_unit_id": "0197675f-71f4-7000-8000-0000000000b9",
                     "dissolved_object_id": "0197675f-71f4-7000-8000-0000000000a9",
                     "dissolved_content": sample_math_content(),
                     "inbound_references": [] }, "valid": false,
          "note": "expected_dissolved_revision missing (the second gate)" },

        // ── ValidationError (the new slice-1c op codes) ──
        { "type": "ValidationError",
          "value": { "code": "target_kind_not_available_yet", "kind": "notation" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "unit_not_found", "unit_id": "u-1" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "expression_not_found", "expression_id": "e-1" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "occurrence_out_of_range", "given": 3, "len": 1 }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "unsplittable_content_kind", "kind": "math" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "unmergeable_units", "reason": "units are not adjacent" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "id_count_mismatch", "expected": 2, "given": 1 }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "remap_incomplete", "kind": "expression" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "remap_incomplete" }, "valid": false, "note": "missing variant field `kind`" },
        // 1c review-fix codes
        { "type": "ValidationError",
          "value": { "code": "split_offset_out_of_range", "given": 9, "len": 4 }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "inline_atom_not_zero_width", "kind": "math" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "inline_span_out_of_bounds", "start": 9, "end": 9, "len": 2 },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "occurrence_span_out_of_bounds", "start": 5, "end": 9, "len": 3 },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "content_edge_missing_anchor" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "occurrence_already_resolved" }, "valid": true },
        { "type": "ValidationError",
          "value": { "code": "duplicate_source_id", "kind": "unit" }, "valid": true },
        // 2a ownership codes (§9.y)
        { "type": "ValidationError",
          "value": { "code": "dissolution_blocked", "references": ["0197675f-71f4-7000-8000-0000000000a8"] },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "embed_target_missing", "object_id": "0197675f-71f4-7000-8000-0000000000a9" },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "unit_in_multiple_objects", "unit_id": "0197675f-71f4-7000-8000-0000000000b1" },
          "valid": true },
        { "type": "ValidationError",
          "value": { "code": "dissolve_input_inconsistent", "reason": "dissolved_content.object_id mismatch" },
          "valid": true },

        // ════════════════ Slice 1d — numbering + .mathpack ════════════════
        // Shape only (serde ≡ zod). Semantic facts (counts matching the graph, name-beats-number
        // precedence) are CORE projection logic, not transport shape.

        // ── NumberingPolicy ──
        { "type": "NumberingPolicy",
          "value": { "numbered_types": ["theorem", "lemma"], "shared_counter": false }, "valid": true },
        { "type": "NumberingPolicy",
          "value": { "numbered_types": [], "shared_counter": true }, "valid": true,
          "note": "empty policy numbers nothing" },
        { "type": "NumberingPolicy",
          "value": { "numbered_types": ["group"], "shared_counter": true }, "valid": false,
          "note": "group is a content kind, never a unit type (§6.0b)" },
        { "type": "NumberingPolicy",
          "value": { "numbered_types": ["theorem"] }, "valid": false, "note": "shared_counter missing" },

        // ── UnitLabel (number + name both optional) ──
        { "type": "UnitLabel",
          "value": { "unit_id": "0197675f-71f4-7000-8000-0000000000b1", "unit_type": "theorem",
                     "number": 1, "name": "(★)" }, "valid": true },
        { "type": "UnitLabel",
          "value": { "unit_id": "0197675f-71f4-7000-8000-0000000000b1" }, "valid": true,
          "note": "unit_type/number/name absent — typeless, unnumbered, unnamed" },
        { "type": "UnitLabel",
          "value": { "unit_id": "0197675f-71f4-7000-8000-0000000000b1", "unit_type": null,
                     "number": null, "name": null }, "valid": true, "note": "explicit nulls" },
        { "type": "UnitLabel",
          "value": { "unit_type": "theorem", "number": 1 }, "valid": false, "note": "unit_id missing" },

        // ── DisplayLabels ──
        { "type": "DisplayLabels",
          "value": { "labels": [ { "unit_id": "0197675f-71f4-7000-8000-0000000000b1",
                                    "unit_type": "theorem", "number": 1, "name": null } ] },
          "valid": true },
        { "type": "DisplayLabels", "value": { "labels": [] }, "valid": true },
        { "type": "DisplayLabels", "value": {}, "valid": false,
          "note": "labels required (always present, [] when none)" },

        // ── AssetChecksum ──
        { "type": "AssetChecksum", "value": { "name": "fig1.pdf", "sha256": "9f2c…" }, "valid": true },
        { "type": "AssetChecksum", "value": { "name": "fig1.pdf" }, "valid": false,
          "note": "sha256 missing" },

        // ── MathpackMeta ──
        { "type": "MathpackMeta",
          "value": { "space_id": "0197675f-71f4-7000-8000-000000000003", "asset_checksums": [] },
          "valid": true },
        { "type": "MathpackMeta",
          "value": { "space_id": "0197675f-71f4-7000-8000-000000000003" }, "valid": false,
          "note": "asset_checksums required (always present, [] when none)" },

        // ── MathpackCounts ──
        { "type": "MathpackCounts", "value": sample_mathpack_counts(), "valid": true },
        { "type": "MathpackCounts",
          "value": { "objects": 1, "units": 1, "links": 0, "aliases": 0, "handles": 0, "tags": 0,
                     "taggings": 0, "object_versions": 1, "definition_details": 0,
                     "journal_day_details": 0, "provenance": 1 },
          "valid": false, "note": "provenance_derivations missing" },

        // ── MathpackManifest ──
        { "type": "MathpackManifest", "value": sample_mathpack_manifest(), "valid": true },
        { "type": "MathpackManifest",
          "value": { "format": "mathmeander.mathpack", "format_version": 1, "schema_version": 1,
                     "created_at": "2026-06-12T00:00:00Z",
                     "space_id": "0197675f-71f4-7000-8000-000000000003", "assets": [] },
          "valid": false, "note": "counts missing (shape requires it; format/version are CORE-validated)" },

        // ── MathpackGraph (deep composite; positive from real sub-samples) ──
        { "type": "MathpackGraph", "value": sample_mathpack_graph(), "valid": true },
        { "type": "MathpackGraph",
          "value": { "provenance": [], "provenance_derivations": [], "content": [], "links": [],
                     "aliases": [], "handles": [], "tags": [], "taggings": [], "object_versions": [],
                     "definition_details": [], "journal_day_details": [] },
          "valid": false, "note": "objects section missing" },

        // ── Mathpack / MathpackImport ──
        { "type": "Mathpack",
          "value": { "manifest": sample_mathpack_manifest(), "graph": sample_mathpack_graph() },
          "valid": true },
        { "type": "Mathpack", "value": { "manifest": sample_mathpack_manifest() }, "valid": false,
          "note": "graph missing" },
        { "type": "MathpackImport",
          "value": { "manifest": sample_mathpack_manifest(), "graph": sample_mathpack_graph() },
          "valid": true },
        { "type": "MathpackImport", "value": { "graph": sample_mathpack_graph() }, "valid": false,
          "note": "manifest missing" },

        // ════════════════ Slice 1d FFI envelopes (untagged ok/value | ok/error) ════════════════
        { "type": "OpOutcomeResult",
          "value": { "ok": true, "value": { "content": sample_math_content(), "links_upserted": [],
                     "links_staled": [], "expression_id_remap": [],
                     "version_snapshot": sample_object_version(), "new_objects": [],
                     "taggings_propagated": [], "host_content": null,
                     "host_version_snapshot": null, "objects_removed": [] } }, "valid": true },
        { "type": "OpOutcomeResult",
          "value": { "ok": false,
                     "error": { "kind": "validation", "code": "unit_not_found", "unit_id": "u-1" } },
          "valid": true },
        { "type": "OpOutcomeResult", "value": { "ok": true }, "valid": false,
          "note": "ok without value" },

        { "type": "NumberingResult",
          "value": { "ok": true, "value": { "labels": [
                       { "unit_id": "0197675f-71f4-7000-8000-0000000000b1", "unit_type": "theorem",
                         "number": 1, "name": null } ] } }, "valid": true },
        { "type": "NumberingResult",
          "value": { "ok": false, "error": { "kind": "malformed_input",
                     "context": "numbering policy", "message": "bad" } }, "valid": true },

        { "type": "MathpackResult",
          "value": { "ok": true,
                     "value": { "manifest": sample_mathpack_manifest(), "graph": sample_mathpack_graph() } },
          "valid": true },
        { "type": "MathpackResult", "value": { "ok": true }, "valid": false,
          "note": "ok without value" },

        { "type": "MathpackImportResult",
          "value": { "ok": true,
                     "value": { "manifest": sample_mathpack_manifest(), "graph": sample_mathpack_graph() } },
          "valid": true },
        { "type": "MathpackImportResult",
          "value": { "ok": false, "error": { "kind": "validation",
                     "code": "inline_span_out_of_bounds", "start": 9, "end": 9, "len": 2 } },
          "valid": true },
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
                "RowRelation" => serde_json::from_value::<RowRelation>(value.clone()).is_ok(),
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
                "JournalDayDetail" => {
                    serde_json::from_value::<JournalDayDetail>(value.clone()).is_ok()
                }
                "ProvenanceDerivation" => {
                    serde_json::from_value::<ProvenanceDerivation>(value.clone()).is_ok()
                }
                // ── Slice 1c canonical operations ──
                "MathContent" => serde_json::from_value::<MathContent>(value.clone()).is_ok(),
                "OpContext" => serde_json::from_value::<OpContext>(value.clone()).is_ok(),
                "OpOutcome" => serde_json::from_value::<OpOutcome>(value.clone()).is_ok(),
                "ExpressionIdRemap" => {
                    serde_json::from_value::<ExpressionIdRemap>(value.clone()).is_ok()
                }
                "UnitIdRemap" => serde_json::from_value::<UnitIdRemap>(value.clone()).is_ok(),
                "SetUnitTypeInput" => {
                    serde_json::from_value::<SetUnitTypeInput>(value.clone()).is_ok()
                }
                "SplitUnitInput" => serde_json::from_value::<SplitUnitInput>(value.clone()).is_ok(),
                "MergeUnitsInput" => {
                    serde_json::from_value::<MergeUnitsInput>(value.clone()).is_ok()
                }
                "ToggleExpressionPlacementInput" => {
                    serde_json::from_value::<ToggleExpressionPlacementInput>(value.clone()).is_ok()
                }
                "RewriteSurfaceInput" => {
                    serde_json::from_value::<RewriteSurfaceInput>(value.clone()).is_ok()
                }
                "InsertEquationsInput" => {
                    serde_json::from_value::<InsertEquationsInput>(value.clone()).is_ok()
                }
                "EquationRowInput" => {
                    serde_json::from_value::<EquationRowInput>(value.clone()).is_ok()
                }
                "LinkDraft" => serde_json::from_value::<LinkDraft>(value.clone()).is_ok(),
                "InsertReferenceInput" => {
                    serde_json::from_value::<InsertReferenceInput>(value.clone()).is_ok()
                }
                "ResolveTarget" => serde_json::from_value::<ResolveTarget>(value.clone()).is_ok(),
                "ResolveOccurrenceInput" => {
                    serde_json::from_value::<ResolveOccurrenceInput>(value.clone()).is_ok()
                }
                "MaterializeObjectInput" => {
                    serde_json::from_value::<MaterializeObjectInput>(value.clone()).is_ok()
                }
                "RehomeSubtreeInput" => {
                    serde_json::from_value::<RehomeSubtreeInput>(value.clone()).is_ok()
                }
                "DissolveObjectInput" => {
                    serde_json::from_value::<DissolveObjectInput>(value.clone()).is_ok()
                }
                // ── Slice 1d numbering + .mathpack ──
                "NumberingPolicy" => {
                    serde_json::from_value::<NumberingPolicy>(value.clone()).is_ok()
                }
                "UnitLabel" => serde_json::from_value::<UnitLabel>(value.clone()).is_ok(),
                "DisplayLabels" => serde_json::from_value::<DisplayLabels>(value.clone()).is_ok(),
                "AssetChecksum" => serde_json::from_value::<AssetChecksum>(value.clone()).is_ok(),
                "MathpackMeta" => serde_json::from_value::<MathpackMeta>(value.clone()).is_ok(),
                "MathpackCounts" => serde_json::from_value::<MathpackCounts>(value.clone()).is_ok(),
                "MathpackManifest" => {
                    serde_json::from_value::<MathpackManifest>(value.clone()).is_ok()
                }
                "MathpackGraph" => serde_json::from_value::<MathpackGraph>(value.clone()).is_ok(),
                "Mathpack" => serde_json::from_value::<Mathpack>(value.clone()).is_ok(),
                "MathpackImport" => serde_json::from_value::<MathpackImport>(value.clone()).is_ok(),
                // ── Slice 1d FFI envelopes ──
                "OpOutcomeResult" => {
                    serde_json::from_value::<OpOutcomeResult>(value.clone()).is_ok()
                }
                "NumberingResult" => {
                    serde_json::from_value::<NumberingResult>(value.clone()).is_ok()
                }
                "MathpackResult" => serde_json::from_value::<MathpackResult>(value.clone()).is_ok(),
                "MathpackImportResult" => {
                    serde_json::from_value::<MathpackImportResult>(value.clone()).is_ok()
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
