//! `save_content` derives/reconciles `from_content` reference edges (§6.1b) from mention atoms: each
//! `Inline::Reference` carries its edge's stable, CLIENT-minted `link_id`, so the core reconciles by id
//! (it mints none). A link-bearing mention in a touched unit is upserted; a prior ProseSpan reference
//! edge of a touched unit whose id is gone is staled; an untouched unit's edges are left alone.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use mathmeander_core::ids::{LinkId, ObjectId, ObjectVersionId, ProvenanceId, UnitId};
use mathmeander_core::model::{
    CharSpan, ContentLocator, DeclaredBy, Inline, Link, LinkStatus, LinkType, ReferenceTarget,
    Unit, UnitContent, UnitStatus,
};
use mathmeander_core::ops::{MathContent, OpContext, save_content};

fn v7(tag: u128) -> Uuid {
    let bits = (tag & !(0xF << 76)) | (0x7 << 76);
    let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
    Uuid::from_u128(bits)
}
fn op_now() -> DateTime<Utc> {
    DateTime::from_timestamp(1_780_000_000, 0).expect("in range")
}
fn op_ctx() -> OpContext {
    OpContext {
        provenance_id: ProvenanceId(v7(100)),
        version_id: ObjectVersionId(v7(101)),
    }
}

const OBJ: u128 = 1;
const U: u128 = 10; // the source (citing) unit
const TGT: u128 = 200; // a cited object
const LNK: u128 = 300; // the reference's link id

fn prose_unit(text: &str, inline: Vec<Inline>) -> Unit {
    Unit {
        id: UnitId(v7(U)),
        object_id: ObjectId(v7(OBJ)),
        parent_unit_id: None,
        position: 0,
        slot: None,
        row_relation: None,
        unit_type: None,
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content: UnitContent::Prose {
            text: text.to_string(),
            inline,
        },
        provenance_id: ProvenanceId(v7(9)),
    }
}

/// A zero-width mention atom at offset 4 (after "see ").
fn reference(target: Option<ReferenceTarget>, link_id: Option<LinkId>) -> Inline {
    Inline::Reference {
        span: CharSpan { start: 4, end: 4 },
        text: "X".to_string(),
        target,
        link_id,
        target_handle_id: None,
    }
}

fn obj_target() -> Option<ReferenceTarget> {
    Some(ReferenceTarget::Object {
        object_id: ObjectId(v7(TGT)),
    })
}

const TGT_UNIT: u128 = 250; // a cited block (unit) within the target object

fn unit_target() -> Option<ReferenceTarget> {
    Some(ReferenceTarget::Unit {
        object_id: ObjectId(v7(TGT)),
        unit_id: UnitId(v7(TGT_UNIT)),
    })
}

fn prior_with(inline: Vec<Inline>) -> MathContent {
    MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![prose_unit("see ", inline)],
    }
}

/// The edge a `[U → TGT]` reference (id `LNK`) derives — used as a `current_links` fixture.
fn existing_edge(unit: u128, link: u128, locator: ContentLocator) -> Link {
    Link {
        id: LinkId(v7(link)),
        source_object_id: ObjectId(v7(OBJ)),
        target_object_id: Some(ObjectId(v7(TGT))),
        target_unit_id: None,
        unresolved_text: None,
        target_selector: None,
        link_type: LinkType::Related,
        status: LinkStatus::Active,
        from_content: true,
        source_unit_id: Some(UnitId(v7(unit))),
        content_locator: Some(locator),
        provenance_id: ProvenanceId(v7(9)),
        created_at: op_now(),
    }
}

