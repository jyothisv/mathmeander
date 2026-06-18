//! Unit-level canonical operations (arch doc §6.0a/§6.3a) — slices 1c/2a. The PURE transforms
//! over an object's content: split/merge units, set a unit's type, toggle an expression
//! between inline and display, rewrite a surface (re-anchoring edges), insert/resolve
//! references, COPY an object, and the §9.y greedy-capture pair `rehome_subtree`/`dissolve_object`.
//! Each is `fn(content, …) -> Result<OpOutcome, ValidationError>`; time and freshly-minted ids are
//! PASSED IN (the core mints nothing, reads no clock, §5).
//!
//! Two load-bearing invariants live here from the first commit (they can't be retrofitted —
//! arch doc §13a build-order):
//!   • **Expression-id stability.** Split/merge/toggle MOVE `MathExpression`s by value, so their
//!     `id`s are PRESERVED (empty `expression_id_remap`) — and so does `rehome_subtree`, which moves
//!     a whole subtree between objects keeping ids intact (backlinks/anchors must survive). ONLY the
//!     COPY path (`materialize_object`) mints fresh ids (a populated remap), because a copy is a new
//!     identity. The matrix proptest (`tests/properties.rs`) gates copy; `tests/ownership.rs` gates
//!     re-home's preservation.
//!   • **Before-anchors keystone (§6.3a).** Re-canonicalizing a surface that already has
//!     anchors goes ONLY through `rewrite_with_remap` (which is GIVEN the anchors and remaps
//!     them); `rewrite_surface` here is its sole caller. This module never calls
//!     `normalize_fresh` — that path is for fresh (zero-anchor) input only, enforced by its
//!     span-less signature.
//!
//! **The inline contract (§6.0).** An inline element with its own content field is a ZERO-WIDTH
//! ATOM (`Math` → `expr`, `Reference` → `text`; `span = [p,p]`, prose `text` holds no chars for
//! it); `Mark` is a region overlaying real text. `validate_inline` enforces it. Toggle is the
//! `$$`/`$` gesture: *promote* (`displayize`) splits the prose at the atom's position and inserts
//! a display `Math` unit between the halves (eliding empties); *demote* (`inlineize`) joins the
//! flanking prose and reinserts the atom — reversible by construction. The same prose split/join
//! cores (`split_prose_at`/`join_prose`) back split/merge AND toggle, so they can't drift; the
//! slice-2 editor's `$$`-parse path reuses `displayize`.
//!
//! `expected_revision` rides every op DTO but is **never read by core logic** — the glue's
//! conditional `WHERE revision = expected` owns optimistic concurrency (§6.4). Each op produces
//! the intended next content (`revision + 1`) and an append-only `version_snapshot`, mirroring
//! `validate::apply_title_patch`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use mathmeander_surface::{SurfaceEdit, rewrite_with_remap};

use crate::error::ValidationError;
use crate::ids::{
    ExpressionId, LinkId, ObjectId, ObjectVersionId, ProvenanceId, TagId, TaggingId, UnitId,
};
use crate::model::{
    CanonicalObject, CharSpan, ContentLocator, DeclaredBy, EmbedTarget, Inline, Link, LinkStatus,
    LinkType, MathExpression, ObjectStatus, ObjectType, ObjectVersion, Occurrence,
    OccurrenceTarget, Tagging, TargetSelector, Unit, UnitContent, UnitStatus, UnitType,
};
use crate::patch::Patch;
use crate::validate::{validate_inline, validate_link, validate_tagging};

// ════════════════════════════════════════════════════════════════════════════════
// Carriers
// ════════════════════════════════════════════════════════════════════════════════

/// The working content aggregate an op transforms: one object's units plus its concurrency
/// token. NOT a persisted row — the glue assembles it from `content_units` + `objects.revision`
/// (§6.0b/§6.4) and writes the resulting `OpOutcome` back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MathContent {
    pub object_id: crate::ids::ObjectId,
    pub revision: u32,
    pub units: Vec<Unit>,
}

/// One old→new expression-id mapping (materialize copies mint fresh ids, §6.3a).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct ExpressionIdRemap {
    pub from: ExpressionId,
    pub to: ExpressionId,
}

/// One old→new unit-id mapping (materialize re-homes copied units).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct UnitIdRemap {
    pub from: UnitId,
    pub to: UnitId,
}

/// Glue-supplied minting context for an op (mirrors `validate::CreateContext`). `now` is a
/// separate fn arg, like `create_object`. Ids are typed newtypes (glue-minted/trusted — a
/// malformed one is a glue bug surfaced as `MalformedInput` at the FFI boundary, slice 1d).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct OpContext {
    /// Stamps the emitted Links / Taggings / the version checkpoint.
    pub provenance_id: ProvenanceId,
    /// Pre-minted id for this op's `version_snapshot` row.
    pub version_id: ObjectVersionId,
}

/// Everything an op produces, for the glue to persist in one transaction. Vectors are empty
/// for ops that don't touch that facet (e.g. only `materialize_object` fills `new_objects`).
///
/// **Single- vs two-object writes.** Most ops mutate ONE object: `content` + `version_snapshot`
/// describe it, and `host_content`/`host_version_snapshot` stay `None`. `rehome_subtree` (§9.y
/// greedy capture) is a TWO-object write: `content`/`version_snapshot`/`new_objects` describe the
/// NEW object the subtree moved into, and `host_content`/`host_version_snapshot` describe the host
/// it left (now carrying one `Embed`). `dissolve_object` is the inverse: `content` is the surviving
/// host (subtree folded back), `objects_removed` names the object that disappeared.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct OpOutcome {
    pub content: MathContent,
    /// Full edge rows to insert/update (`insert_reference`, `resolve_occurrence`, the
    /// re-anchored edges from `rewrite_surface`, the materialize edge).
    pub links_upserted: Vec<Link>,
    /// Edges whose anchor could not be re-placed → the glue marks them stale, never drops
    /// (§6.1b). A staled edge is reported here ONLY (an id), not also in `links_upserted`.
    pub links_staled: Vec<LinkId>,
    /// Old→new expression ids; EMPTY unless ids were re-minted (the `materialize_object` copy).
    pub expression_id_remap: Vec<ExpressionIdRemap>,
    /// The append-only history checkpoint for the `content` object (§6.4).
    pub version_snapshot: ObjectVersion,
    /// Newly created objects (the `materialize_object` copy; `rehome_subtree`'s new object);
    /// empty otherwise.
    pub new_objects: Vec<CanonicalObject>,
    /// Taggings copied (split) or re-pointed (merge).
    pub taggings_propagated: Vec<Tagging>,
    /// The MUTATED HOST of a two-object write (`rehome_subtree`): the surface the subtree left,
    /// now carrying one `Embed{target: Object}`. `None` for single-object ops (one home, §6.0b).
    pub host_content: Option<MathContent>,
    /// The host's history checkpoint, paired with `host_content`. `None` for single-object ops.
    pub host_version_snapshot: Option<ObjectVersion>,
    /// Objects that DISAPPEAR with this write (`dissolve_object` folds an object's content back
    /// into its host and removes the object). Empty otherwise.
    pub objects_removed: Vec<ObjectId>,
}

impl OpOutcome {
    /// Build an outcome over freshly-revisioned `content`, with every delta vector empty;
    /// each op fills the facets it touches.
    fn new(content: MathContent, ctx: &OpContext, now: DateTime<Utc>) -> Self {
        let version_snapshot = snapshot(&content, ctx, now);
        OpOutcome {
            content,
            links_upserted: Vec::new(),
            links_staled: Vec::new(),
            expression_id_remap: Vec::new(),
            version_snapshot,
            new_objects: Vec::new(),
            taggings_propagated: Vec::new(),
            host_content: None,
            host_version_snapshot: None,
            objects_removed: Vec::new(),
        }
    }
}

