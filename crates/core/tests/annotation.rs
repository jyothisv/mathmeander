//! §6.2 brace-annotation reconcile — the annotation-axis op. Proves: a first-seen annotation mints an
//! `annotation` object; a resolvable SubTerm/ProseSpan target is `Active`; a broken sub-term path ORPHANS
//! to `Stale` (never dropped); an existing id is not re-minted; a delete removes the object; a target on a
//! missing unit is rejected; empty primitive/target lists are rejected; `annotation` is producible-but-not-
//! directly-creatable. No commit — the owner stages.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use mathmeander_core::error::ValidationError;
use mathmeander_core::ids::{
    AnnotationTargetId, ExpressionId, ObjectId, ObjectVersionId, ProvenanceId, SpaceId, UnitId,
};
use mathmeander_core::model::{
    AnnotationExtent, AnnotationLabel, AnnotationPrimitive, AnnotationRole, AnnotationTarget,
    ContentLocator, DeclaredBy, LayoutStep, LinkStatus, MathExpression, ObjectStatus, ObjectType,
    ParseStatus, SurfaceFormat, Unit, UnitContent, UnitStatus,
};
use mathmeander_core::ops::{
    AnnotationDraft, AnnotationTargetDraft, MathContent, OpContext, ReconcileAnnotationsInput,
    reconcile_annotations,
};

fn v7(tag: u128) -> Uuid {
    let bits = (tag & !(0xF << 76)) | (0x7 << 76);
    let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
    Uuid::from_u128(bits)
}
fn now() -> DateTime<Utc> {
    DateTime::from_timestamp(1_780_000_000, 0).expect("in range")
}
fn ctx() -> OpContext {
    OpContext {
        provenance_id: ProvenanceId(v7(100)),
        version_id: ObjectVersionId(v7(101)),
    }
}

const OBJ: u128 = 1;
const U_MATH: u128 = 10; // a display-math unit whose expr is "x^2 + y"
const E: u128 = 11;
const U_PROSE: u128 = 12; // a 16-char prose unit "the discriminant"
const ANN: u128 = 20;
const TGT: u128 = 21;

fn base_unit(id: u128, position: u32, content: UnitContent) -> Unit {
    Unit {
        id: UnitId(v7(id)),
        object_id: ObjectId(v7(OBJ)),
        parent_unit_id: None,
        position,
        slot: None,
        row_relation: None,
        unit_type: None,
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content,
        provenance_id: ProvenanceId(v7(9)),
    }
}

fn host() -> MathContent {
    MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 3,
        units: vec![
            base_unit(
                U_MATH,
                0,
                UnitContent::Math {
                    expr: MathExpression {
                        id: ExpressionId(v7(E)),
                        surface_text: "x^2 + y".to_string(),
                        surface_format: SurfaceFormat::Mathmeander,
                        input_syntax: None,
                        original_input: "x^2 + y".to_string(),
                        parse_status: ParseStatus::Renderable,
                        occurrences: vec![],
                    },
                },
            ),
            base_unit(
                U_PROSE,
                1,
                UnitContent::Prose {
                    text: "the discriminant".to_string(),
                    inline: vec![],
                },
            ),
        ],
    }
}

fn overbrace(text: &str) -> AnnotationPrimitive {
    AnnotationPrimitive::Overbrace {
        label: AnnotationLabel {
            text: text.to_string(),
            inline: vec![],
        },
        gap: LayoutStep::Small,
    }
}
fn target(unit: u128, extent: AnnotationExtent) -> AnnotationTargetDraft {
    AnnotationTargetDraft {
        id: AnnotationTargetId(v7(TGT)),
        role: AnnotationRole::Target,
        position: 0,
        target_unit_id: UnitId(v7(unit)),
        extent,
    }
}
fn sub_term(path: Vec<u32>) -> AnnotationExtent {
    AnnotationExtent::SubTerm {
        expression_id: ExpressionId(v7(E)),
        term_path: path,
    }
}
fn draft(
    primitives: Vec<AnnotationPrimitive>,
    targets: Vec<AnnotationTargetDraft>,
) -> AnnotationDraft {
    AnnotationDraft {
        annotation_id: ObjectId(v7(ANN)),
        primitives,
        targets,
    }
}
fn input(upserts: Vec<AnnotationDraft>, deletes: Vec<ObjectId>) -> ReconcileAnnotationsInput {
    ReconcileAnnotationsInput {
        expected_revision: 3,
        space_id: SpaceId(v7(3)),
        upserts,
        deletes,
    }
}

