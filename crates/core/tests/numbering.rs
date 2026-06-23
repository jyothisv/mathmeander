//! Numbering / display-name projection tests (arch doc §6.3b) — slice 1d. The projection is
//! pure and policy-free: these pin reorder-invariance, name-override precedence (decision G:
//! both number and name returned), per-policy divergence, and the embed→alias name path.

use uuid::Uuid;

use mathmeander_core::ids::{AliasId, HandleId, ObjectId, ProvenanceId, SpaceId, UnitId};
use mathmeander_core::model::{
    Alias, AliasKind, AliasScope, DeclaredBy, EmbedTarget, Handle, HandleScope, HandleStatus, Unit,
    UnitContent, UnitStatus, UnitType,
};
use mathmeander_core::numbering::{
    DisplayLabels, NumberingPolicy, UnitLabel, project_display_labels,
};

fn v7(tag: u128) -> Uuid {
    let bits = (tag & !(0xF << 76)) | (0x7 << 76);
    let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
    Uuid::from_u128(bits)
}

fn obj() -> ObjectId {
    ObjectId(v7(1))
}

/// A prose unit with the given type at the given position (parent = top level).
fn unit(id_tag: u128, position: u32, unit_type: Option<UnitType>) -> Unit {
    Unit {
        id: UnitId(v7(id_tag)),
        object_id: obj(),
        parent_unit_id: None,
        position,
        slot: None,
        row_relation: None,
        unit_type,
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content: UnitContent::Prose {
            text: String::new(),
            inline: Vec::new(),
        },
        provenance_id: ProvenanceId(v7(9)),
    }
}

/// An object-embed unit (transcludes `target`), with no type.
fn embed_unit(id_tag: u128, position: u32, target: ObjectId) -> Unit {
    Unit {
        content: UnitContent::Embed {
            target: EmbedTarget::Object { object_id: target },
        },
        ..unit(id_tag, position, None)
    }
}

fn handle_on(id_tag: u128, unit_id: UnitId, name: &str, status: HandleStatus) -> Handle {
    Handle {
        id: HandleId(v7(id_tag)),
        space_id: SpaceId(v7(51)),
        name: name.to_string(),
        target_object_id: obj(),
        target_unit_id: Some(unit_id),
        target_expression_id: None,
        status,
        scope: HandleScope::Object,
        provenance_id: ProvenanceId(v7(9)),
    }
}

fn alias_on(id_tag: u128, object_id: ObjectId, name: &str) -> Alias {
    Alias {
        id: AliasId(v7(id_tag)),
        object_id,
        name: name.to_string(),
        kind: AliasKind::User,
        scope: AliasScope::Global,
        scope_ref: None,
    }
}

fn label_for(labels: &DisplayLabels, unit_id: UnitId) -> &UnitLabel {
    labels
        .labels
        .iter()
        .find(|l| l.unit_id == unit_id)
        .expect("a label for the unit")
}

fn per_type(numbered: &[UnitType]) -> NumberingPolicy {
    NumberingPolicy {
        numbered_types: numbered.to_vec(),
        shared_counter: false,
    }
}

/// The labels are computed over document order (position), NEVER the input vec order — so the
/// same units in any order yield the same per-unit number.
#[test]
fn reorder_invariance() {
    let policy = per_type(&[UnitType::Theorem, UnitType::Lemma]);
    let u1 = unit(0xb1, 0, Some(UnitType::Theorem));
    let u2 = unit(0xb2, 1, Some(UnitType::Lemma));
    let u3 = unit(0xb3, 2, Some(UnitType::Theorem));

    let in_order = project_display_labels(&[u1.clone(), u2.clone(), u3.clone()], &[], &[], &policy);
    let shuffled = project_display_labels(&[u3.clone(), u1.clone(), u2.clone()], &[], &[], &policy);

    for u in [&u1, &u2, &u3] {
        assert_eq!(
            label_for(&in_order, u.id).number,
            label_for(&shuffled, u.id).number,
            "numbering must not depend on input vec order"
        );
    }
    // And the numbers are by document order: theorem 1, lemma 1, theorem 2.
    assert_eq!(label_for(&in_order, u1.id).number, Some(1));
    assert_eq!(label_for(&in_order, u2.id).number, Some(1));
    assert_eq!(label_for(&in_order, u3.id).number, Some(2));
}

