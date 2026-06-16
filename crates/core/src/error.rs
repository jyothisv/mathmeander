//! Typed validation errors — serde tagged unions carried in the schema artifact, so the
//! glue maps core errors to HTTP error envelopes WITHOUT interpretation (the error `code`
//! the client sees IS the serde tag). This union is also the type-gen pipeline's
//! representative hard case: internally tagged, variants with and without fields.

use serde::{Deserialize, Serialize};

use crate::model::{AliasScope, LinkType, ObjectType, Origin};

/// A domain validation failure. Errors are VALUES crossing the FFI (result envelopes),
/// never exceptions (arch doc §17 boundary discipline).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ValidationError {
    #[error("unknown object type: {given}")]
    UnknownObjectType { given: String },

    #[error("{field} is not a valid UUID")]
    InvalidId { field: String },

    /// Client-minted ids must be UUIDv7 (arch doc §4/§6.3 — sortable, client-mintable).
    #[error("{field} is not a UUIDv7")]
    NotUuidV7 { field: String },

    #[error("title exceeds {max_chars} characters (got {given_chars})")]
    TitleTooLong { max_chars: u32, given_chars: u32 },

    #[error("raw_source exceeds {max_bytes} bytes (got {given_bytes})")]
    RawSourceTooLarge { max_bytes: u64, given_bytes: u64 },

    /// First §6.1a origin-field invariant: `created_by` is required when origin = user.
    #[error("created_by is required when origin is {origin:?}")]
    MissingCreatedBy { origin: Origin },

    /// AI/import provenance is structurally impossible until its columns land (§6.1).
    #[error("origin {origin:?} is not producible yet")]
    OriginNotProducible { origin: Origin },

    #[error("schema_version mismatch: expected {expected}, got {given}")]
    SchemaVersionMismatch { expected: u32, given: u32 },

    /// A stored value claims a schema_version newer than this core understands —
    /// refusing loudly beats misreading user data (§2.2).
    #[error("stored schema_version {given} is newer than current {current}")]
    SchemaVersionFromTheFuture { given: u32, current: u32 },

    // ── Slice 1 canonical-object-core invariants (§6.1a) ──────────────────────
    // Polymorphic-reference and discipline invariants a relational schema can't fully
    // FK-check, so the core owns them. DECLARED here (and carried in the artifact) as the
    // crystallized error vocabulary; the operations that construct them land with the
    // canonical operations (slice 1c) — except `TypeNotProducibleYet`, enforced now on
    // the create path.
    /// A `links` row must set exactly one target arm. Slice 1's arms are
    /// `{target_object_id, unresolved_text}`; `given` is how many were set (§6.1a/§6.1b).
    #[error("a link must set exactly one target arm (got {given})")]
    LinkTargetNotExactlyOne { given: u32 },

    /// A deliberate edge (`from_content = false`) carries no object target — the typed
    /// knowledge graph stays object-only, no off-graph deliberate edges (§6.1a).
    #[error("a deliberate edge (from_content=false) requires target_object_id")]
    OffGraphDeliberateEdge,

    /// `target_unit_id` is set without `target_object_id` — a unit refinement requires
    /// its owning object target (§6.1a composite-FK discipline).
    #[error("target_unit_id requires target_object_id")]
    UnitTargetWithoutObject,

    /// A typed graph edge resolved to a non-object target (notation/source/unresolved) —
    /// every graph edge type requires an object target (§6.1a/§6.1b).
    #[error("link type {link_type:?} requires an object target")]
    TypedEdgeRequiresObjectTarget { link_type: LinkType },

    /// `target_selector` is set without `target_object_id` — a selector refines an object
    /// target, never substitutes for one (§6.1a).
    #[error("target_selector requires target_object_id")]
    SelectorWithoutObjectTarget,

    /// The derived `content_kind` would disagree with the unit's `content` tag (one fact,
    /// one home — the generated column must equal the union tag, §6.0b).
    #[error("content_kind mismatch: column says {column}, content tag is {content_tag}")]
    ContentKindMismatch { column: String, content_tag: String },

    /// A unit's `slot` is not valid for its parent's content kind (§6.0b/§6.1a).
    #[error("slot {slot:?} is not valid for parent content kind {parent_kind:?}")]
    InvalidSlotForParentKind { slot: String, parent_kind: String },

    /// `example_kind` is set on a unit whose `type` is not `example` (§6.0b).
    #[error("example_kind requires type = example")]
    ExampleKindWithoutExampleType,

    /// A `*_detail.object_id` references an object of the wrong type (§6.1a
    /// type-qualified references).
    #[error("detail row expects object type {expected:?}, but object is {given:?}")]
    DetailTypeMismatch {
        expected: ObjectType,
        given: ObjectType,
    },

    /// The create path cannot produce this object type yet (reserved vocabulary whose
    /// owning machinery lands in a later slice, §6.1a/§13a).
    #[error("object type {object_type:?} is not producible yet")]
    TypeNotProducibleYet { object_type: ObjectType },

    /// A `taggings` row must target exactly one of {object, unit}; `given` is how many
    /// were set (§6.0b).
    #[error("a tagging must target exactly one of {{object, unit}} (got {given})")]
    TaggingTargetNotExactlyOne { given: u32 },

    /// An alias's `scope` and `scope_ref` are inconsistent (§6.1a scope ↔ scope_ref).
    #[error("alias scope {scope:?} is inconsistent with its scope_ref")]
    AliasScopeRefMismatch { scope: AliasScope },

    /// A `handles` row must set exactly one refinement of {unit, expression}; `given` is
    /// how many were set (§6.3b/§6.1a).
    #[error("a handle must set exactly one of {{unit, expression}} (got {given})")]
    HandleTargetNotExactlyOne { given: u32 },

    /// `declared_by = ai` is structurally forbidden: AI proposals are review_items, never
    /// canonical units; acceptance enters as `user` (§3.9/§6.0).
    #[error("declared_by can never be ai (AI proposals are review_items)")]
    DeclaredByAi,
}

/// Errors crossing the FFI result envelope: a domain validation failure, or input that
/// did not even parse as the expected shape. Tagged so the glue dispatches without
/// string-matching.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreError {
    #[error("malformed {context}: {message}")]
    MalformedInput { context: String, message: String },

    #[error(transparent)]
    Validation {
        #[serde(flatten)]
        #[from]
        error: ValidationError,
    },
}