/// The append-only `ObjectVersion` for a write (§6.4). `version_no` is the new revision
/// (content is revision-bumped before this runs); the snapshot is the content aggregate,
/// carried opaquely (the §6 JSONB log exception).
fn snapshot(content: &MathContent, ctx: &OpContext, now: DateTime<Utc>) -> ObjectVersion {
    snapshot_with(content, ctx.version_id, ctx.provenance_id, now)
}

/// `snapshot` with an explicitly chosen checkpoint + provenance id — for a TWO-object write
/// (`rehome_subtree`), where the host uses `ctx`'s ids and the new object needs its own.
fn snapshot_with(
    content: &MathContent,
    version_id: ObjectVersionId,
    provenance_id: ProvenanceId,
    now: DateTime<Utc>,
) -> ObjectVersion {
    ObjectVersion {
        id: version_id,
        object_id: content.object_id,
        version_no: content.revision,
        // Serializing our own in-memory type (cf. `api::*Result::to_json`) — never fails.
        snapshot: serde_json::to_value(content).expect("MathContent serializes to JSON"),
        provenance_id,
        created_at: now,
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// Op input DTOs
// ════════════════════════════════════════════════════════════════════════════════

/// `set_unit_type` payload. `unit_type` is a `Patch` (absent = leave, null = clear to plain
/// content, value = set), §6.3 tri-state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct SetUnitTypeInput {
    pub expected_revision: u32,
    pub unit_id: UnitId,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub unit_type: Patch<UnitType>,
}

/// `split_unit` payload — split a prose unit's text at char offset `at` into two siblings.
/// `propagate_taggings` are the source unit's taggings to copy onto the new unit, paired
/// (by index) with the glue-minted `new_tagging_ids`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct SplitUnitInput {
    pub expected_revision: u32,
    pub unit_id: UnitId,
    pub at: u32,
    pub new_unit_id: UnitId,
    pub propagate_taggings: Vec<Tagging>,
    pub new_tagging_ids: Vec<TaggingId>,
}

/// `merge_units` payload — merge two adjacent prose siblings (`second` into `first`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MergeUnitsInput {
    pub expected_revision: u32,
    pub first_unit_id: UnitId,
    pub second_unit_id: UnitId,
}

/// `toggle_expression_placement` payload — the `$$`/`$` gesture. The op infers the direction
/// from the unit: a prose unit holding the inline atom → *promote* to a display `Math` unit,
/// splitting the prose around it (`display_unit_id` = the math unit; `trailing_unit_id` = the
/// after-prose half when non-empty); a standalone `Math` unit → *demote*, folding the atom back
/// into an adjacent prose sibling (the two new ids are unused on demote).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct ToggleExpressionPlacementInput {
    pub expected_revision: u32,
    pub unit_id: UnitId,
    pub expression_id: ExpressionId,
    pub display_unit_id: UnitId,
    pub trailing_unit_id: UnitId,
}

/// `rewrite_surface` payload — a variable rename over an expression's surface. `from`/`to`
/// build a `SurfaceEdit::RenameIdent` internally (the surface edit type stays surface-internal,
/// never on the wire). The op is also given the current edges (an arg, not a field) so it can
/// re-anchor those that point into this expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct RewriteSurfaceInput {
    pub expected_revision: u32,
    pub unit_id: UnitId,
    pub expression_id: ExpressionId,
    pub from: String,
    pub to: String,
}

/// The client-suppliable fields of a `links` row (§6.1b). The op stamps `status`,
/// `provenance_id`, and `created_at`, then runs `validate_link` — so a draft can never set the
/// trust-spine fields or bypass the §6.1a invariants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct LinkDraft {
    pub id: LinkId,
    pub source_object_id: crate::ids::ObjectId,
    pub target_object_id: Option<crate::ids::ObjectId>,
    pub target_unit_id: Option<UnitId>,
    pub unresolved_text: Option<String>,
    pub target_selector: Option<TargetSelector>,
    pub link_type: LinkType,
    pub from_content: bool,
    pub source_unit_id: Option<UnitId>,
    pub content_locator: Option<ContentLocator>,
}

/// `insert_reference` payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct InsertReferenceInput {
    pub expected_revision: u32,
    pub link: LinkDraft,
}

/// Where an occurrence resolves to (`resolve_occurrence`). Slice 1 resolves the `object` arm;
/// `notation` is shape-valid but rejected at runtime (`TargetKindNotAvailableYet`) until the
/// notation registry lands (slice 2). (Contrast `OccurrenceTarget`, which has no notation arm
/// at the SHAPE level — the asymmetry is deliberate: this DTO can REQUEST notation in order to
/// be told "not yet".)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolveTarget {
    Object { object_id: crate::ids::ObjectId },
    Notation { notation_id: String },
}

/// `resolve_occurrence` payload — resolve the `occurrence_index`-th occurrence of an
/// expression and emit the resolved edge (`link_id`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct ResolveOccurrenceInput {
    pub expected_revision: u32,
    pub unit_id: UnitId,
    pub expression_id: ExpressionId,
    pub occurrence_index: u32,
    pub link_id: LinkId,
    pub target: ResolveTarget,
}

/// `materialize_object` payload — the COPY path (deliberate duplication / paste-as-reference,
/// §18.7; not the greedy-capture materialize, which is `rehome_subtree`). The glue pre-mints the new
/// object/provenance/edge ids and TOTAL id remaps over `source_content` (every unit and every
/// expression must have an entry, else `RemapIncomplete` — a partial map would alias ids across
/// objects). Re-mints every id and leaves the source UNTOUCHED.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MaterializeObjectInput {
    pub expected_revision: u32,
    pub source_object: CanonicalObject,
    pub source_content: MathContent,
    pub new_object_id: ObjectId,
    pub new_provenance_id: ProvenanceId,
    pub edge_link_id: LinkId,
    pub expr_id_map: Vec<ExpressionIdRemap>,
    pub unit_id_map: Vec<UnitIdRemap>,
}

/// `rehome_subtree` payload — the REAL greedy-capture materialize (§9.y; the product's binding
/// storage contract, §18.5). MOVES a declared subtree (the root unit + its `parent_unit_id`
/// descendants) OUT of the host into a new object, **PRESERVING every unit and expression id** (the
/// inverse of the copy path's re-mint) so backlinks/handles/anchors keep resolving, and leaves one
/// `Embed{target: Object}` in the host where the root was. The glue pre-mints the new object id, the
/// embed unit id, and the new object's version-checkpoint id (the host's checkpoint is
/// `ctx.version_id`). No id remap. `expected_revision` rides only for the glue's host gate (§6.4 —
/// the core never reads it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct RehomeSubtreeInput {
    pub expected_revision: u32,
    pub host_object: CanonicalObject,
    pub host_content: MathContent,
    /// The declared unit to materialize; it and its descendants move into the new object.
    pub subtree_root: UnitId,
    pub new_object_id: ObjectId,
    /// The materialized object's type (e.g. `theorem`) — must be producible (§13a/§6.1a).
    #[serde(rename = "type")]
    pub new_object_type: ObjectType,
    /// The `Embed{target: Object}` unit minted to stand where the subtree was in the host.
    pub embed_unit_id: UnitId,
    /// The new object's history-checkpoint id (the host's is `ctx.version_id`).
    pub new_version_id: ObjectVersionId,
}