#[test]
fn first_seen_annotation_mints_an_object_with_an_active_sub_term_target() {
    // `[0]` in "x^2 + y" is the `Sup{x,2}` sub-term → resolves.
    let d = draft(
        vec![overbrace("the square")],
        vec![target(U_MATH, sub_term(vec![0]))],
    );
    let out = reconcile_annotations(&host(), &[], &input(vec![d], vec![]), &ctx(), now()).unwrap();
    assert_eq!(out.new_objects.len(), 1);
    assert_eq!(out.new_objects[0].object_type, ObjectType::Annotation);
    assert_eq!(out.new_objects[0].status, ObjectStatus::Draft);
    assert_eq!(out.new_objects[0].id, ObjectId(v7(ANN)));
    assert_eq!(out.details_upserted.len(), 1);
    assert_eq!(out.targets_upserted.len(), 1);
    assert_eq!(out.targets_upserted[0].status, LinkStatus::Active);
    assert_eq!(out.targets_upserted[0].target_object_id, ObjectId(v7(OBJ)));
}

#[test]
fn a_broken_sub_term_path_orphans_to_stale_never_dropped() {
    // `[9]` is out of range in "x^2 + y" → does not resolve.
    let d = draft(
        vec![overbrace("gone")],
        vec![target(U_MATH, sub_term(vec![9]))],
    );
    let out = reconcile_annotations(&host(), &[], &input(vec![d], vec![]), &ctx(), now()).unwrap();
    assert_eq!(out.targets_upserted.len(), 1); // kept, not dropped
    assert_eq!(out.targets_upserted[0].status, LinkStatus::Stale);
}

#[test]
fn prose_span_in_range_is_active_out_of_range_is_stale() {
    let ok = draft(
        vec![overbrace("phrase")],
        vec![target(
            U_PROSE,
            AnnotationExtent::Locator {
                locator: ContentLocator::ProseSpan { start: 4, end: 16 },
            },
        )],
    );
    let out = reconcile_annotations(&host(), &[], &input(vec![ok], vec![]), &ctx(), now()).unwrap();
    assert_eq!(out.targets_upserted[0].status, LinkStatus::Active);

    let over = draft(
        vec![overbrace("phrase")],
        vec![target(
            U_PROSE,
            AnnotationExtent::Locator {
                locator: ContentLocator::ProseSpan { start: 0, end: 999 },
            },
        )],
    );
    let out2 =
        reconcile_annotations(&host(), &[], &input(vec![over], vec![]), &ctx(), now()).unwrap();
    assert_eq!(out2.targets_upserted[0].status, LinkStatus::Stale);
}

#[test]
fn an_existing_annotation_id_is_not_reminted_as_a_new_object() {
    let existing = AnnotationTarget {
        id: AnnotationTargetId(v7(TGT)),
        annotation_id: ObjectId(v7(ANN)),
        role: AnnotationRole::Target,
        position: 0,
        target_unit_id: UnitId(v7(U_MATH)),
        target_object_id: ObjectId(v7(OBJ)),
        extent: sub_term(vec![0]),
        status: LinkStatus::Active,
        provenance_id: ProvenanceId(v7(9)),
    };
    let d = draft(
        vec![overbrace("re-labelled")],
        vec![target(U_MATH, sub_term(vec![1]))],
    );
    let out = reconcile_annotations(&host(), &[existing], &input(vec![d], vec![]), &ctx(), now())
        .unwrap();
    assert!(out.new_objects.is_empty());
    assert_eq!(out.targets_upserted.len(), 1);
    assert_eq!(out.targets_upserted[0].status, LinkStatus::Active); // [1] = `y` resolves
}

/// A `current` row binding annotation ANN to this host (the delete-eligibility baseline).
fn current_row() -> AnnotationTarget {
    AnnotationTarget {
        id: AnnotationTargetId(v7(TGT)),
        annotation_id: ObjectId(v7(ANN)),
        role: AnnotationRole::Target,
        position: 0,
        target_unit_id: UnitId(v7(U_MATH)),
        target_object_id: ObjectId(v7(OBJ)),
        extent: sub_term(vec![0]),
        status: LinkStatus::Active,
        provenance_id: ProvenanceId(v7(9)),
    }
}

#[test]
fn a_delete_removes_the_annotation_object() {
    let out = reconcile_annotations(
        &host(),
        &[current_row()],
        &input(vec![], vec![ObjectId(v7(ANN))]),
        &ctx(),
        now(),
    )
    .unwrap();
    assert_eq!(out.objects_removed, vec![ObjectId(v7(ANN))]);
    assert!(out.new_objects.is_empty());
}