#[test]
fn derives_a_resolved_reference_edge() {
    let upsert = prose_unit("see ", vec![reference(obj_target(), Some(LinkId(v7(LNK))))]);
    let out = save_content(
        &prior_with(vec![]),
        &[],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    assert_eq!(out.links_upserted.len(), 1);
    assert!(out.links_staled.is_empty());
    let l = &out.links_upserted[0];
    assert_eq!(l.id, LinkId(v7(LNK))); // the atom's id, NOT a freshly minted one
    assert_eq!(l.target_object_id, Some(ObjectId(v7(TGT))));
    assert_eq!(l.unresolved_text, None);
    assert!(l.from_content);
    assert_eq!(l.source_unit_id, Some(UnitId(v7(U))));
    assert_eq!(
        l.content_locator,
        Some(ContentLocator::ProseSpan { start: 4, end: 4 })
    );
    assert_eq!(l.link_type, LinkType::Related);
    assert_eq!(l.status, LinkStatus::Active);
}

#[test]
fn a_unit_target_derives_an_object_edge_refined_to_the_unit() {
    let upsert = prose_unit(
        "see ",
        vec![reference(unit_target(), Some(LinkId(v7(LNK))))],
    );
    let out = save_content(
        &prior_with(vec![]),
        &[],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    let l = &out.links_upserted[0];
    assert_eq!(l.target_object_id, Some(ObjectId(v7(TGT)))); // the unit's home object
    assert_eq!(l.target_unit_id, Some(UnitId(v7(TGT_UNIT)))); // refined to the block
    assert_eq!(l.unresolved_text, None);
    assert!(l.from_content);
}

#[test]
fn an_unresolved_reference_carries_its_surface_text() {
    let upsert = prose_unit("see ", vec![reference(None, Some(LinkId(v7(LNK))))]);
    let out = save_content(
        &prior_with(vec![]),
        &[],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    let l = &out.links_upserted[0];
    assert_eq!(l.target_object_id, None);
    assert_eq!(l.unresolved_text, Some("X".to_string()));
}

#[test]
fn a_reference_without_a_link_id_derives_no_edge() {
    let upsert = prose_unit("see ", vec![reference(obj_target(), None)]);
    let out = save_content(
        &prior_with(vec![]),
        &[],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    assert!(out.links_upserted.is_empty());
    assert!(out.links_staled.is_empty());
}

#[test]
fn removing_the_reference_stales_its_edge() {
    let existing = existing_edge(U, LNK, ContentLocator::ProseSpan { start: 4, end: 4 });
    let prior = prior_with(vec![reference(obj_target(), Some(LinkId(v7(LNK))))]);
    let upsert = prose_unit("see ", vec![]); // the mention is gone

    let out = save_content(&prior, &[existing], &[upsert], &[], &op_ctx(), op_now()).expect("ok");

    assert!(out.links_upserted.is_empty());
    assert_eq!(out.links_staled, vec![LinkId(v7(LNK))]);
}

#[test]
fn an_untouched_units_edge_is_left_alone() {
    // A reference edge for unit 999 (NOT in this delta) is neither upserted nor staled.
    let other = existing_edge(999, LNK + 1, ContentLocator::ProseSpan { start: 0, end: 0 });
    let upsert = prose_unit("see ", vec![reference(obj_target(), Some(LinkId(v7(LNK))))]);

    let out = save_content(
        &prior_with(vec![]),
        &[other],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    assert_eq!(out.links_upserted.len(), 1);
    assert_eq!(out.links_upserted[0].id, LinkId(v7(LNK)));
    assert!(out.links_staled.is_empty());
}

#[test]
fn an_occurrence_edge_is_not_reconciled_as_a_reference() {
    // An ExpressionSpan (occurrence) edge for the touched unit must NOT be staled by the prose-reference
    // reconciliation (different locator kind / different op owns it).
    use mathmeander_core::ids::ExpressionId;
    let occ = Link {
        content_locator: Some(ContentLocator::ExpressionSpan {
            expression_id: ExpressionId(v7(500)),
            start: 0,
            end: 1,
        }),
        ..existing_edge(U, LNK + 2, ContentLocator::ProseSpan { start: 0, end: 0 })
    };
    let upsert = prose_unit("see ", vec![]); // no prose references
    let out = save_content(
        &prior_with(vec![]),
        &[occ],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    assert!(out.links_staled.is_empty()); // the occurrence edge is untouched
    assert!(out.links_upserted.is_empty());
}

/// §6.1b (review C2): a cite to a SAME-object unit that was DELETED (absent from the content) derives an
/// UNRESOLVED edge — never a dangling `target_unit_id` that 422s the glue's composite FK on the next edit.
#[test]
fn cite_to_a_missing_same_object_unit_derives_unresolved() {
    let gone = Some(ReferenceTarget::Unit {
        object_id: ObjectId(v7(OBJ)), // THIS object
        unit_id: UnitId(v7(0xbad)),   // a unit not present in the content (deleted)
    });
    let upsert = prose_unit("see ", vec![reference(gone, Some(LinkId(v7(LNK))))]);
    let out = save_content(
        &prior_with(vec![]),
        &[],
        &[upsert],
        &[],
        &op_ctx(),
        op_now(),
    )
    .expect("ok");

    assert_eq!(out.links_upserted.len(), 1);
    let l = &out.links_upserted[0];
    assert_eq!(l.id, LinkId(v7(LNK)));
    assert_eq!(
        l.target_unit_id, None,
        "a missing same-object target → no dangling FK"
    );
    assert_eq!(l.target_object_id, None);
    assert_eq!(
        l.unresolved_text.as_deref(),
        Some("X"),
        "surfaced as unresolved (the atom's text)"
    );
}