/// `dissolve_object` payload — the inverse of `rehome_subtree` (§9.y reversibility). Folds an
/// embedded object's content back into its host (ids preserved), removing the embed and the object.
/// `inbound_references` is the glue-loaded list of edges/handles depending on the object's identity
/// (the core counts nothing — it stays pure of the reference query, §6.1b); a NON-EMPTY list makes
/// dissolution a reviewable refusal (`DissolutionBlocked`), never a silent move (§9.y).
///
/// A destructive write carries TWO concurrency gates (unlike the creative `rehome_subtree`, which
/// mints a fresh object and needs only the host gate): `expected_revision` gates the HOST and
/// `expected_dissolved_revision` gates the object being DESTROYED, so a concurrent edit to either
/// between load and dissolve loses the race (409) rather than being silently dropped (§6.4). Both
/// ride for the glue's conditional writes; the core reads neither.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct DissolveObjectInput {
    pub expected_revision: u32,
    /// The expected revision of the object being DESTROYED — the second gate (§6.4).
    pub expected_dissolved_revision: u32,
    pub host_content: MathContent,
    /// The `Embed{target: Object{dissolved_object_id}}` unit in the host to replace.
    pub embed_unit_id: UnitId,
    pub dissolved_object_id: ObjectId,
    pub dissolved_content: MathContent,
    /// Ids of inbound references the glue found (edges/handles). Non-empty → reviewable refusal.
    pub inbound_references: Vec<String>,
}

// ════════════════════════════════════════════════════════════════════════════════
// Operations
// ════════════════════════════════════════════════════════════════════════════════

/// Set (or clear) a unit's `type` (§6.0). No type↔content-kind admissibility is checked
/// (that coupling is deferred). The coupled `example_kind` is cleared when the type is no
/// longer `example`, so the unit can't violate `ExampleKindWithoutExampleType` (§6.0b).
pub fn set_unit_type(
    mut content: MathContent,
    input: &SetUnitTypeInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    let unit = find_unit_mut(&mut content, input.unit_id)?;
    unit.unit_type = input.unit_type.apply_to(unit.unit_type);
    if unit.unit_type != Some(UnitType::Example) {
        unit.example_kind = None;
    }
    content.revision = content.revision.saturating_add(1);
    Ok(OpOutcome::new(content, ctx, now))
}

/// Split a prose unit at char offset `at` into two siblings; expression ids are preserved.
/// Inline atoms are partitioned by position; a `Mark` region straddling `at` is SPLIT (lossless,
/// via `split_prose_at`). The new unit inherits type/example_kind/status/declared_by/provenance.
pub fn split_unit(
    mut content: MathContent,
    input: &SplitUnitInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    if input.propagate_taggings.len() != input.new_tagging_ids.len() {
        return Err(ValidationError::IdCountMismatch {
            expected: input.propagate_taggings.len() as u32,
            given: input.new_tagging_ids.len() as u32,
        });
    }
    let idx = unit_index(&content, input.unit_id)?;
    validate_unit_inline(&content.units[idx])?;
    let (text, inline) = match &content.units[idx].content {
        UnitContent::Prose { text, inline } => (text.clone(), inline.clone()),
        other => {
            return Err(ValidationError::UnsplittableContentKind {
                kind: content_kind_tag(other).into(),
            });
        }
    };
    let nchars = text.chars().count() as u32;
    if input.at > nchars {
        return Err(ValidationError::SplitOffsetOutOfRange {
            given: input.at,
            len: nchars,
        });
    }
    let (left_text, left_inline, right_text, right_inline) =
        split_prose_at(&text, inline, input.at);

    let base = &content.units[idx];
    let parent = base.parent_unit_id;
    let position = base.position;
    let second = Unit {
        id: input.new_unit_id,
        object_id: base.object_id,
        parent_unit_id: parent,
        // Same position as the source half; `renumber_siblings` orders the two by vector order.
        position,
        slot: base.slot.clone(),
        unit_type: base.unit_type,
        example_kind: base.example_kind,
        status: base.status,
        declared_by: base.declared_by,
        // Candidate decompositions are declared-unwritten in slice 1 (§6.0); never propagated.
        extracted_structure: None,
        content: UnitContent::Prose {
            text: right_text,
            inline: right_inline,
        },
        provenance_id: base.provenance_id,
    };

    if let UnitContent::Prose { text, inline } = &mut content.units[idx].content {
        *text = left_text;
        *inline = left_inline;
    }
    content.units.insert(idx + 1, second);
    renumber_siblings(&mut content, parent);

    let mut taggings_propagated = Vec::new();
    for (t, new_id) in input
        .propagate_taggings
        .iter()
        .zip(input.new_tagging_ids.iter())
    {
        let copy = Tagging {
            id: *new_id,
            tag_id: t.tag_id,
            tagged_object_id: None,
            tagged_unit_id: Some(input.new_unit_id),
            created_at: now,
        };
        validate_tagging(&copy)?;
        taggings_propagated.push(copy);
    }

    content.revision = content.revision.saturating_add(1);
    let mut outcome = OpOutcome::new(content, ctx, now);
    outcome.taggings_propagated = taggings_propagated;
    Ok(outcome)
}

/// Merge two adjacent prose siblings (`second` into `first`); expression ids preserved.
/// `second`'s text/inline append to `first` (via `join_prose`); `second`'s taggings (from
/// `current_taggings`) re-point to `first`, deduped against tags `first` already carries.
pub fn merge_units(
    mut content: MathContent,
    current_taggings: &[Tagging],
    input: &MergeUnitsInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    let first_idx = unit_index(&content, input.first_unit_id)?;
    let second_idx = unit_index(&content, input.second_unit_id)?;
    {
        let a = &content.units[first_idx];
        let b = &content.units[second_idx];
        if a.parent_unit_id != b.parent_unit_id || a.object_id != b.object_id {
            return Err(ValidationError::UnmergeableUnits {
                reason: "units are not siblings".into(),
            });
        }
        if b.position != a.position + 1 {
            return Err(ValidationError::UnmergeableUnits {
                reason: "units are not adjacent".into(),
            });
        }
        if !matches!(a.content, UnitContent::Prose { .. })
            || !matches!(b.content, UnitContent::Prose { .. })
        {
            return Err(ValidationError::UnmergeableUnits {
                reason: "only prose units can be merged".into(),
            });
        }
    }
    validate_unit_inline(&content.units[first_idx])?;
    validate_unit_inline(&content.units[second_idx])?;

    let (second_text, second_inline) = match &content.units[second_idx].content {
        UnitContent::Prose { text, inline } => (text.clone(), inline.clone()),
        _ => {
            return Err(ValidationError::UnmergeableUnits {
                reason: "only prose units can be merged".into(),
            });
        }
    };
    let parent = content.units[second_idx].parent_unit_id;

    if let UnitContent::Prose { text, inline } = &mut content.units[first_idx].content {
        let cur_text = std::mem::take(text);
        let cur_inline = std::mem::take(inline);
        let (joined_text, joined_inline) =
            join_prose(cur_text, cur_inline, &second_text, second_inline);
        *text = joined_text;
        *inline = joined_inline;
    }
    content.units.remove(second_idx);
    renumber_siblings(&mut content, parent);

    let first_tags: std::collections::HashSet<TagId> = current_taggings
        .iter()
        .filter(|t| t.tagged_unit_id == Some(input.first_unit_id))
        .map(|t| t.tag_id)
        .collect();
    let mut taggings_propagated = Vec::new();
    for t in current_taggings
        .iter()
        .filter(|t| t.tagged_unit_id == Some(input.second_unit_id))
    {
        if first_tags.contains(&t.tag_id) {
            continue; // first already carries this tag — no duplicate (tag, unit)
        }
        let mut moved = t.clone();
        moved.tagged_unit_id = Some(input.first_unit_id);
        validate_tagging(&moved)?;
        taggings_propagated.push(moved);
    }

    content.revision = content.revision.saturating_add(1);
    let mut outcome = OpOutcome::new(content, ctx, now);
    outcome.taggings_propagated = taggings_propagated;
    Ok(outcome)
}

