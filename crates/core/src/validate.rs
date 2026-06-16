//! Validation — turning untrusted input into canonical values or typed errors (arch
//! doc §5). The core is the SEMANTIC authority: vocabulary membership, id version bits,
//! origin-field invariants, boundary caps. Generated zod at the HTTP edge checks
//! transport shape only; everything here is the real gate.
//!
//! Inputs are deliberately stringly-typed where the client supplies them — parsing them
//! HERE is what produces typed `ValidationError`s instead of opaque serde failures.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ValidationError;
use crate::ids::{ObjectId, ProvenanceId, SpaceId};
use crate::model::{CanonicalObject, ObjectStatus, ObjectType, Origin, Provenance};
use crate::patch::Patch;

/// Boundary caps, mirrored in the generated zod (via the artifact) only as documentation;
/// the core enforces them.
pub const MAX_TITLE_CHARS: u32 = 1024;
pub const MAX_RAW_SOURCE_BYTES: u64 = 1_048_576;

/// Client-supplied create payload. `status` / `schema_version` / `revision` are NOT
/// client-suppliable — the core stamps them (fewer representable invalid states).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct CreateObjectInput {
    /// Client-minted UUIDv7, as a string — the core parses and version-checks it.
    pub id: String,
    #[serde(rename = "type")]
    pub object_type: String,
    pub title: Option<String>,
    pub raw_source: Option<String>,
}

/// Server-side context for a create: who/what is creating (origin + actor) and the
/// glue-minted provenance id. Never client-supplied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct CreateContext {
    pub provenance_id: String,
    pub origin: Origin,
    pub created_by: Option<String>,
}

/// PATCH payload for object metadata (title is the only patchable field in the walking
/// skeleton). `expected_revision` is enforced by the glue's conditional UPDATE (§6.4);
/// it rides here so the request shape is core-defined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct ObjectPatch {
    pub expected_revision: u32,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub title: Patch<String>,
}

fn parse_uuid(field: &'static str, value: &str) -> Result<Uuid, ValidationError> {
    Uuid::parse_str(value).map_err(|_| ValidationError::InvalidId {
        field: field.into(),
    })
}

fn parse_uuid_v7(field: &'static str, value: &str) -> Result<Uuid, ValidationError> {
    let id = parse_uuid(field, value)?;
    if id.get_version_num() != 7 {
        return Err(ValidationError::NotUuidV7 {
            field: field.into(),
        });
    }
    Ok(id)
}

fn check_title(title: &str) -> Result<(), ValidationError> {
    let chars = title.chars().count() as u32;
    if chars > MAX_TITLE_CHARS {
        return Err(ValidationError::TitleTooLong {
            max_chars: MAX_TITLE_CHARS,
            given_chars: chars,
        });
    }
    Ok(())
}

fn check_raw_source(raw_source: &str) -> Result<(), ValidationError> {
    let bytes = raw_source.len() as u64;
    if bytes > MAX_RAW_SOURCE_BYTES {
        return Err(ValidationError::RawSourceTooLarge {
            max_bytes: MAX_RAW_SOURCE_BYTES,
            given_bytes: bytes,
        });
    }
    Ok(())
}

fn parse_object_type(given: &str) -> Result<ObjectType, ValidationError> {
    serde_json::from_value::<ObjectType>(serde_json::Value::String(given.to_owned())).map_err(
        |_| ValidationError::UnknownObjectType {
            given: given.to_owned(),
        },
    )
}

/// Construct a canonical (object, provenance) pair from untrusted input + server
/// context. The core stamps status (`Draft`), schema_version (current), revision (1),
/// and both timestamps from the passed-in `now` — it never reads a clock.
pub fn create_object(
    input: &CreateObjectInput,
    ctx: &CreateContext,
    space_id: &str,
    now: DateTime<Utc>,
) -> Result<(CanonicalObject, Provenance), ValidationError> {
    let id = ObjectId(parse_uuid_v7("id", &input.id)?);
    let object_type = parse_object_type(&input.object_type)?;
    if !object_type.is_producible() {
        // Reserved vocabulary (source_excerpt/trail/annotation/journal_day): valid to
        // read, but their owning machinery lands in later slices (§6.1a/§13a).
        return Err(ValidationError::TypeNotProducibleYet { object_type });
    }
    if let Some(title) = &input.title {
        check_title(title)?;
    }
    if let Some(raw_source) = &input.raw_source {
        check_raw_source(raw_source)?;
    }

    let provenance_id = ProvenanceId(parse_uuid_v7("provenance_id", &ctx.provenance_id)?);
    let space = SpaceId(parse_uuid("space_id", space_id)?);

    match ctx.origin {
        Origin::User if ctx.created_by.is_none() => {
            return Err(ValidationError::MissingCreatedBy { origin: ctx.origin });
        }
        Origin::Ai | Origin::Imported => {
            // Not producible until the AI/import provenance columns land with their
            // slices (§6.1) — the invariant is a validation fact, not a gap.
            return Err(ValidationError::OriginNotProducible { origin: ctx.origin });
        }
        _ => {}
    }

    let provenance = Provenance {
        id: provenance_id,
        origin: ctx.origin,
        created_by: ctx.created_by.clone(),
        occurred_at: now,
    };

    let object = CanonicalObject {
        id,
        object_type,
        title: input.title.clone(), // Some("") stays Some("") — tri-state preserved
        raw_source: input.raw_source.clone(), // verbatim (§2.2)
        status: ObjectStatus::Draft,
        schema_version: crate::CURRENT_SCHEMA_VERSION,
        revision: 1,
        provenance_id,
        space_id: space,
        created_at: now,
        updated_at: now,
        extra: serde_json::Map::new(), // a fresh create has no foreign fields
    };

    Ok((object, provenance))
}

/// Apply a metadata patch (pure). Revision increments; `updated_at` becomes `now`;
/// everything else — including `raw_source` and `created_at` — is untouched. The
/// concurrency conflict itself (expected_revision vs the row) is enforced by the glue's
/// conditional UPDATE (§6.4); this function assumes the glue passed the row it read.
pub fn apply_title_patch(
    current: &CanonicalObject,
    patch: &ObjectPatch,
    now: DateTime<Utc>,
) -> Result<CanonicalObject, ValidationError> {
    if let Patch::Set(title) = &patch.title {
        check_title(title)?;
    }
    let mut next = current.clone();
    next.title = patch.title.clone().apply_to(current.title.clone());
    next.revision = current.revision + 1;
    next.updated_at = now;
    Ok(next)
}
