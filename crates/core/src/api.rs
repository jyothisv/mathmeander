//! The core's FFI surface: string-in/string-out PURE functions, wrapped 1:1 by the
//! napi addon (and, later, a WASM build — same functions). JSON strings cross the
//! boundary; results are ENVELOPES (`{ok:true,value}` / `{ok:false,error}`) — domain
//! failures are values, never exceptions (arch doc §17).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::mathpack::{Mathpack, MathpackGraph, MathpackImport, MathpackMeta};
use crate::model::{Alias, CanonicalObject, Handle, Link, Provenance, Tagging, Unit};
use crate::numbering::{DisplayLabels, NumberingPolicy};
use crate::ops::{
    InsertReferenceInput, MaterializeObjectInput, MathContent, MergeUnitsInput, OpContext,
    OpOutcome, ResolveOccurrenceInput, RewriteSurfaceInput, SetUnitTypeInput, SplitUnitInput,
    ToggleExpressionPlacementInput,
};
use crate::validate::{CreateContext, CreateObjectInput, ObjectPatch};

/// Serializes as literal `true`; gives the envelope a real discriminator in the
/// schema artifact (and a `z.literal(true)` in generated zod).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OkTrue;

/// Serializes as literal `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OkFalse;

impl Serialize for OkTrue {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}
impl Serialize for OkFalse {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(false)
    }
}
impl<'de> Deserialize<'de> for OkTrue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match bool::deserialize(d)? {
            true => Ok(OkTrue),
            false => Err(serde::de::Error::custom("expected literal true")),
        }
    }
}
impl<'de> Deserialize<'de> for OkFalse {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match bool::deserialize(d)? {
            false => Ok(OkFalse),
            true => Err(serde::de::Error::custom("expected literal false")),
        }
    }
}

#[cfg(feature = "schema-artifact")]
mod ok_schemas {
    use super::{OkFalse, OkTrue};

    impl schemars::JsonSchema for OkTrue {
        fn schema_name() -> std::borrow::Cow<'static, str> {
            "OkTrue".into()
        }
        fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
            schemars::json_schema!({ "type": "boolean", "const": true })
        }
    }
    impl schemars::JsonSchema for OkFalse {
        fn schema_name() -> std::borrow::Cow<'static, str> {
            "OkFalse".into()
        }
        fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
            schemars::json_schema!({ "type": "boolean", "const": false })
        }
    }
}

macro_rules! core_result {
    ($(#[$doc:meta])* $name:ident, $ok:ty) => {
        $(#[$doc])*
        #[derive(Debug, Serialize, Deserialize)]
        #[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
        #[serde(untagged)]
        // Envelopes are constructed once and serialized immediately; the Ok/Err size
        // skew clippy flags is irrelevant here.
        #[allow(clippy::large_enum_variant)]
        pub enum $name {
            Ok { ok: OkTrue, value: $ok },
            Err { ok: OkFalse, error: CoreError },
        }

        impl $name {
            fn from_result(r: Result<$ok, CoreError>) -> Self {
                match r {
                    Result::Ok(value) => Self::Ok { ok: OkTrue, value },
                    Result::Err(error) => Self::Err { ok: OkFalse, error },
                }
            }

            fn to_json(&self) -> String {
                serde_json::to_string(self).expect("envelope serializes")
            }
        }
    };
}

/// What a successful create yields: both rows the glue persists in ONE transaction.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct CreatedObject {
    pub object: CanonicalObject,
    pub provenance: Provenance,
}

core_result!(
    /// Envelope of `create_object`.
    CreateObjectResult, CreatedObject
);
core_result!(
    /// Envelope of `apply_title_patch` and `parse_and_migrate_object`.
    ObjectResult, CanonicalObject
);
core_result!(
    /// Envelope of every unit-level canonical operation (all eight yield an `OpOutcome`).
    OpOutcomeResult, OpOutcome
);
core_result!(
    /// Envelope of `project_numbering` (the §6.3b display-label projection).
    NumberingResult, DisplayLabels
);
core_result!(
    /// Envelope of `export_mathpack` (the deterministic manifest + canonical graph).
    MathpackResult, Mathpack
);
core_result!(
    /// Envelope of `import_mathpack` (the validated, per-object-migrated bundle).
    MathpackImportResult, MathpackImport
);

fn parse_input<T: serde::de::DeserializeOwned>(
    context: &'static str,
    json: &str,
) -> Result<T, CoreError> {
    serde_json::from_str(json).map_err(|e| CoreError::MalformedInput {
        context: context.into(),
        message: e.to_string(),
    })
}

fn parse_now(now_iso: &str) -> Result<DateTime<Utc>, CoreError> {
    DateTime::parse_from_rfc3339(now_iso)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|e| CoreError::MalformedInput {
            context: "now".into(),
            message: e.to_string(),
        })
}