#[test]
fn a_delete_of_an_id_not_among_this_hosts_annotations_is_dropped() {
    // The input's deletes are client-named object ids — anything NOT currently bound to this host
    // (another host's annotation, a note, a notebook, another space's object) must never reach the
    // outcome's `objects_removed` (the arbitrary-delete / tenant-isolation hole). Silently dropped, not
    // rejected: an id already deleted by another session must not wedge the self-healing drain.
    let foreign = ObjectId(v7(777));
    let out = reconcile_annotations(
        &host(),
        &[current_row()],
        &input(vec![], vec![foreign, ObjectId(v7(ANN))]),
        &ctx(),
        now(),
    )
    .unwrap();
    assert_eq!(out.objects_removed, vec![ObjectId(v7(ANN))]);
}

#[test]
fn a_label_with_an_out_of_bounds_inline_span_is_rejected() {
    // The label carries the SAME span contract as Prose: an inline span past the text's end must 422,
    // exactly as save_content validates prose (the mechanical-enforcement gap the review flagged).
    use mathmeander_core::model::{CharSpan, Inline};
    let bad = AnnotationPrimitive::Overbrace {
        label: AnnotationLabel {
            text: "hi".to_string(),
            inline: vec![Inline::Mark {
                span: CharSpan { start: 0, end: 99 },
                style: "em".to_string(),
            }],
        },
        gap: LayoutStep::Small,
    };
    let d = draft(vec![bad], vec![target(U_MATH, sub_term(vec![0]))]);
    let err = reconcile_annotations(&host(), &[], &input(vec![d], vec![]), &ctx(), now())
        .expect_err("out-of-bounds label span must be rejected");
    assert!(matches!(err, ValidationError::InlineSpanOutOfBounds { .. }));
}

#[test]
fn a_target_on_a_unit_not_in_this_object_is_rejected() {
    let d = draft(
        vec![overbrace("x")],
        vec![target(
            999,
            AnnotationExtent::Locator {
                locator: ContentLocator::WholeUnit,
            },
        )],
    );
    let err = reconcile_annotations(&host(), &[], &input(vec![d], vec![]), &ctx(), now());
    assert!(matches!(
        err,
        Err(ValidationError::ContentSaveInvalid { .. })
    ));
}

#[test]
fn empty_primitive_or_target_lists_are_rejected() {
    let no_prims = draft(vec![], vec![target(U_MATH, sub_term(vec![0]))]);
    assert!(
        reconcile_annotations(&host(), &[], &input(vec![no_prims], vec![]), &ctx(), now()).is_err()
    );
    let no_targets = draft(vec![overbrace("x")], vec![]);
    assert!(
        reconcile_annotations(
            &host(),
            &[],
            &input(vec![no_targets], vec![]),
            &ctx(),
            now()
        )
        .is_err()
    );
}

#[test]
fn annotation_is_producible_but_not_directly_creatable() {
    assert!(ObjectType::Annotation.is_producible()); // via reconcile_annotations
    assert!(!ObjectType::Annotation.is_directly_creatable()); // a raw typed POST still 422s
    assert!(!ObjectType::Annotation.is_surface()); // and it is not a §6.5 writing surface
}

#[test]
fn parse_error_in_surface_text_silently_becomes_stale_with_no_diagnostic() {
    // This test verifies that when surface_text is corrupted/malformed (e.g., truncated),
    // the parse error is silently swallowed and the annotation target becomes Stale
    // with no log or diagnostic information about WHY it failed.

    // Create a host with corrupted surface_text. NOTE: the parser is TOTAL and recovers aggressively —
    // a trailing operator (`x^2 +`) still yields a tree whose path [0] resolves — so the corruption must
    // leave NO addressable child at [0]: a lone stray delimiter parses to a childless Error root.
    let mut corrupted_host = host();
    if let UnitContent::Math { expr } = &mut corrupted_host.units[0].content {
        expr.surface_text = ")".to_string();
    }

    // Try to create an annotation targeting [0] in the corrupted expression
    let d = draft(
        vec![overbrace("this will be stale")],
        vec![target(U_MATH, sub_term(vec![0]))],
    );

    let out = reconcile_annotations(&corrupted_host, &[], &input(vec![d], vec![]), &ctx(), now())
        .unwrap();

    // The target should be Stale (orphaned due to parse failure)
    assert_eq!(out.targets_upserted.len(), 1);
    assert_eq!(out.targets_upserted[0].status, LinkStatus::Stale);

    // But there's NO error logged, no diagnostic information, nothing distinguishing
    // this from a genuinely-broken path (e.g. [9] out of range).
    // The user/admin has no way to know that the surface_text itself is malformed.
}
