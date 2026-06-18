//! Unit-level canonical operations (arch doc §6.0a/§6.3a) — slice 1c. The PURE transforms
//! over an object's content: split/merge units, set a unit's type, toggle an expression
//! between inline and display, rewrite a surface (re-anchoring edges), insert/resolve
//! references, and materialize a copy. Each is `fn(content, …) -> Result<OpOutcome,
//! ValidationError>`; time and freshly-minted ids are PASSED IN (the core mints nothing,
//! reads no clock, §5).
//!
//! Two load-bearing invariants live here from the first commit (they can't be retrofitted —
//! arch doc §13a build-order):
//!   • **Expression-id stability.** Split/merge/toggle move `MathExpression`s by value, so
//!     their `id`s are PRESERVED (empty `expression_id_remap`); only `materialize_object`
//!     mints fresh ids (a populated remap). The matrix proptest (`tests/properties.rs`) gates it.
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
use crate::ids::{ExpressionId, LinkId, ObjectVersionId, ProvenanceId, TagId, TaggingId, UnitId};
use crate::model::{
    CanonicalObject, CharSpan, ContentLocator, Inline, Link, LinkStatus, LinkType, MathExpression,
    ObjectStatus, ObjectVersion, Occurrence, OccurrenceTarget, Tagging, TargetSelector, Unit,
    UnitContent, UnitType,
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
    /// Old→new expression ids; EMPTY unless ids were re-minted (materialize only).
    pub expression_id_remap: Vec<ExpressionIdRemap>,
    /// The append-only history checkpoint for this write (§6.4).
    pub version_snapshot: ObjectVersion,
    /// Newly created objects (materialize's copy); empty otherwise.
    pub new_objects: Vec<CanonicalObject>,
    /// Taggings copied (split) or re-pointed (merge).
    pub taggings_propagated: Vec<Tagging>,
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
        }
    }
}

/// The append-only `ObjectVersion` for a write (§6.4). `version_no` is the new revision
/// (content is revision-bumped before this runs); the snapshot is the content aggregate,
/// carried opaquely (the §6 JSONB log exception).
fn snapshot(content: &MathContent, ctx: &OpContext, now: DateTime<Utc>) -> ObjectVersion {
    ObjectVersion {
        id: ctx.version_id,
        object_id: content.object_id,
        version_no: content.revision,
        // Serializing our own in-memory type (cf. `api::*Result::to_json`) — never fails.
        snapshot: serde_json::to_value(content).expect("MathContent serializes to JSON"),
        provenance_id: ctx.provenance_id,
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

/// `materialize_object` payload — the copy-and-edge stand-in (decision C). The glue pre-mints
/// the new object/provenance/edge ids and TOTAL id remaps over `source_content` (every unit and
/// every expression must have an entry, else `RemapIncomplete` — a partial map would alias ids
/// across objects).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MaterializeObjectInput {
    pub expected_revision: u32,
    pub source_object: CanonicalObject,
    pub source_content: MathContent,
    pub new_object_id: crate::ids::ObjectId,
    pub new_provenance_id: ProvenanceId,
    pub edge_link_id: LinkId,
    pub expr_id_map: Vec<ExpressionIdRemap>,
    pub unit_id_map: Vec<UnitIdRemap>,
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

/// Materialize a copy of an object's content into a new object, with an edge back to the
/// origin (the copy-and-edge stand-in, decision C). EVERY copied expression id is re-minted
/// (`expr_id_map`) and every unit re-homed (`unit_id_map`); a partial map is a hard error
/// (`RemapIncomplete`) and a duplicate source id is `DuplicateSourceId` — both would alias ids
/// across objects (§6.3a). The new object copies the source's metadata (incl. `extra`, §2.2)
/// with fresh identity; taggings are NOT propagated (a copy starts untagged — stand-in scope).
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
        // Deliberately empty: a copy-and-edge stand-in starts UNTAGGED (tags are personal
        // organization of the original; tag inheritance is the slice-2 ownership model). This is a
        // product choice, not the unknown-field omission the review flagged for `extra` (copied above).
        taggings_propagated: Vec::new(),
    })
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