/// Toggle an expression between inline (an `Inline::Math` atom in a prose unit) and display (a
/// standalone `Math` unit) — the `$$`/`$` gesture. *Promote* (`displayize`) splits the prose at
/// the atom and inserts a display unit between the halves; *demote* (`inlineize`) joins the
/// flanking prose and reinserts the atom. The same `MathExpression` MOVES by value (id +
/// occurrence selector spans preserved; empty remap).
pub fn toggle_expression_placement(
    mut content: MathContent,
    input: &ToggleExpressionPlacementInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    let idx = unit_index(&content, input.unit_id)?;
    let is_display = matches!(
        &content.units[idx].content,
        UnitContent::Math { expr } if expr.id == input.expression_id
    );
    if is_display {
        inlineize(&mut content, idx, input.expression_id)?;
    } else {
        validate_unit_inline(&content.units[idx])?; // enforce zero-width atoms before promoting
        let parent = content.units[idx].parent_unit_id;
        let src = content.units.remove(idx);
        let new_units = displayize(
            src,
            input.expression_id,
            input.display_unit_id,
            input.trailing_unit_id,
        )?;
        for (off, u) in new_units.into_iter().enumerate() {
            content.units.insert(idx + off, u);
        }
        renumber_siblings(&mut content, parent);
    }
    content.revision = content.revision.saturating_add(1);
    Ok(OpOutcome::new(content, ctx, now))
}

/// Rewrite an expression's surface via a variable rename, re-anchoring edges that point into
/// it. Preserves `id` + `original_input`; updates `surface_text` + `parse_status`. Occurrence
/// selectors and inbound edge anchors are remapped via `rewrite_with_remap`: a structure-
/// preserving rename carries them through; a reshaping rename drops a vanished occurrence site
/// and stales its edge (→ `links_staled`), never wrong (§6.1b). The enclosing prose `text`/spans
/// are untouched — an inline-math atom is zero-width, so the prose char sequence is unaffected.
///
/// **Occurrence-selector contract (slice 1):** occurrence selectors are ident-site spans produced
/// by the serializer, so a `None` remap can only mean the site genuinely vanished (a reshaping
/// rename) — dropping it is correct. **Revisit when slice 2 introduces coarse selectors** (numbers,
/// `frac(a,b)`, sub-symbol resolution): those can fail to remap for non-structural reasons and would
/// need stale-not-drop (occurrences have no stale marker today — a model addition).
pub fn rewrite_surface(
    mut content: MathContent,
    current_links: &[Link],
    input: &RewriteSurfaceInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    // Inbound edges anchored into this expression (by their ExpressionSpan locator). Keep the
    // whole `&Link` so re-anchored rows can be rebuilt without a fallible re-lookup.
    let anchors: Vec<(&Link, CharSpan)> = current_links
        .iter()
        .filter_map(|l| match &l.content_locator {
            Some(ContentLocator::ExpressionSpan {
                expression_id,
                start,
                end,
            }) if *expression_id == input.expression_id => Some((l, CharSpan::new(*start, *end))),
            _ => None,
        })
        .collect();

    let uidx = unit_index(&content, input.unit_id)?;
    validate_unit_inline(&content.units[uidx])?;
    let expr = find_expr_in_unit_mut(&mut content.units[uidx], input.expression_id)?;

    let old_surface = expr.surface_text.clone();
    let occ_count = expr.occurrences.len();
    // Spans fed to the remap: the expression's own occurrence selectors first, then the
    // inbound edge anchors. The output `remapped` is parallel and split at `occ_count`.
    let mut spans: Vec<CharSpan> = expr.occurrences.iter().map(|o| o.selector).collect();
    spans.extend(anchors.iter().map(|(_, s)| *s));

    let edit = SurfaceEdit::RenameIdent {
        from: input.from.clone(),
        to: input.to.clone(),
    };
    let out = rewrite_with_remap(&old_surface, &edit, &spans);

    // Apply to the expression. `id` + `original_input` are NEVER touched.
    expr.surface_text = out.new_text.clone();
    expr.parse_status = out.parse_status;
    let mut new_occ = Vec::with_capacity(occ_count);
    for (i, occ) in expr.occurrences.drain(..).enumerate() {
        if let Some(selector) = out.remapped[i] {
            new_occ.push(Occurrence {
                selector,
                target: occ.target,
            });
        }
        // else: drop. Selectors are ident-site spans (serializer-produced), so a `None` here means
        // the site genuinely vanished (a reshaping rename); the matching edge (same span) stales
        // below. Coarse selectors (slice 2) would need stale-not-drop — see the fn doc.
    }
    expr.occurrences = new_occ;

    // Re-anchor (→ upserted) or stale (→ links_staled, id only) the inbound edges.
    let mut links_upserted = Vec::new();
    let mut links_staled = Vec::new();
    for (j, (orig, _)) in anchors.iter().enumerate() {
        match out.remapped[occ_count + j] {
            Some(span) => {
                let mut l = (*orig).clone();
                l.content_locator = Some(ContentLocator::ExpressionSpan {
                    expression_id: input.expression_id,
                    start: span.start,
                    end: span.end,
                });
                links_upserted.push(l);
            }
            None => links_staled.push(orig.id),
        }
    }

    content.revision = content.revision.saturating_add(1);
    let mut outcome = OpOutcome::new(content, ctx, now);
    outcome.links_upserted = links_upserted;
    outcome.links_staled = links_staled;
    Ok(outcome)
}

/// Insert a reference edge (§6.1b). The draft's §6.1a invariants are enforced by `validate_link`
/// after the trust-spine fields are stamped.
pub fn insert_reference(
    mut content: MathContent,
    input: &InsertReferenceInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    let d = &input.link;
    let link = Link {
        id: d.id,
        source_object_id: d.source_object_id,
        target_object_id: d.target_object_id,
        target_unit_id: d.target_unit_id,
        unresolved_text: d.unresolved_text.clone(),
        target_selector: d.target_selector.clone(),
        link_type: d.link_type,
        status: LinkStatus::Active,
        from_content: d.from_content,
        source_unit_id: d.source_unit_id,
        content_locator: d.content_locator.clone(),
        provenance_id: ctx.provenance_id,
        created_at: now,
    };
    validate_link(&link)?;
    content.revision = content.revision.saturating_add(1);
    let mut outcome = OpOutcome::new(content, ctx, now);
    outcome.links_upserted.push(link);
    Ok(outcome)
}

/// Resolve an expression occurrence to an object and emit the resolved edge (§6.1b/§6.3a).
/// The `notation` arm is rejected until the registry lands (slice 2); an already-resolved
/// occurrence is rejected (no silent overwrite + double emit).
pub fn resolve_occurrence(
    mut content: MathContent,
    input: &ResolveOccurrenceInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    let object_id = match &input.target {
        ResolveTarget::Object { object_id } => *object_id,
        ResolveTarget::Notation { .. } => {
            return Err(ValidationError::TargetKindNotAvailableYet {
                kind: "notation".into(),
            });
        }
    };
    let source_object_id = content.object_id;

    let unit = find_unit_mut(&mut content, input.unit_id)?;
    let expr = find_expr_in_unit_mut(unit, input.expression_id)?;
    let len = expr.occurrences.len() as u32;
    let occ = expr
        .occurrences
        .get_mut(input.occurrence_index as usize)
        .ok_or(ValidationError::OccurrenceOutOfRange {
            given: input.occurrence_index,
            len,
        })?;
    if occ.target.is_some() {
        return Err(ValidationError::OccurrenceAlreadyResolved);
    }
    occ.target = Some(OccurrenceTarget::Object { object_id });
    let selector = occ.selector;

    // The occurrence-derived edge: content-derived, resolved to the object. `related` is the
    // slice-1 type for occurrence references (richer typing is reserved, §14).
    let link = Link {
        id: input.link_id,
        source_object_id,
        target_object_id: Some(object_id),
        target_unit_id: None,
        unresolved_text: None,
        target_selector: None,
        link_type: LinkType::Related,
        status: LinkStatus::Active,
        from_content: true,
        source_unit_id: Some(input.unit_id),
        content_locator: Some(ContentLocator::ExpressionSpan {
            expression_id: input.expression_id,
            start: selector.start,
            end: selector.end,
        }),
        provenance_id: ctx.provenance_id,
        created_at: now,
    };
    validate_link(&link)?;

    content.revision = content.revision.saturating_add(1);
    let mut outcome = OpOutcome::new(content, ctx, now);
    outcome.links_upserted.push(link);
    Ok(outcome)
}

