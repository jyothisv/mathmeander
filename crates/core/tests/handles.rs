//! `set_handle` (§6.3b) writes a unit's authored name as a `Handle` — the model home numbering
//! resolves into `UnitLabel.name`. A separate axis from `save_content`: upsert on a name, drop on an
//! empty name, reject an off-object target, and (end to end) the emitted handle surfaces as the unit's
//! display name through `project_display_labels`.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use mathmeander_core::ids::{HandleId, ObjectId, ObjectVersionId, ProvenanceId, SpaceId, UnitId};
use mathmeander_core::model::{
    DeclaredBy, HandleScope, HandleStatus, Unit, UnitContent, UnitStatus, UnitType,
};
use mathmeander_core::numbering::{NumberingPolicy, project_display_labels};
use mathmeander_core::ops::{MathContent, OpContext, SetHandleInput, set_handle};

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
const SPACE: u128 = 2;
const THM: u128 = 0xb1;
const HND: u128 = 0xc1;

fn theorem(id: u128) -> Unit {
    Unit {
        id: UnitId(v7(id)),
        object_id: ObjectId(v7(OBJ)),
        parent_unit_id: None,
        position: 0,
        slot: None,
        row_relation: None,
        unit_type: Some(UnitType::Theorem),
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content: UnitContent::Prose {
            text: "The statement.".to_string(),
            inline: vec![],
        },
        provenance_id: ProvenanceId(v7(9)),
    }
}
fn content() -> MathContent {
    MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 4,
        units: vec![theorem(THM)],
    }
}
fn input(name: &str) -> SetHandleInput {
    SetHandleInput {
        expected_revision: 4,
        handle_id: HandleId(v7(HND)),
        space_id: SpaceId(v7(SPACE)),
        target_unit_id: UnitId(v7(THM)),
        name: name.to_string(),
        scope: HandleScope::Object,
    }
}

#[test]
fn naming_a_unit_emits_an_active_handle_bound_to_the_object() {
    let out = set_handle(content(), &input("Cauchy–Schwarz"), &op_ctx(), op_now()).expect("ok");
    assert_eq!(out.handles_upserted.len(), 1);
    assert!(out.handles_removed.is_empty());
    let h = &out.handles_upserted[0];
    assert_eq!(h.id, HandleId(v7(HND)));
    assert_eq!(h.name, "Cauchy–Schwarz");
    assert_eq!(
        h.target_object_id,
        ObjectId(v7(OBJ)),
        "always binds the owning object"
    );
    assert_eq!(h.target_unit_id, Some(UnitId(v7(THM))));
    assert_eq!(h.target_expression_id, None, "unit grain only");
    assert_eq!(h.status, HandleStatus::Active);
    assert_eq!(
        h.provenance_id,
        ProvenanceId(v7(100)),
        "stamped by the op ctx"
    );
    assert_eq!(
        out.content.revision, 5,
        "a name is an authored change → revision bump"
    );
}

#[test]
fn an_empty_name_clears_rather_than_persisting_a_blank_handle() {
    for blank in ["", "   "] {
        let out = set_handle(content(), &input(blank), &op_ctx(), op_now()).expect("ok");
        assert!(
            out.handles_upserted.is_empty(),
            "blank {blank:?} never persists a handle"
        );
        assert_eq!(out.handles_removed, vec![HandleId(v7(HND))]);
    }
}

#[test]
fn naming_a_unit_not_in_this_object_is_rejected() {
    let mut bad = input("Cauchy–Schwarz");
    bad.target_unit_id = UnitId(v7(0xdead));
    let err = set_handle(content(), &bad, &op_ctx(), op_now()).unwrap_err();
    assert!(matches!(
        err,
        mathmeander_core::error::ValidationError::UnitNotFound { .. }
    ));
}

#[test]
fn idempotent_re_set_to_the_same_name_upserts_by_the_same_id() {
    let a = set_handle(content(), &input("Open Set"), &op_ctx(), op_now()).expect("ok");
    let b = set_handle(content(), &input("Open Set"), &op_ctx(), op_now()).expect("ok");
    assert_eq!(
        a.handles_upserted[0].id, b.handles_upserted[0].id,
        "same glue id → an upsert, not a dup"
    );
}

/// The loop the editor relies on: the handle `set_handle` emits, fed to numbering, IS the display name.
#[test]
fn an_emitted_handle_surfaces_as_the_units_display_name() {
    let out = set_handle(content(), &input("Cauchy–Schwarz"), &op_ctx(), op_now()).expect("ok");
    let policy = NumberingPolicy {
        numbered_types: vec![UnitType::Theorem],
        shared_counter: false,
    };
    let labels = project_display_labels(&out.content.units, &[], &out.handles_upserted, &policy);
    let label = labels
        .labels
        .iter()
        .find(|l| l.unit_id == UnitId(v7(THM)))
        .expect("the theorem is labelled");
    assert_eq!(label.name.as_deref(), Some("Cauchy–Schwarz"));
    assert_eq!(
        label.number,
        Some(1),
        "the number is still returned alongside the name"
    );
}