/// Create: untrusted input + server context + now → (object, provenance) envelope.
pub fn create_object(input_json: &str, ctx_json: &str, space_id: &str, now_iso: &str) -> String {
    let result = (|| {
        let input: CreateObjectInput = parse_input("create input", input_json)?;
        let ctx: CreateContext = parse_input("create context", ctx_json)?;
        let now = parse_now(now_iso)?;
        let (object, provenance) = crate::validate::create_object(&input, &ctx, space_id, now)?;
        Ok(CreatedObject { object, provenance })
    })();
    CreateObjectResult::from_result(result).to_json()
}

/// Patch object metadata (pure; concurrency is the glue's conditional UPDATE, §6.4).
pub fn apply_title_patch(current_json: &str, patch_json: &str, now_iso: &str) -> String {
    let result = (|| {
        let current: CanonicalObject = parse_input("current object", current_json)?;
        let patch: ObjectPatch = parse_input("patch", patch_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::validate::apply_title_patch(&current, &patch, now)?)
    })();
    ObjectResult::from_result(result).to_json()
}

/// The read path: stored JSON → migrate → validate → canonical object envelope.
pub fn parse_and_migrate_object(stored_json: &str) -> String {
    let result = (|| {
        let stored: serde_json::Value = parse_input("stored object", stored_json)?;
        crate::migrate::parse_and_migrate_object(stored)
    })();
    ObjectResult::from_result(result).to_json()
}

// ── Slice 1c canonical operations (§6.0a) ──────────────────────────────────────
// String-in/envelope-out per op. The glue assembles `content` from the SQL load, supplies
// `input` (the request body, with fresh ids glue-minted), and `ctx` (OpContext). `?` lifts the
// op's `ValidationError` into `CoreError` via the `#[from]` on `CoreError::Validation`. The two
// ops that re-anchor/re-point take the current rows as an extra JSON arg.