/// Copy an object's content into a NEW object, with a `DerivedFrom` edge back to the origin — the
/// **copy path** (deliberate duplication / paste-as-reference, §18.7; *not* the greedy-capture
/// materialize, which is `rehome_subtree` and PRESERVES ids). EVERY copied expression id is
/// re-minted (`expr_id_map`) and every unit re-homed (`unit_id_map`); a partial map is a hard error
/// (`RemapIncomplete`) and a duplicate source id is `DuplicateSourceId` — both would alias ids
/// across objects (§6.3a). The new object copies the source's metadata (incl. `extra`, §2.2) with
/// fresh identity; the SOURCE IS UNTOUCHED; taggings are NOT propagated (a copy starts untagged).
pub fn materialize_object(
    input: &MaterializeObjectInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    use std::collections::HashMap;

    // A duplicate source id would collapse onto one fresh id via the maps — reject up front.
    let src_expr_ids = expr_ids_of(&input.source_content);
    if has_duplicate(&src_expr_ids) {
        return Err(ValidationError::DuplicateSourceId {
            kind: "expression".into(),
        });
    }
    let src_unit_ids: Vec<UnitId> = input.source_content.units.iter().map(|u| u.id).collect();
    if has_duplicate(&src_unit_ids) {
        return Err(ValidationError::DuplicateSourceId {
            kind: "unit".into(),
        });
    }

    let expr_map: HashMap<ExpressionId, ExpressionId> =
        input.expr_id_map.iter().map(|m| (m.from, m.to)).collect();
    let unit_map: HashMap<UnitId, UnitId> =
        input.unit_id_map.iter().map(|m| (m.from, m.to)).collect();

    let mut new_units = Vec::with_capacity(input.source_content.units.len());
    for u in &input.source_content.units {
        let new_id = *unit_map
            .get(&u.id)
            .ok_or(ValidationError::RemapIncomplete {
                kind: "unit".into(),
            })?;
        let new_parent = match u.parent_unit_id {
            Some(p) => Some(*unit_map.get(&p).ok_or(ValidationError::RemapIncomplete {
                kind: "unit".into(),
            })?),
            None => None,
        };
        let mut copied = u.content.clone();
        remint_exprs(&mut copied, &expr_map)?;
        new_units.push(Unit {
            id: new_id,
            object_id: input.new_object_id,
            parent_unit_id: new_parent,
            position: u.position,
            slot: u.slot.clone(),
            unit_type: u.unit_type,
            example_kind: u.example_kind,
            status: u.status,
            declared_by: u.declared_by,
            extracted_structure: u.extracted_structure.clone(),
            content: copied,
            provenance_id: input.new_provenance_id,
        });
    }
    let new_content = MathContent {
        object_id: input.new_object_id,
        revision: 1,
        units: new_units,
    };

    let src = &input.source_object;
    let new_object = CanonicalObject {
        id: input.new_object_id,
        object_type: src.object_type,
        title: src.title.clone(),
        raw_source: src.raw_source.clone(),
        status: ObjectStatus::Draft,
        schema_version: crate::CURRENT_SCHEMA_VERSION,
        revision: 1,
        provenance_id: input.new_provenance_id,
        space_id: src.space_id,
        created_at: now,
        updated_at: now,
        extra: src.extra.clone(), // §2.2 — unknown fields survive the copy
    };

    let edge = Link {
        id: input.edge_link_id,
        source_object_id: input.new_object_id,
        target_object_id: Some(src.id),
        target_unit_id: None,
        unresolved_text: None,
        target_selector: None,
        link_type: LinkType::DerivedFrom,
        status: LinkStatus::Active,
        from_content: false,
        source_unit_id: None,
        content_locator: None,
        provenance_id: ctx.provenance_id,
        created_at: now,
    };
    validate_link(&edge)?;

    // The applied remap = every source expression's id mapped (the map is total, checked above).
    let applied_remap: Vec<ExpressionIdRemap> = src_expr_ids
        .into_iter()
        .map(|from| ExpressionIdRemap {
            from,
            to: expr_map[&from],
        })
        .collect();

    let version_snapshot = snapshot(&new_content, ctx, now);
    Ok(OpOutcome {
        content: new_content,
        links_upserted: vec![edge],
        links_staled: Vec::new(),
        expression_id_remap: applied_remap,
        version_snapshot,
        new_objects: vec![new_object],
        // Deliberately empty: a copy starts UNTAGGED (tags are personal organization of the
        // original; re-home, by contrast, carries them — a moved unit keeps its taggings via its
        // preserved id). A product choice, not the unknown-field omission flagged for `extra`.
        taggings_propagated: Vec::new(),
        host_content: None, // single-object write (the source is untouched)
        host_version_snapshot: None,
        objects_removed: Vec::new(),
    })
}

