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
use crate::model::{
    CanonicalObject, Inline, Link, LinkType, ObjectStatus, ObjectType, Origin, Provenance, Tagging,
};
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
    if !object_type.is_directly_creatable() {
        // The formal family is producible, but only by declaration → materialization
        // (§9.y, slice 2) — never a raw typed POST. Only `note` is directly creatable.
        return Err(ValidationError::TypeNotDirectlyCreatable { object_type });
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

/// The §6.1a `links` invariants a relational schema can't fully FK-check, so the core owns
/// them (arch doc §6.1a/§6.1b). 1a DECLARED the error vocabulary; the constructing ops live
/// in slice 1c, so the enforcement lands here, with them. Every edge an op emits
/// (`insert_reference`, `resolve_occurrence`, the `materialize_object` derived-from edge)
/// runs through this gate.
///
/// `related` is the one type that may stay unresolved (carry `unresolved_text`); every other
/// `link_type` is a typed graph edge that requires an object target (model.rs `LinkType`).
pub fn validate_link(link: &Link) -> Result<(), ValidationError> {
    // Exactly one of the slice-1 target arms {object, unresolved_text}.
    let arms =
        u32::from(link.target_object_id.is_some()) + u32::from(link.unresolved_text.is_some());
    if arms != 1 {
        return Err(ValidationError::LinkTargetNotExactlyOne { given: arms });
    }
    // A deliberate edge (from_content = false) must be on-graph (object target).
    if !link.from_content && link.target_object_id.is_none() {
        return Err(ValidationError::OffGraphDeliberateEdge);
    }
    // A typed graph edge requires an object target; `related` is the only exception.
    if link.link_type != LinkType::Related && link.target_object_id.is_none() {
        return Err(ValidationError::TypedEdgeRequiresObjectTarget {
            link_type: link.link_type,
        });
    }
    // Unit / selector refinements refine an object target — never substitute for one.
    if link.target_unit_id.is_some() && link.target_object_id.is_none() {
        return Err(ValidationError::UnitTargetWithoutObject);
    }
    if link.target_selector.is_some() && link.target_object_id.is_none() {
        return Err(ValidationError::SelectorWithoutObjectTarget);
    }
    // A content-derived edge must record WHERE in content it came from (§6.1b).
    if link.from_content && (link.source_unit_id.is_none() || link.content_locator.is_none()) {
        return Err(ValidationError::ContentEdgeMissingAnchor);
    }
    Ok(())
}

/// The §6.0b `taggings` invariant: a tagging targets exactly one of {object, unit}. Mirrors
/// `validate_link` so every tagging an op emits (split/merge propagation) is gated.
pub fn validate_tagging(tagging: &Tagging) -> Result<(), ValidationError> {
    let arms =
        u32::from(tagging.tagged_object_id.is_some()) + u32::from(tagging.tagged_unit_id.is_some());
    if arms != 1 {
        return Err(ValidationError::TaggingTargetNotExactlyOne { given: arms });
    }
    Ok(())
}

/// The §6.0 inline-atom contract: `Math`/`Reference` (content-bearing atoms) MUST have a
/// zero-width span — their surface lives in their own field, not in the prose `text` (single
/// source of truth, §2.2). `Mark` (a formatting overlay) may be a region. Enforced mechanically
/// so a future op/editor can't reintroduce width (which would corrupt prose offsets on rewrite,
/// §6.3a). The ops that touch a prose unit's inline run this; 1d's load path runs it over all
/// content.
pub fn validate_inline(inline: &Inline) -> Result<(), ValidationError> {
    let (kind, span) = match inline {
        Inline::Math { span, .. } => ("math", span),
        Inline::Reference { span, .. } => ("reference", span),
        Inline::Mark { .. } => return Ok(()),
    };
    if span.start == span.end {
        Ok(())
    } else {
        Err(ValidationError::InlineAtomNotZeroWidth { kind: kind.into() })
    }
}

/// FULL inline well-formedness for a prose unit (§6.0): every inline span (Mark included) is
/// in-bounds — `start <= end <= text` char-length — AND every content-bearing atom is zero-width.
/// The ops maintain bounds by construction (`ops::split_prose_at`), so they call `validate_inline`
/// (zero-width only); the IMPORT load path is the first caller where bounds aren't guaranteed, so
/// it runs this. `pub` for reuse by the Pass-1d `mathpack::validate_graph` and the Pass-2 glue.
pub fn validate_prose_inline(text: &str, inline: &[Inline]) -> Result<(), ValidationError> {
    let len = text.chars().count() as u32;
    for element in inline {
        let span = match element {
            Inline::Mark { span, .. }
            | Inline::Math { span, .. }
            | Inline::Reference { span, .. } => span,
        };
        if span.start > span.end || span.end > len {
            return Err(ValidationError::InlineSpanOutOfBounds {
                start: span.start,
                end: span.end,
                len,
            });
        }
        validate_inline(element)?; // the atom zero-width rule, not duplicated
    }
    Ok(())
}