/// A handle name and the computed number are BOTH returned (decision G) — the projection never
/// drops the number; precedence is the presentation layer's call.
#[test]
fn name_override_precedence() {
    let policy = per_type(&[UnitType::Theorem]);
    let u1 = unit(0xb1, 0, Some(UnitType::Theorem));
    let handles = [handle_on(0xc1, u1.id, "(★)", HandleStatus::Active)];

    let labels = project_display_labels(std::slice::from_ref(&u1), &[], &handles, &policy);
    let label = label_for(&labels, u1.id);
    assert_eq!(label.number, Some(1), "number is still computed");
    assert_eq!(label.name.as_deref(), Some("(★)"), "name is returned too");
}

/// A stale handle does not name the unit (only active handles override).
#[test]
fn stale_handle_does_not_name() {
    let policy = per_type(&[UnitType::Theorem]);
    let u1 = unit(0xb1, 0, Some(UnitType::Theorem));
    let handles = [handle_on(0xc1, u1.id, "(★)", HandleStatus::Stale)];

    let labels = project_display_labels(std::slice::from_ref(&u1), &[], &handles, &policy);
    assert_eq!(label_for(&labels, u1.id).name, None);
}

/// The same units numbered under two policies diverge — proving the policy is honored and the
/// core stores none of it. shared_counter runs one sequence across all numbered types.
#[test]
fn two_policy_divergence() {
    let u1 = unit(0xb1, 0, Some(UnitType::Theorem));
    let u2 = unit(0xb2, 1, Some(UnitType::Lemma));
    let u3 = unit(0xb3, 2, Some(UnitType::Theorem));
    let units = [u1.clone(), u2.clone(), u3.clone()];

    let shared = project_display_labels(
        &units,
        &[],
        &[],
        &NumberingPolicy {
            numbered_types: vec![UnitType::Theorem, UnitType::Lemma],
            shared_counter: true,
        },
    );
    let split = project_display_labels(
        &units,
        &[],
        &[],
        &per_type(&[UnitType::Theorem, UnitType::Lemma]),
    );

    // Shared: 1, 2, 3 in document order. Per-type: theorem 1, lemma 1, theorem 2.
    assert_eq!(label_for(&shared, u3.id).number, Some(3));
    assert_eq!(label_for(&split, u3.id).number, Some(2));
    assert_eq!(label_for(&shared, u2.id).number, Some(2));
    assert_eq!(label_for(&split, u2.id).number, Some(1));
}

/// A unit whose type is not in the policy (or which is typeless) gets no number.
#[test]
fn unnumbered_types_get_none() {
    let policy = per_type(&[UnitType::Theorem]);
    let numbered = unit(0xb1, 0, Some(UnitType::Theorem));
    let other = unit(0xb2, 1, Some(UnitType::Remark));
    let typeless = unit(0xb3, 2, None);

    let labels = project_display_labels(
        &[numbered.clone(), other.clone(), typeless.clone()],
        &[],
        &[],
        &policy,
    );
    assert_eq!(label_for(&labels, numbered.id).number, Some(1));
    assert_eq!(label_for(&labels, other.id).number, None);
    assert_eq!(label_for(&labels, typeless.id).number, None);
}

/// An object-embed unit's name comes from the embedded object's alias (aliases name objects).
#[test]
fn name_from_embed_alias() {
    let target = ObjectId(v7(0x2a));
    let e = embed_unit(0xb1, 0, target);
    let aliases = [alias_on(0xa1, target, "Bolzano–Weierstrass")];

    let labels = project_display_labels(std::slice::from_ref(&e), &aliases, &[], &per_type(&[]));
    let label = label_for(&labels, e.id);
    assert_eq!(label.name.as_deref(), Some("Bolzano–Weierstrass"));
    assert_eq!(label.number, None, "embed unit has no type, so no number");
}