/// Materialize a declared subtree into a new object by RE-HOMING it — the §9.y greedy-capture
/// materialize and the product's binding storage contract (§18.5). Unlike the copy path
/// (`materialize_object`), this MOVES the units: ids are PRESERVED (not re-minted), so every
/// backlink / handle / anchor into the subtree keeps resolving, and the new object then OWNS that
/// content and its own version history (one fact, one home, §18.10). The host keeps showing the
/// material through one `Embed{target: Object}` left where the subtree's root was — the object's
/// "appearance" (§18.18). A TWO-object outcome: `content`/`new_objects`/`version_snapshot` describe
/// the new object; `host_content`/`host_version_snapshot` describe the mutated host.
///
/// What this op does NOT do (left to the glue, since they are relational, §6.1a): re-point the
/// COMPOSITE-FK rows that anchor into the moved subtree. Both ENDS of a `links` edge are composite
/// FKs `(unit_id, object_id)`, so the glue must re-home, for every moved unit:
///   • **target-side** — a `links.target_unit_id`/`target_object_id` pointing INTO the subtree, and a
///     `handles.target_object_id` for a unit-anchored OR expression-anchored handle on a moved unit;
///   • **source-side** — a `links.source_unit_id`/`source_object_id` whose source IS a moved unit:
///     content-derived edges (`from_content = true`, minted by `resolve_occurrence` with
///     `source_object_id = host`) move their source end to the new object too.
/// Unit-level `taggings` need NO re-point (their FK is on `tagged_unit_id` alone, so they ride the
/// preserved ids — tag survival is a free property of re-homing). The op leaves `content`
/// (expression ids, occurrence selectors, the locators those edges reference) byte-identical, so the
/// glue's re-point is a pure home-rewrite. All in the one move transaction.
pub fn rehome_subtree(
    input: &RehomeSubtreeInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    // The materialized object must be a producible type — the formal family, never the reserved
    // surface/source/annotation types whose detail machinery hasn't landed (§13a/§6.1a).
    if !input.new_object_type.is_producible() {
        return Err(ValidationError::TypeNotProducibleYet {
            object_type: input.new_object_type,
        });
    }

    let mut host = input.host_content.clone();
    // The subtree = the root unit + every transitive `parent_unit_id` descendant.
    let moving = subtree_closure(&host, input.subtree_root)?;

    // The root's slot in the host: the embed takes its exact place (same parent, position, AND slot —
    // a subtree declared inside a `case_split`/proof body keeps its container-internal role).
    let (root_parent, root_position, root_slot) = {
        let root = host
            .units
            .iter()
            .find(|u| u.id == input.subtree_root)
            .expect("subtree_closure verified the root exists");
        (root.parent_unit_id, root.position, root.slot.clone())
    };

    // Partition: the moved units leave the host and re-home onto the new object (ids preserved).
    let mut moved: Vec<Unit> = Vec::new();
    let mut remaining: Vec<Unit> = Vec::new();
    for u in host.units.drain(..) {
        if moving.contains(&u.id) {
            moved.push(u);
        } else {
            remaining.push(u);
        }
    }
    for u in &mut moved {
        u.object_id = input.new_object_id;
        if u.id == input.subtree_root {
            u.parent_unit_id = None; // the root becomes a top-level unit of the new object
        }
    }

    // The host keeps the rest plus one embed standing where the subtree's root was.
    let embed = Unit {
        id: input.embed_unit_id,
        object_id: host.object_id,
        parent_unit_id: root_parent,
        position: root_position,
        slot: root_slot,
        unit_type: None,
        example_kind: None,
        status: UnitStatus::Parsed,
        // The embed is a STRUCTURAL consequence of the user's type declaration, not a typed unit
        // the user authored — `deterministic`, never a `type` (§9.y; `ai` is forbidden anyway).
        declared_by: DeclaredBy::Deterministic,
        extracted_structure: None,
        content: UnitContent::Embed {
            target: EmbedTarget::Object {
                object_id: input.new_object_id,
            },
        },
        provenance_id: ctx.provenance_id,
    };
    remaining.push(embed);
    host.units = remaining;
    host.revision = host.revision.saturating_add(1);
    renumber_siblings(&mut host, root_parent);

    // The new object owns the moved subtree; the former-root layer rebases to a gap-free 0..n.
    let mut new_content = MathContent {
        object_id: input.new_object_id,
        revision: 1,
        units: moved,
    };
    renumber_siblings(&mut new_content, None);

    let new_object = CanonicalObject {
        id: input.new_object_id,
        object_type: input.new_object_type,
        title: None, // a materialized theorem has no title; its label is numbering/aliases (§6.3b)
        raw_source: None,
        status: ObjectStatus::Draft,
        schema_version: crate::CURRENT_SCHEMA_VERSION,
        revision: 1,
        provenance_id: ctx.provenance_id,
        space_id: input.host_object.space_id,
        created_at: now,
        updated_at: now,
        extra: serde_json::Map::new(),
    };

    let new_version = snapshot_with(&new_content, input.new_version_id, ctx.provenance_id, now);
    let host_version = snapshot(&host, ctx, now);

    Ok(OpOutcome {
        content: new_content,
        links_upserted: Vec::new(), // the embed IS the connection — no DerivedFrom edge (cf. copy)
        links_staled: Vec::new(),
        expression_id_remap: Vec::new(), // ids PRESERVED — the inverse of the copy path's re-mint
        version_snapshot: new_version,
        new_objects: vec![new_object],
        taggings_propagated: Vec::new(), // unit taggings ride preserved ids; glue re-points handles/links
        host_content: Some(host),
        host_version_snapshot: Some(host_version),
        objects_removed: Vec::new(),
    })
}

/// Dissolve a materialized object back into its host — the inverse of `rehome_subtree` (§9.y
/// reversibility / the backspace-past-empty gesture). Folds the object's content back into the host
/// where its `Embed` sat (ids PRESERVED), removes the embed, and reports the object as removed. If
/// inbound references depend on the object's identity (`inbound_references` non-empty — the glue
/// loaded them, the core stays pure of the query), dissolution is a REVIEWABLE REFUSAL
/// (`DissolutionBlocked`), never a silent content move (§9.y:1118). The host is the surviving object
/// (`content`); `objects_removed` names the object that disappears.
pub fn dissolve_object(
    input: &DissolveObjectInput,
    ctx: &OpContext,
    now: DateTime<Utc>,
) -> Result<OpOutcome, ValidationError> {
    // Inbound references make this a reviewable operation, not a silent dissolve (§9.y).
    if !input.inbound_references.is_empty() {
        return Err(ValidationError::DissolutionBlocked {
            references: input.inbound_references.clone(),
        });
    }

    // Destructive: never trust `dissolved_content` (mirrors the copy path's `DuplicateSourceId`).
    // The content must belong to the object being dissolved, else the glue would fold a FOREIGN
    // object's units into the host.
    if input.dissolved_content.object_id != input.dissolved_object_id {
        return Err(ValidationError::DissolveInputInconsistent {
            reason: format!(
                "dissolved_content.object_id {} != dissolved_object_id {}",
                input.dissolved_content.object_id, input.dissolved_object_id
            ),
        });
    }

    let mut host = input.host_content.clone();

    // The embed marks where the object's content folds back in (its parent + position).
    let embed_idx = host
        .units
        .iter()
        .position(|u| u.id == input.embed_unit_id)
        .ok_or(ValidationError::UnitNotFound {
            unit_id: input.embed_unit_id.to_string(),
        })?;
    // It must be an embed OF the object we are dissolving — a present-but-wrong embed is a glue
    // precondition bug (distinct from a genuinely absent embed, which is `UnitNotFound` above).
    match &host.units[embed_idx].content {
        UnitContent::Embed {
            target: EmbedTarget::Object { object_id },
        } if *object_id == input.dissolved_object_id => {}
        _ => {
            return Err(ValidationError::DissolveInputInconsistent {
                reason: format!(
                    "unit {} is not an embed of object {}",
                    input.embed_unit_id, input.dissolved_object_id
                ),
            });
        }
    }

    // Id-collision guard: a folded unit must not already live in the host (one home, §6.0b) — the
    // destructive mirror of materialize's duplicate-source guard.
    let host_ids: std::collections::HashSet<UnitId> = host.units.iter().map(|u| u.id).collect();
    for u in &input.dissolved_content.units {
        if u.id != input.embed_unit_id && host_ids.contains(&u.id) {
            return Err(ValidationError::UnitInMultipleObjects {
                unit_id: u.id.to_string(),
            });
        }
    }

    let embed = host.units.remove(embed_idx);
    let fold_parent = embed.parent_unit_id;

    // Fold the object's units back into the host at the embed's slot (ids preserved). The former
    // top-level units re-attach under the embed's parent; deeper units keep their intra-object
    // parents (preserved ids, now living in the host). object_id flips back to the host.
    for mut u in input.dissolved_content.units.iter().cloned() {
        if u.parent_unit_id.is_none() {
            u.parent_unit_id = fold_parent;
            u.position = embed.position; // ties broken by vector order, then renumbered below
        }
        u.object_id = host.object_id;
        host.units.push(u);
    }
    host.revision = host.revision.saturating_add(1);
    renumber_siblings(&mut host, fold_parent);

    let mut outcome = OpOutcome::new(host, ctx, now);
    outcome.objects_removed = vec![input.dissolved_object_id];
    Ok(outcome)
}

// ════════════════════════════════════════════════════════════════════════════════
// Shared prose transforms (split/merge AND toggle route through these — single source)
// ════════════════════════════════════════════════════════════════════════════════

