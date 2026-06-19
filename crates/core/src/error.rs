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

    /// A valid, producible type that may not be minted by the DIRECT typed-create path — it
    /// enters the graph by declaration → materialization (§9.y/§13a slice 2), never a raw POST.
    /// Distinct from `TypeNotProducibleYet` (reserved, no machinery yet): here the machinery
    /// exists (materialize / number / export); only the direct-create surface is gated.
    #[error("object type {object_type:?} is created by declaration, not direct creation")]
    TypeNotDirectlyCreatable { object_type: ObjectType },

    /// A producible type that is a §6.5 SURFACE (`journal_day`; `trail` later) — created via its own
    /// surface op (e.g. `create_journal_day`), never the output of greedy capture. Distinct from
    /// `TypeNotProducibleYet` (the target is not producible at all) and `TypeNotDirectlyCreatable`
    /// (the formal family, which IS a valid rehome target): a surface can never be MATERIALIZED, so
    /// `rehome_subtree` refuses it as a target even though it is producible (slice 2b).
    #[error(
        "object type {object_type:?} is a surface (created via its own op), not materializable"
    )]
    TypeNotMaterializable { object_type: ObjectType },

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

    // ── Slice 1c canonical-operation errors ───────────────────────────────────
    // Raised by the pure ops (`ops.rs`). The ops are TOTAL: every reachable failure is
    // one of these typed values, never a panic. Glue dispositions (1d `CORE_CODE_STATUS`):
    // stale-read / bad-request → 422; the two id-bookkeeping ones are glue bugs → 500.
    /// An op named a resolution/target kind whose machinery has not landed yet — e.g.
    /// resolving an occurrence to `notation` before the notation registry exists (slice 2).
    #[error("target kind {kind} is not available yet")]
    TargetKindNotAvailableYet { kind: String },

    /// An op referenced a unit id that is not in the supplied content (stale read / bad id).
    #[error("unit {unit_id} not found in content")]
    UnitNotFound { unit_id: String },

    /// An op referenced an expression id that is not in the target unit's content.
    #[error("expression {expression_id} not found in unit content")]
    ExpressionNotFound { expression_id: String },

    /// An occurrence index is past the end of the expression's occurrence list.
    #[error("occurrence index {given} out of range (len {len})")]
    OccurrenceOutOfRange { given: u32, len: u32 },

    /// `split_unit` was asked to split a unit whose content kind has no split semantics in
    /// slice 1 (only `prose` is splittable).
    #[error("content kind {kind} cannot be split")]
    UnsplittableContentKind { kind: String },

    /// `merge_units` was asked to merge units that are not mergeable (non-adjacent, different
    /// parent/object, or a non-prose content kind).
    #[error("units cannot be merged: {reason}")]
    UnmergeableUnits { reason: String },

    /// A list of fresh ids did not match the count it had to cover (e.g. `new_tagging_ids`
    /// vs the taggings to propagate). A glue minting bug, not a client error.
    #[error("id count mismatch: expected {expected}, given {given}")]
    IdCountMismatch { expected: u32, given: u32 },

    /// `materialize_object` was given an id remap that did not cover every {kind} in the
    /// source content — copying with a partial map would alias ids across objects. Glue bug.
    #[error("id remap is incomplete for {kind}")]
    RemapIncomplete { kind: String },

    /// `split_unit` was asked to split past the end of the unit's prose text.
    #[error("split offset {given} out of range (len {len})")]
    SplitOffsetOutOfRange { given: u32, len: u32 },

    /// An inline atom (`math`/`reference`) carries a non-zero-width span — the prose-atom
    /// contract requires `span.start == span.end` (its content lives in its own field, §6.0).
    /// A glue/editor bug, not a client error.
    #[error("inline {kind} atom must have a zero-width span")]
    InlineAtomNotZeroWidth { kind: String },

    /// An inline element's span falls outside its prose text — `start <= end <= text length`
    /// (char offsets) is the §6.0 well-formedness rule. The ops maintain it by construction; the
    /// import load path can't assume it, so it gates here (an out-of-bounds span mis-slices at the
    /// render/editor boundary). A glue/import bug, not a client error.
    #[error("inline span [{start}, {end}] is out of bounds for prose text of length {len}")]
    InlineSpanOutOfBounds { start: u32, end: u32, len: u32 },

    /// An occurrence's selector span falls outside its expression's `surface_text` —
    /// `start <= end <= surface_text length` (char offsets, §6.3a). Like inline spans, the ops
    /// maintain it by construction (the surface serializer produces in-bounds selectors); the
    /// import load path can't assume it, so it gates here — a corrupt selector is the slice-2
    /// resolution substrate, so it must not reach storage. A glue/import bug, not a client error.
    #[error("occurrence selector [{start}, {end}] is out of bounds for surface of length {len}")]
    OccurrenceSpanOutOfBounds { start: u32, end: u32, len: u32 },

    /// A content-derived edge (`from_content = true`) must record WHERE it came from —
    /// both `source_unit_id` and `content_locator` (§6.1b).
    #[error("a content-derived edge requires source_unit_id and content_locator")]
    ContentEdgeMissingAnchor,

    /// `resolve_occurrence` was asked to resolve an occurrence that is already resolved —
    /// re-resolving would overwrite the target and double-emit the edge (§6.3a).
    #[error("occurrence is already resolved")]
    OccurrenceAlreadyResolved,

    /// `materialize_object`'s source content contains a duplicate {kind} id — copying would
    /// alias the duplicates onto one fresh id via the remap. A glue/data bug.
    #[error("duplicate {kind} id in source content")]
    DuplicateSourceId { kind: String },

    /// `dissolve_object` was asked to dissolve a materialized object that inbound references
    /// depend on (edges/handles/review items, §9.y:1118). Dissolution becomes a REVIEWABLE
    /// operation, never a silent content move: the referencing ids are surfaced so the UI can
    /// offer deprecate / keep / detach. (Whether a reference exists is the glue's query; the core
    /// only decides, given the list — staying pure of the DB, §6.1b.)
    #[error("dissolution blocked: {} inbound reference(s) depend on this object", references.len())]
    DissolutionBlocked { references: Vec<String> },

    /// An `Embed{target: Object}` in imported content names an object absent from the pack — a
    /// referential break SQL can't FK-check (embed targets live in content, not a typed column),
    /// so the core owns it on the untrusted import path (§9.y/§6.5: a gone embed target is never
    /// silent). Re-home produces these embeds; the pack's transitive closure must include the target.
    #[error("embed targets object {object_id}, which is absent from the pack")]
    EmbedTargetMissing { object_id: String },

    /// A unit id appears in more than one object's content — a violation of one home (§6.0b): a
    /// re-homed unit must leave its old object, never linger in two. SQL's composite FK can't catch
    /// this across a whole imported pack, so the core does. Also raised by `dissolve_object` when the
    /// content being folded back would collide with a unit already in the host.
    #[error("unit {unit_id} appears in more than one object (one home, §6.0b)")]
    UnitInMultipleObjects { unit_id: String },

    /// A `*_detail.object_id` in an imported pack does not resolve to an object of the matching type
    /// within the pack — the §6.1a / arch-§827 type-qualified-reference invariant (`journal_day_detail`
    /// → `journal_day`, `definition_detail` → `definition`). SQL's FK checks the id EXISTS, never its
    /// TYPE, so the core owns it on the untrusted import path; at persist (2e) a malformed pack would
    /// otherwise silently store a type violation. `actual` is `None` when the object is absent from the
    /// pack entirely (the detail is orphaned). Distinct from the create-time `DetailTypeMismatch`
    /// (a glue-bug 500): this is a client-attributable bad import (422).
    #[error(
        "detail references object {object_id}, expected type {expected:?} but found {actual:?}"
    )]
    DetailObjectTypeMismatch {
        object_id: String,
        expected: ObjectType,
        actual: Option<ObjectType>,
    },

    /// `dissolve_object` was handed inconsistent inputs by the glue — the `dissolved_content` does
    /// not belong to `dissolved_object_id`, or the unit at `embed_unit_id` is not an `Embed` of that
    /// object. A precondition the glue assembles, so it can only mean a glue bug (a destructive op
    /// must mirror the copy path's `DuplicateSourceId` defensiveness — it never trusts its content).
    #[error("inconsistent dissolve input: {reason}")]
    DissolveInputInconsistent { reason: String },
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