/// A handle on the unit beats the embedded object's alias (a direct name wins).
#[test]
fn handle_beats_embed_alias() {
    let target = ObjectId(v7(0x2a));
    let e = embed_unit(0xb1, 0, target);
    let aliases = [alias_on(0xa1, target, "from alias")];
    let handles = [handle_on(0xc1, e.id, "from handle", HandleStatus::Active)];

    let labels =
        project_display_labels(std::slice::from_ref(&e), &aliases, &handles, &per_type(&[]));
    assert_eq!(
        label_for(&labels, e.id).name.as_deref(),
        Some("from handle")
    );
}

/// Nested numbered units number in true reading order (pre-order), not by parent UUID. `top1`
/// (reading position 0) is given the LARGER id and `top2` (position 1) the smaller, so the old
/// `(parent_uuid, position, id)` sort would have ordered `top2`'s child before `top1`'s — reversing
/// the numbers. Pre-order gives the lemma under `top1` number 1.
#[test]
fn nested_units_number_in_reading_order() {
    let top1 = Unit {
        parent_unit_id: None,
        ..unit(0x20, 0, None) // first in reading order, but LARGER id
    };
    let top2 = Unit {
        parent_unit_id: None,
        ..unit(0x10, 1, None) // second, SMALLER id
    };
    let lemma_under_top1 = Unit {
        parent_unit_id: Some(top1.id),
        ..unit(0xaa, 0, Some(UnitType::Lemma))
    };
    let lemma_under_top2 = Unit {
        parent_unit_id: Some(top2.id),
        ..unit(0xbb, 0, Some(UnitType::Lemma))
    };

    // Fed in scrambled order to also prove input-order independence.
    let labels = project_display_labels(
        &[
            lemma_under_top2.clone(),
            top2.clone(),
            lemma_under_top1.clone(),
            top1.clone(),
        ],
        &[],
        &[],
        &per_type(&[UnitType::Lemma]),
    );
    assert_eq!(label_for(&labels, lemma_under_top1.id).number, Some(1));
    assert_eq!(label_for(&labels, lemma_under_top2.id).number, Some(2));
}

/// A parent CYCLE (a↔b) is never reached from a root — the projection stays total (every unit
/// labeled, no hang), appending the cycle members deterministically.
#[test]
fn numbers_are_total_under_a_parent_cycle() {
    let a = Unit {
        parent_unit_id: Some(UnitId(v7(0xb2))),
        ..unit(0xb1, 0, Some(UnitType::Theorem))
    };
    let b = Unit {
        parent_unit_id: Some(UnitId(v7(0xb1))),
        ..unit(0xb2, 1, Some(UnitType::Theorem))
    };
    let labels = project_display_labels(
        &[a.clone(), b.clone()],
        &[],
        &[],
        &per_type(&[UnitType::Theorem]),
    );
    assert_eq!(labels.labels.len(), 2, "every unit is labeled exactly once");
    let numbers: Vec<Option<u32>> = labels.labels.iter().map(|l| l.number).collect();
    assert!(numbers.contains(&Some(1)) && numbers.contains(&Some(2)));
}

/// An ORPHAN (parent id absent from the set) is never reached from a root, but is still labeled.
#[test]
fn orphan_unit_is_still_labeled() {
    let orphan = Unit {
        parent_unit_id: Some(UnitId(v7(0xdead))),
        ..unit(0xb1, 0, Some(UnitType::Theorem))
    };
    let root = unit(0xb2, 0, Some(UnitType::Theorem));
    let labels = project_display_labels(
        &[orphan.clone(), root.clone()],
        &[],
        &[],
        &per_type(&[UnitType::Theorem]),
    );
    assert_eq!(labels.labels.len(), 2);
    assert!(label_for(&labels, orphan.id).number.is_some());
    assert!(label_for(&labels, root.id).number.is_some());
}