/// Split a prose `(text, inline)` at char offset `at` into `(left_text, left_inline, right_text,
/// right_inline)`. A `Mark` region straddling `at` is SPLIT into `Mark[s, at)` + `Mark[0, e-at)`
/// (lossless); atoms (zero-width `Math`/`Reference`) go wholly to the side their position falls
/// on. Right-side spans rebase to start at 0. `at` is assumed ≤ `char-len(text)` (caller checks).
fn split_prose_at(
    text: &str,
    inline: Vec<Inline>,
    at: u32,
) -> (String, Vec<Inline>, String, Vec<Inline>) {
    let split_b = char_to_byte(text, at);
    let left_text = text[..split_b].to_string();
    let right_text = text[split_b..].to_string();
    let mut left = Vec::new();
    let mut right = Vec::new();
    for el in inline {
        match el {
            Inline::Mark { span, style } => {
                let (s, e) = (span.start, span.end);
                if e <= at {
                    left.push(Inline::Mark { span, style });
                } else if s >= at {
                    right.push(Inline::Mark {
                        span: CharSpan::new(s - at, e - at),
                        style,
                    });
                } else {
                    left.push(Inline::Mark {
                        span: CharSpan::new(s, at),
                        style: style.clone(),
                    });
                    right.push(Inline::Mark {
                        span: CharSpan::new(0, e - at),
                        style,
                    });
                }
            }
            // Atoms (Math/Reference) are zero-width; they fall wholly to one side.
            atom => {
                if inline_span(&atom).start < at {
                    left.push(atom);
                } else {
                    right.push(shift_inline_back(atom, at));
                }
            }
        }
    }
    (left_text, left, right_text, right)
}

/// Concatenate two prose halves (inverse of `split_prose_at` at the join): `b`'s text appends to
/// `a`'s and `b`'s inline spans rebase by `char-len(a_text)`.
fn join_prose(
    a_text: String,
    a_inline: Vec<Inline>,
    b_text: &str,
    b_inline: Vec<Inline>,
) -> (String, Vec<Inline>) {
    let off = a_text.chars().count() as u32;
    let mut text = a_text;
    text.push_str(b_text);
    let mut inline = a_inline;
    for el in b_inline {
        inline.push(shift_inline_forward(el, off));
    }
    (text, inline)
}

/// Promote core (toggle inline→display; the slice-2 editor `$$` path reuses this): remove the
/// inline `expression_id` atom from prose unit `src`, split the surrounding prose at the atom's
/// position, and return `[before?, display-Math, after?]` in reading order (eliding empty prose
/// halves). The first surviving prose half keeps `src.id`; the math is `display_unit_id`; a
/// second prose half is `trailing_unit_id`. Positions are all set to `src`'s; the caller
/// `renumber_siblings` orders them. The expression moves by value (id preserved).
fn displayize(
    src: Unit,
    expression_id: ExpressionId,
    display_unit_id: UnitId,
    trailing_unit_id: UnitId,
) -> Result<Vec<Unit>, ValidationError> {
    let not_found = || ValidationError::ExpressionNotFound {
        expression_id: expression_id.to_string(),
    };
    let base_position = src.position;
    let src_id = src.id;
    let object_id = src.object_id;
    let parent = src.parent_unit_id;
    let slot = src.slot.clone();
    let unit_type = src.unit_type;
    let example_kind = src.example_kind;
    let status = src.status;
    let declared_by = src.declared_by;
    let provenance_id = src.provenance_id;

    let UnitContent::Prose { text, mut inline } = src.content else {
        return Err(not_found());
    };
    let pos = inline
        .iter()
        .position(|el| matches!(el, Inline::Math { expr, .. } if expr.id == expression_id))
        .ok_or_else(not_found)?;
    // The atom's (zero-width) position is the split point; remove it and host it in the display unit.
    let (p, expr) = match inline.remove(pos) {
        Inline::Math { span, expr } => (span.start, expr),
        _ => return Err(not_found()), // defensive: `pos` matched Inline::Math above
    };
    let (left_text, left_inline, right_text, right_inline) = split_prose_at(&text, inline, p);
    let before_ne = !left_text.is_empty() || !left_inline.is_empty();
    let after_ne = !right_text.is_empty() || !right_inline.is_empty();

    let make_prose = |id: UnitId, t: String, els: Vec<Inline>| Unit {
        id,
        object_id,
        parent_unit_id: parent,
        position: base_position, // renumber_siblings (caller) assigns the gap-free order
        slot: slot.clone(),
        unit_type,
        example_kind,
        status,
        declared_by,
        extracted_structure: None,
        content: UnitContent::Prose {
            text: t,
            inline: els,
        },
        provenance_id,
    };
    let math_unit = Unit {
        id: display_unit_id,
        object_id,
        parent_unit_id: parent,
        position: base_position,
        slot: None,
        unit_type: None,
        example_kind: None,
        status,
        declared_by,
        extracted_structure: None,
        content: UnitContent::Math { expr },
        provenance_id,
    };

    // Id assignment: the first surviving prose half keeps `src_id`; a second half is
    // `trailing_unit_id`. (`src_id` is dropped only in the degenerate both-empty case.)
    let mut out = Vec::new();
    if before_ne {
        out.push(make_prose(src_id, left_text, left_inline));
        out.push(math_unit);
        if after_ne {
            out.push(make_prose(trailing_unit_id, right_text, right_inline));
        }
    } else {
        out.push(math_unit);
        if after_ne {
            out.push(make_prose(src_id, right_text, right_inline));
        }
    }
    Ok(out)
}

/// Demote core (toggle display→inline): fold the display `Math` unit at `math_idx` back into an
/// adjacent prose sibling as a zero-width atom, joining the two flanking prose halves when both
/// exist (safe-merge: same parent, immediate neighbors). Reuses `join_prose`.
fn inlineize(
    content: &mut MathContent,
    math_idx: usize,
    expression_id: ExpressionId,
) -> Result<(), ValidationError> {
    let expr = match &content.units[math_idx].content {
        UnitContent::Math { expr } if expr.id == expression_id => expr.clone(),
        _ => {
            return Err(ValidationError::ExpressionNotFound {
                expression_id: expression_id.to_string(),
            });
        }
    };
    let parent = content.units[math_idx].parent_unit_id;
    let mpos = content.units[math_idx].position;
    let prose_sibling_at = |content: &MathContent, want: u32| {
        content.units.iter().position(|u| {
            u.parent_unit_id == parent
                && u.position == want
                && matches!(u.content, UnitContent::Prose { .. })
        })
    };
    let before_idx = mpos
        .checked_sub(1)
        .and_then(|p| prose_sibling_at(content, p));
    let after_idx = prose_sibling_at(content, mpos + 1);

    match before_idx {
        Some(bi) => {
            // Absorb the `after` half (if any) into `before`, with the atom at the join.
            let after_taken = after_idx.and_then(|ai| match &content.units[ai].content {
                UnitContent::Prose { text, inline } => Some((text.clone(), inline.clone())),
                _ => None,
            });
            if let UnitContent::Prose { text, inline } = &mut content.units[bi].content {
                let p = text.chars().count() as u32;
                inline.push(Inline::Math {
                    span: CharSpan::new(p, p),
                    expr,
                });
                if let Some((at_text, at_inline)) = after_taken {
                    let cur_text = std::mem::take(text);
                    let cur_inline = std::mem::take(inline);
                    let (jt, ji) = join_prose(cur_text, cur_inline, &at_text, at_inline);
                    *text = jt;
                    *inline = ji;
                }
            }
            let mut to_remove = vec![math_idx];
            if let Some(ai) = after_idx {
                to_remove.push(ai);
            }
            to_remove.sort_unstable();
            for &i in to_remove.iter().rev() {
                content.units.remove(i);
            }
        }
        None => match after_idx {
            Some(ai) => {
                if let UnitContent::Prose { inline, .. } = &mut content.units[ai].content {
                    inline.insert(
                        0,
                        Inline::Math {
                            span: CharSpan::new(0, 0),
                            expr,
                        },
                    );
                }
                content.units.remove(math_idx);
            }
            // No adjacent prose: the math unit becomes a prose unit hosting the atom inline.
            None => {
                content.units[math_idx].content = UnitContent::Prose {
                    text: String::new(),
                    inline: vec![Inline::Math {
                        span: CharSpan::new(0, 0),
                        expr,
                    }],
                };
            }
        },
    }
    renumber_siblings(content, parent);
    Ok(())
}