/// Set a unit's type (`Patch<UnitType>`) → `OpOutcomeResult` JSON.
pub fn set_unit_type(
    content_json: &str,
    input_json: &str,
    ctx_json: &str,
    now_iso: &str,
) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let input: SetUnitTypeInput = parse_input("set_unit_type input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::set_unit_type(content, &input, &ctx, now)?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Split a prose unit at a char offset → `OpOutcomeResult` JSON.
pub fn split_unit(content_json: &str, input_json: &str, ctx_json: &str, now_iso: &str) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let input: SplitUnitInput = parse_input("split_unit input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::split_unit(content, &input, &ctx, now)?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Merge two adjacent prose units (needs the current taggings to re-point) → `OpOutcomeResult` JSON.
pub fn merge_units(
    content_json: &str,
    current_taggings_json: &str,
    input_json: &str,
    ctx_json: &str,
    now_iso: &str,
) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let current_taggings: Vec<Tagging> =
            parse_input("current taggings", current_taggings_json)?;
        let input: MergeUnitsInput = parse_input("merge_units input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::merge_units(
            content,
            &current_taggings,
            &input,
            &ctx,
            now,
        )?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Toggle an expression between inline and display placement → `OpOutcomeResult` JSON.
pub fn toggle_expression_placement(
    content_json: &str,
    input_json: &str,
    ctx_json: &str,
    now_iso: &str,
) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let input: ToggleExpressionPlacementInput =
            parse_input("toggle_expression_placement input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::toggle_expression_placement(
            content, &input, &ctx, now,
        )?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Rewrite a surface (rename), re-anchoring inbound edges (needs the current links) → `OpOutcomeResult` JSON.
pub fn rewrite_surface(
    content_json: &str,
    current_links_json: &str,
    input_json: &str,
    ctx_json: &str,
    now_iso: &str,
) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let current_links: Vec<Link> = parse_input("current links", current_links_json)?;
        let input: RewriteSurfaceInput = parse_input("rewrite_surface input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::rewrite_surface(
            content,
            &current_links,
            &input,
            &ctx,
            now,
        )?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Insert a reference edge from content → `OpOutcomeResult` JSON.
pub fn insert_reference(
    content_json: &str,
    input_json: &str,
    ctx_json: &str,
    now_iso: &str,
) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let input: InsertReferenceInput = parse_input("insert_reference input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::insert_reference(content, &input, &ctx, now)?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Resolve an occurrence to a target → `OpOutcomeResult` JSON.
pub fn resolve_occurrence(
    content_json: &str,
    input_json: &str,
    ctx_json: &str,
    now_iso: &str,
) -> String {
    let result = (|| {
        let content: MathContent = parse_input("content", content_json)?;
        let input: ResolveOccurrenceInput = parse_input("resolve_occurrence input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::resolve_occurrence(content, &input, &ctx, now)?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

/// Materialize a copy-and-edge stand-in object (input carries the source) → `OpOutcomeResult` JSON.
pub fn materialize_object(input_json: &str, ctx_json: &str, now_iso: &str) -> String {
    let result = (|| {
        let input: MaterializeObjectInput = parse_input("materialize_object input", input_json)?;
        let ctx: OpContext = parse_input("op context", ctx_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::ops::materialize_object(&input, &ctx, now)?)
    })();
    OpOutcomeResult::from_result(result).to_json()
}

// ── Slice 1d projections + packaging (§6.3b, §10) ──────────────────────────────

/// Project display labels over an object's units (policy passed in) → `NumberingResult` JSON.
/// The projection is infallible; the envelope's `Err` arm is only reachable via `MalformedInput`.
pub fn project_numbering(
    units_json: &str,
    aliases_json: &str,
    handles_json: &str,
    policy_json: &str,
) -> String {
    let result = (|| {
        let units: Vec<Unit> = parse_input("units", units_json)?;
        let aliases: Vec<Alias> = parse_input("aliases", aliases_json)?;
        let handles: Vec<Handle> = parse_input("handles", handles_json)?;
        let policy: NumberingPolicy = parse_input("numbering policy", policy_json)?;
        Ok(crate::numbering::project_display_labels(
            &units, &aliases, &handles, &policy,
        ))
    })();
    NumberingResult::from_result(result).to_json()
}

/// Build an export bundle (manifest + graph) from glue-supplied meta + graph → `MathpackResult` JSON.
pub fn export_mathpack(meta_json: &str, graph_json: &str, now_iso: &str) -> String {
    let result = (|| {
        let meta: MathpackMeta = parse_input("mathpack meta", meta_json)?;
        let graph: MathpackGraph = parse_input("mathpack graph", graph_json)?;
        let now = parse_now(now_iso)?;
        crate::mathpack::serialize_mathpack(&meta, graph, now)
    })();
    MathpackResult::from_result(result).to_json()
}

/// Import an untrusted bundle: validate the manifest + graph body, migrate each object, echo the
/// canonical graph → `MathpackImportResult` JSON. (Persistence is the glue's, deferred to slice 2.)
pub fn import_mathpack(bundle_json: &str) -> String {
    let result = (|| {
        let bundle: serde_json::Value = parse_input("mathpack bundle", bundle_json)?;
        crate::mathpack::import_mathpack(bundle)
    })();
    MathpackImportResult::from_result(result).to_json()
}