// ════════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════════

fn unit_index(content: &MathContent, id: UnitId) -> Result<usize, ValidationError> {
    content
        .units
        .iter()
        .position(|u| u.id == id)
        .ok_or(ValidationError::UnitNotFound {
            unit_id: id.to_string(),
        })
}

fn find_unit_mut(content: &mut MathContent, id: UnitId) -> Result<&mut Unit, ValidationError> {
    content
        .units
        .iter_mut()
        .find(|u| u.id == id)
        .ok_or(ValidationError::UnitNotFound {
            unit_id: id.to_string(),
        })
}

/// Find the `MathExpression` with `id` inside a unit — a standalone `Math` unit, or an
/// `Inline::Math` within a prose unit.
fn find_expr_in_unit_mut(
    unit: &mut Unit,
    id: ExpressionId,
) -> Result<&mut MathExpression, ValidationError> {
    let not_found = ValidationError::ExpressionNotFound {
        expression_id: id.to_string(),
    };
    match &mut unit.content {
        UnitContent::Math { expr } if expr.id == id => Ok(expr),
        UnitContent::Prose { inline, .. } => inline
            .iter_mut()
            .find_map(|el| match el {
                Inline::Math { expr, .. } if expr.id == id => Some(expr),
                _ => None,
            })
            .ok_or(not_found),
        _ => Err(not_found),
    }
}

/// Run the §6.0 inline-atom contract (`validate::validate_inline`) over a prose unit's inline.
fn validate_unit_inline(unit: &Unit) -> Result<(), ValidationError> {
    if let UnitContent::Prose { inline, .. } = &unit.content {
        for el in inline {
            validate_inline(el)?;
        }
    }
    Ok(())
}

/// Reassign every sibling under `parent` a gap-free `0..n` position, preserving their current
/// position order (ties — newly-inserted units sharing a position — broken by vector order, which
/// the ops maintain as reading order). The single position-discipline chokepoint for all
/// structural ops.
fn renumber_siblings(content: &mut MathContent, parent: Option<UnitId>) {
    let mut idxs: Vec<usize> = content
        .units
        .iter()
        .enumerate()
        .filter(|(_, u)| u.parent_unit_id == parent)
        .map(|(i, _)| i)
        .collect();
    idxs.sort_by_key(|&i| content.units[i].position);
    for (new_pos, &i) in idxs.iter().enumerate() {
        content.units[i].position = new_pos as u32;
    }
}

/// The set of unit ids in the subtree rooted at `root` — the root plus every transitive
/// `parent_unit_id` descendant in `content` (the `rehome_subtree`/`dissolve_object` closure). Errors
/// if `root` is not a unit of `content`. Unit ids are distinct within an object (the DB PK), so the
/// growing-set fixpoint is correct and cycle-safe: it only ever absorbs reachable units and is
/// bounded by the unit count, so a malformed `parent_unit_id` cycle cannot hang it.
fn subtree_closure(
    content: &MathContent,
    root: UnitId,
) -> Result<std::collections::HashSet<UnitId>, ValidationError> {
    if !content.units.iter().any(|u| u.id == root) {
        return Err(ValidationError::UnitNotFound {
            unit_id: root.to_string(),
        });
    }
    let mut set = std::collections::HashSet::new();
    set.insert(root);
    loop {
        let mut grew = false;
        for u in &content.units {
            if let Some(p) = u.parent_unit_id
                && set.contains(&p)
                && set.insert(u.id)
            {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    Ok(set)
}

fn content_kind_tag(c: &UnitContent) -> &'static str {
    match c {
        UnitContent::Prose { .. } => "prose",
        UnitContent::Math { .. } => "math",
        UnitContent::List { .. } => "list",
        UnitContent::Derivation => "derivation",
        UnitContent::CaseSplit => "case_split",
        UnitContent::Group => "group",
        UnitContent::Embed { .. } => "embed",
    }
}

fn inline_span(el: &Inline) -> CharSpan {
    match el {
        Inline::Mark { span, .. } | Inline::Math { span, .. } | Inline::Reference { span, .. } => {
            *span
        }
    }
}

fn inline_span_mut(el: &mut Inline) -> &mut CharSpan {
    match el {
        Inline::Mark { span, .. } | Inline::Math { span, .. } | Inline::Reference { span, .. } => {
            span
        }
    }
}

/// Shift an inline element's span left by `by` (split: the right half's offsets rebase to 0).
fn shift_inline_back(mut el: Inline, by: u32) -> Inline {
    let s = inline_span_mut(&mut el);
    s.start = s.start.saturating_sub(by);
    s.end = s.end.saturating_sub(by);
    el
}

/// Shift an inline element's span right by `by` (merge: the second unit's offsets rebase past
/// the first unit's text).
fn shift_inline_forward(mut el: Inline, by: u32) -> Inline {
    let s = inline_span_mut(&mut el);
    s.start = s.start.saturating_add(by);
    s.end = s.end.saturating_add(by);
    el
}

/// Char-offset → byte-offset into `s` (canonical surface is ASCII, but prose is arbitrary
/// text, so count chars); a char index at or past the end maps to `s.len()`.
fn char_to_byte(s: &str, char_idx: u32) -> usize {
    s.char_indices()
        .nth(char_idx as usize)
        .map(|(b, _)| b)
        .unwrap_or(s.len())
}

/// Whether `xs` has any repeated element.
fn has_duplicate<T: Eq + std::hash::Hash + Copy>(xs: &[T]) -> bool {
    let mut seen = std::collections::HashSet::new();
    xs.iter().any(|x| !seen.insert(*x))
}

/// Every `MathExpression` id in a content aggregate, in document order (Math units + inline
/// math), with multiplicity — the basis for the expression-id stability invariants.
fn expr_ids_of(content: &MathContent) -> Vec<ExpressionId> {
    let mut ids = Vec::new();
    for u in &content.units {
        match &u.content {
            UnitContent::Math { expr } => ids.push(expr.id),
            UnitContent::Prose { inline, .. } => {
                for el in inline {
                    if let Inline::Math { expr, .. } = el {
                        ids.push(expr.id);
                    }
                }
            }
            _ => {}
        }
    }
    ids
}

/// Re-mint every `MathExpression` id in a unit's content via `map`; a missing entry is a hard
/// error (a partial map would alias ids across objects).
fn remint_exprs(
    content: &mut UnitContent,
    map: &std::collections::HashMap<ExpressionId, ExpressionId>,
) -> Result<(), ValidationError> {
    match content {
        UnitContent::Math { expr } => remint_one(expr, map),
        UnitContent::Prose { inline, .. } => {
            for el in inline.iter_mut() {
                if let Inline::Math { expr, .. } = el {
                    remint_one(expr, map)?;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn remint_one(
    expr: &mut MathExpression,
    map: &std::collections::HashMap<ExpressionId, ExpressionId>,
) -> Result<(), ValidationError> {
    expr.id = *map.get(&expr.id).ok_or(ValidationError::RemapIncomplete {
        kind: "expression".into(),
    })?;
    Ok(())
}
