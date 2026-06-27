//! §B section core (arch doc §B / §6.0a). A section is a `Heading { text, inline }` unit whose BODY and
//! SUBSECTIONS are its CHILD rows (`parent_unit_id` → the heading); a subsection is a child `Heading`;
//! level is nesting depth. The title lives ON the heading unit (not a separate child), so every section
//! unit is 1:1 with one editor block. Tested at the pure-core layer: `reparent_unit` (intra-object move —
//! descendants follow, ids preserved, cycle- AND parent-capability-guarded, positions gap-filled),
//! `toggle_heading` (prose↔heading; dissolve lifts the body), and the `validate_section_structure`
//! parent-capability invariant. No commit — the owner stages.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use mathmeander_core::error::ValidationError;
use mathmeander_core::ids::{ExpressionId, ObjectId, ObjectVersionId, ProvenanceId, UnitId};
use mathmeander_core::model::{
    CharSpan, DeclaredBy, Inline, MathExpression, ParseStatus, RowRelation, SurfaceFormat, Unit,
    UnitContent, UnitStatus,
};
use mathmeander_core::ops::{
    MathContent, OpContext, OpOutcome, ReparentUnitInput, RewriteSurfaceInput, SplitUnitInput,
    ToggleHeadingInput, reparent_unit, rewrite_surface, save_content, split_unit, toggle_heading,
};

// ── fixtures ──────────────────────────────────────────────────────────────────

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
const H_ROOT: u128 = 20; // a section (Heading) — its title + the body below are its children
const P: u128 = 22; // its body prose
const M: u128 = 23; // a body display equation
const E: u128 = 24; // the equation's expression id
const X: u128 = 40; // a loose top-level prose unit
const H2: u128 = 31; // a second top-level section (Heading)

fn prose(id: u128, parent: Option<u128>, position: u32, text: &str) -> Unit {
    Unit {
        id: UnitId(v7(id)),
        object_id: ObjectId(v7(OBJ)),
        parent_unit_id: parent.map(|p| UnitId(v7(p))),
        position,
        slot: None,
        row_relation: None,
        unit_type: None,
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content: UnitContent::Prose {
            text: text.to_string(),
            inline: vec![],
        },
        provenance_id: ProvenanceId(v7(9)),
    }
}
fn heading(id: u128, parent: Option<u128>, position: u32, text: &str) -> Unit {
    Unit {
        content: UnitContent::Heading {
            text: text.to_string(),
            inline: vec![],
        },
        ..prose(id, parent, position, "")
    }
}
fn math(id: u128, parent: u128, position: u32, expr: u128) -> Unit {
    Unit {
        content: UnitContent::Math {
            expr: MathExpression {
                id: ExpressionId(v7(expr)),
                surface_text: "x".to_string(),
                surface_format: SurfaceFormat::Mathmeander,
                input_syntax: None,
                original_input: "x".to_string(),
                parse_status: ParseStatus::Renderable,
                occurrences: vec![],
            },
        },
        ..prose(id, Some(parent), position, "")
    }
}

/// A section heading whose TITLE carries one zero-width inline `Math` atom (§B — a heading may read
/// "… $x$"). Used to prove the inline-aware sites (expr-id extraction, expr lookup) reach heading math.
fn heading_with_inline_math(id: u128, parent: Option<u128>, position: u32, expr: u128) -> Unit {
    Unit {
        content: UnitContent::Heading {
            text: "x".to_string(),
            inline: vec![Inline::Math {
                span: CharSpan { start: 0, end: 0 },
                expr: MathExpression {
                    id: ExpressionId(v7(expr)),
                    surface_text: "x".to_string(),
                    surface_format: SurfaceFormat::Mathmeander,
                    input_syntax: None,
                    original_input: "x".to_string(),
                    parse_status: ParseStatus::Renderable,
                    occurrences: vec![],
                },
            }],
        },
        ..prose(id, parent, position, "")
    }
}

/// A well-formed doc: section H_ROOT "Intro" [body P · equation M] · loose X · section H2 "Other".
fn content() -> MathContent {
    MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![
            heading(H_ROOT, None, 0, "Intro"),
            prose(P, Some(H_ROOT), 0, "Body."),
            math(M, H_ROOT, 1, E),
            prose(X, None, 1, "Loose."),
            heading(H2, None, 2, "Other"),
        ],
    }
}

fn reparent(
    content: MathContent,
    unit: u128,
    new_parent: Option<u128>,
    pos: u32,
) -> Result<OpOutcome, ValidationError> {
    let input = ReparentUnitInput {
        expected_revision: content.revision,
        unit_id: UnitId(v7(unit)),
        new_parent_unit_id: new_parent.map(|p| UnitId(v7(p))),
        new_position: pos,
    };
    reparent_unit(content, &input, &op_ctx(), op_now())
}
fn toggle(content: MathContent, unit: u128) -> Result<OpOutcome, ValidationError> {
    let input = ToggleHeadingInput {
        expected_revision: content.revision,
        unit_id: UnitId(v7(unit)),
    };
    toggle_heading(content, &input, &op_ctx(), op_now())
}
fn save(
    prior: &MathContent,
    upserts: &[Unit],
    deletes: &[UnitId],
) -> Result<OpOutcome, ValidationError> {
    save_content(prior, &[], upserts, deletes, &op_ctx(), op_now())
}

fn parent_of(c: &MathContent, id: u128) -> Option<UnitId> {
    c.units
        .iter()
        .find(|u| u.id == UnitId(v7(id)))
        .expect("unit present")
        .parent_unit_id
}
fn pos_of(c: &MathContent, id: u128) -> u32 {
    c.units
        .iter()
        .find(|u| u.id == UnitId(v7(id)))
        .expect("unit present")
        .position
}
fn child_positions(c: &MathContent, parent: Option<u128>) -> Vec<u32> {
    let pid = parent.map(|p| UnitId(v7(p)));
    let mut ps: Vec<u32> = c
        .units
        .iter()
        .filter(|u| u.parent_unit_id == pid)
        .map(|u| u.position)
        .collect();
    ps.sort_unstable();
    ps
}
fn kind_of(c: &MathContent, id: u128) -> &'static str {
    let u = c
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(id)))
        .expect("unit present");
    match &u.content {
        UnitContent::Prose { .. } => "prose",
        UnitContent::Heading { .. } => "heading",
        UnitContent::Math { .. } => "math",
        _ => "other",
    }
}

// ── reparent_unit ───────────────────────────────────────────────────────────────

#[test]
fn reparent_moves_a_section_descendants_and_ids_follow() {
    let before: Vec<UnitId> = content().units.iter().map(|u| u.id).collect();
    let out = reparent(content(), H_ROOT, Some(H2), 0).expect("valid move");

    // The section re-homed under H2; its body still points at it (descendants follow for free).
    assert_eq!(parent_of(&out.content, H_ROOT), Some(UnitId(v7(H2))));
    assert_eq!(parent_of(&out.content, P), Some(UnitId(v7(H_ROOT))));
    assert_eq!(parent_of(&out.content, M), Some(UnitId(v7(H_ROOT))));

    // Every unit id is preserved (no re-mint), and the expression id rode along untouched.
    let after: Vec<UnitId> = out.content.units.iter().map(|u| u.id).collect();
    assert_eq!(before.len(), after.len());
    assert!(before.iter().all(|id| after.contains(id)), "ids preserved");
    let m = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(M)))
        .unwrap();
    assert!(matches!(&m.content, UnitContent::Math { expr } if expr.id == ExpressionId(v7(E))));

    // Positions gap-free under the vacated top level (X, H2) and the new parent H2 (its lone child).
    assert_eq!(child_positions(&out.content, None), vec![0, 1]);
    assert_eq!(child_positions(&out.content, Some(H2)), vec![0]);
    assert_eq!(out.content.revision, 2, "revision bumped once");
}

#[test]
fn reparent_to_top_level() {
    let out = reparent(content(), P, None, 0).expect("valid move");
    assert_eq!(parent_of(&out.content, P), None);
    assert_eq!(pos_of(&out.content, P), 0);
    // The section it left stays well-formed (its equation M is still a child).
    assert_eq!(parent_of(&out.content, M), Some(UnitId(v7(H_ROOT))));
}

#[test]
fn reparent_same_parent_reorders_both_directions() {
    // Top level starts H_ROOT(0), X(1), H2(2). A DOWN-move (the off-by-one trap): H_ROOT → index 2.
    let down = reparent(content(), H_ROOT, None, 2)
        .expect("valid move")
        .content;
    assert_eq!(pos_of(&down, X), 0);
    assert_eq!(pos_of(&down, H2), 1);
    assert_eq!(
        pos_of(&down, H_ROOT),
        2,
        "down-move actually moves (no off-by-one no-op)"
    );

    // An UP-move: H2 → index 0.
    let up = reparent(content(), H2, None, 0)
        .expect("valid move")
        .content;
    assert_eq!(pos_of(&up, H2), 0);
    assert_eq!(pos_of(&up, H_ROOT), 1);
    assert_eq!(pos_of(&up, X), 2);
}

#[test]
fn reparent_into_a_section_at_position_zero_is_allowed() {
    // §B: a Heading is the section's PARENT (not a first-child title), so a body unit may land at index 0
    // — no clamp. X becomes the section's first child; the existing body shifts down.
    let out = reparent(content(), X, Some(H_ROOT), 0)
        .expect("valid move, no first-child clamp")
        .content;
    assert_eq!(parent_of(&out, X), Some(UnitId(v7(H_ROOT))));
    assert_eq!(
        pos_of(&out, X),
        0,
        "the dropped unit is first under the heading"
    );
    assert_eq!(pos_of(&out, P), 1);
    assert_eq!(pos_of(&out, M), 2);
}

#[test]
fn reparent_rejects_a_cycle() {
    // H_ROOT cannot move beneath P, which is its own descendant (the cycle guard runs before the move).
    let err = reparent(content(), H_ROOT, Some(P), 0).unwrap_err();
    assert!(
        matches!(err, ValidationError::ContentSaveInvalid { reason } if reason.contains("beneath"))
    );
}

#[test]
fn reparent_rejects_missing_unit_or_parent() {
    assert!(matches!(
        reparent(content(), 999, None, 0).unwrap_err(),
        ValidationError::UnitNotFound { .. }
    ));
    assert!(matches!(
        reparent(content(), X, Some(999), 0).unwrap_err(),
        ValidationError::UnitNotFound { .. }
    ));
}

#[test]
fn reparent_under_a_leaf_is_rejected() {
    // §B parent-capability: P is a Prose leaf — it can never own children. Moving the (childless) section
    // H2 under it passes the cycle guard but fails post-move well-formedness.
    let err = reparent(content(), H2, Some(P), 0).unwrap_err();
    assert!(
        matches!(&err, ValidationError::ContentSaveInvalid { reason } if reason.contains("cannot contain")),
        "leaf parent rejected by validate_section_structure, got {err:?}"
    );
}

// ── toggle_heading (prose ↔ heading) ──────────────────────────────────────────

#[test]
fn toggle_promote_turns_prose_into_a_heading() {
    let out = toggle(content(), X).expect("promote ok").content;
    assert_eq!(kind_of(&out, X), "heading", "X is now a section heading");
    let x = out.units.iter().find(|u| u.id == UnitId(v7(X))).unwrap();
    assert!(
        matches!(&x.content, UnitContent::Heading { text, .. } if text == "Loose."),
        "the title text rode across the kind flip"
    );
    assert_eq!(out.revision, 2, "revision bumped once");
}

#[test]
fn toggle_dissolve_lifts_the_body_into_the_parent() {
    let n_before = content().units.len();
    let out = toggle(content(), H_ROOT).expect("dissolve ok").content;

    // The former heading is now plain prose, its title preserved; NO new unit (no embed) was minted.
    assert_eq!(kind_of(&out, H_ROOT), "prose");
    assert_eq!(
        out.units.len(),
        n_before,
        "no embed minted — content lifts in place"
    );

    // Its body lifted to the top level, in H_ROOT's place, order preserved: H_ROOT, P, M, X, H2.
    assert_eq!(parent_of(&out, P), None);
    assert_eq!(parent_of(&out, M), None);
    assert_eq!(pos_of(&out, H_ROOT), 0);
    assert_eq!(pos_of(&out, P), 1);
    assert_eq!(pos_of(&out, M), 2);
    assert_eq!(pos_of(&out, X), 3);
    assert_eq!(pos_of(&out, H2), 4);

    // The lifted equation kept its expression id.
    let m = out.units.iter().find(|u| u.id == UnitId(v7(M))).unwrap();
    assert!(matches!(&m.content, UnitContent::Math { expr } if expr.id == ExpressionId(v7(E))));
}

#[test]
fn toggle_dissolve_of_a_subsection_lifts_to_its_parent_section() {
    // H_ROOT [ subsection H_SUB [ PS ] ]. Dissolving H_SUB lifts PS up to H_ROOT (not to the top level).
    const H_SUB: u128 = 50;
    const PS: u128 = 51;
    let c = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![
            heading(H_ROOT, None, 0, "Intro"),
            heading(H_SUB, Some(H_ROOT), 0, "Sub"),
            prose(PS, Some(H_SUB), 0, "Deep."),
        ],
    };
    let out = toggle(c, H_SUB).expect("dissolve ok").content;
    assert_eq!(kind_of(&out, H_SUB), "prose");
    assert_eq!(parent_of(&out, H_SUB), Some(UnitId(v7(H_ROOT))));
    assert_eq!(
        parent_of(&out, PS),
        Some(UnitId(v7(H_ROOT))),
        "PS lifted to the parent section"
    );
    assert_eq!(child_positions(&out, Some(H_ROOT)), vec![0, 1]);
}

#[test]
fn toggle_rejects_a_non_prose_non_heading_unit() {
    let err = toggle(content(), M).unwrap_err();
    assert!(
        matches!(err, ValidationError::ContentSaveInvalid { reason } if reason.contains("prose or heading"))
    );
}

// ── well-formedness + split ───────────────────────────────────────────────────

#[test]
fn a_well_formed_section_validates() {
    // Any valid op over the clean fixture succeeds (post-op validation passes).
    assert!(reparent(content(), X, None, 0).is_ok());
}

#[test]
fn split_of_a_body_prose_yields_a_body_continuation() {
    let input = SplitUnitInput {
        expected_revision: 1,
        unit_id: UnitId(v7(P)),
        at: 2, // "Bo" | "dy."
        new_unit_id: UnitId(v7(99)),
        propagate_taggings: vec![],
        new_tagging_ids: vec![],
    };
    let out = split_unit(content(), &input, &op_ctx(), op_now()).expect("split ok");
    let cont = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(99)))
        .expect("continuation present");
    assert_eq!(cont.slot, None, "the continuation carries no slot");
    assert_eq!(
        cont.parent_unit_id,
        Some(UnitId(v7(H_ROOT))),
        "stays in the section"
    );
    assert!(matches!(cont.content, UnitContent::Prose { .. }));
}

#[test]
fn dissolve_at_a_high_position_keeps_order_without_overflow() {
    // Review finding (dissolve-math): a heading at a near-u32::MAX position with a body child. The old
    // `position + 1 + offset` panicked in debug / wrapped to 0 in release (sorting the body BEFORE the
    // heading). The explicit document-order renumber must keep [former-heading, body] and never panic.
    let c = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![
            heading(H_ROOT, None, u32::MAX, "High"),
            prose(P, Some(H_ROOT), 0, "Body."),
        ],
    };
    let out = toggle(c, H_ROOT)
        .expect("dissolve at u32::MAX is total (no overflow panic)")
        .content;
    assert_eq!(kind_of(&out, H_ROOT), "prose");
    assert_eq!(parent_of(&out, P), None, "body lifted to top level");
    assert!(
        pos_of(&out, H_ROOT) < pos_of(&out, P),
        "former heading stays BEFORE its lifted body (no wrap-to-front)"
    );
    assert_eq!(child_positions(&out, None), vec![0, 1]);
}

// ── save_content §B relaxations (lock the two new coarse-delta paths) ──────────

#[test]
fn save_content_creates_a_prose_body_under_a_heading() {
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![heading(H_ROOT, None, 0, "Sec")],
    };
    let body = prose(P, Some(H_ROOT), 0, "a body paragraph");
    let out = save(&prior, &[body], &[]).expect("a new prose body row under a heading is allowed");
    assert_eq!(parent_of(&out.content, P), Some(UnitId(v7(H_ROOT))));
}

#[test]
fn save_content_edits_a_heading_title_freely() {
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![heading(H_ROOT, None, 0, "Intro")],
    };
    let edited = heading(H_ROOT, None, 0, "Introduction");
    let out = save(&prior, &[edited], &[]).expect("a heading title edits like prose");
    assert!(matches!(
        &out.content.units[0].content,
        UnitContent::Heading { text, .. } if text == "Introduction"
    ));
}

#[test]
fn save_content_rejects_prose_to_heading_kind_flip() {
    // The kind freeze: promotion is `toggle_heading`'s job, NEVER the coarse delta.
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![prose(X, None, 0, "x")],
    };
    let flipped = heading(X, None, 0, "x");
    let err = save(&prior, &[flipped], &[]).unwrap_err();
    assert!(matches!(err, ValidationError::ContentSaveInvalid { .. }));
}

#[test]
fn save_content_rejects_a_new_top_level_heading() {
    // A new top-level unit may only be prose / display-math / a system — never a heading (toggle_heading).
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![prose(X, None, 0, "x")],
    };
    let new_heading = heading(H2, None, 1, "New");
    let err = save(&prior, &[new_heading], &[]).unwrap_err();
    assert!(matches!(err, ValidationError::ContentSaveInvalid { .. }));
}

#[test]
fn save_content_rejects_deleting_a_heading() {
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![heading(H_ROOT, None, 0, "H")],
    };
    let err = save(&prior, &[], &[UnitId(v7(H_ROOT))]).unwrap_err();
    assert!(matches!(err, ValidationError::ContentSaveInvalid { .. }));
}

#[test]
fn save_content_rejects_a_heading_body_row_carrying_a_relation() {
    // A section-body row asserts no connective (only an Equations row may) — a smuggled row_relation
    // must fail the field-by-field expected-shape comparison.
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![heading(H_ROOT, None, 0, "Sec")],
    };
    let mut body = prose(P, Some(H_ROOT), 0, "body");
    body.row_relation = Some(RowRelation::Eq);
    let err = save(&prior, &[body], &[]).unwrap_err();
    assert!(matches!(err, ValidationError::ContentSaveInvalid { .. }));
}

// ── inline math in a heading title is reachable by the inline-aware sites ──────

#[test]
fn duplicate_expr_id_in_a_heading_title_is_detected() {
    // Review finding (wiring): expr_ids_of must include a heading title's inline math. A heading whose
    // inline expr id aliases a body Math unit's expr id is a duplicate the stability invariant must catch.
    let prior = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![
            heading_with_inline_math(H_ROOT, None, 0, E),
            math(M, H_ROOT, 0, E), // same expression id E → duplicate across two units
        ],
    };
    let err = save(&prior, &[], &[]).unwrap_err();
    assert!(
        matches!(&err, ValidationError::ContentSaveInvalid { reason } if reason.contains("more than one")),
        "duplicate expr id (heading inline vs body math) detected, got {err:?}"
    );
}

#[test]
fn rewrite_surface_reaches_inline_math_in_a_heading_title() {
    // Review finding (wiring): find_expr_in_unit_mut must search a heading title's inline; before the fix
    // rewrite_surface returned ExpressionNotFound for math living in a heading.
    let c = MathContent {
        object_id: ObjectId(v7(OBJ)),
        revision: 1,
        units: vec![heading_with_inline_math(H_ROOT, None, 0, E)],
    };
    let input = RewriteSurfaceInput {
        expected_revision: 1,
        unit_id: UnitId(v7(H_ROOT)),
        expression_id: ExpressionId(v7(E)),
        from: "x".to_string(),
        to: "y".to_string(),
    };
    let out = rewrite_surface(c, &[], &input, &op_ctx(), op_now())
        .expect("the expression is found inside the heading title (not ExpressionNotFound)");
    assert_eq!(out.content.revision, 2);
}

#[test]
fn split_of_a_heading_is_rejected() {
    // A title is not split at the core (Enter-in-a-heading is an editor gesture that spawns a body unit).
    let input = SplitUnitInput {
        expected_revision: 1,
        unit_id: UnitId(v7(H_ROOT)),
        at: 2,
        new_unit_id: UnitId(v7(99)),
        propagate_taggings: vec![],
        new_tagging_ids: vec![],
    };
    let err = split_unit(content(), &input, &op_ctx(), op_now()).unwrap_err();
    assert!(matches!(
        err,
        ValidationError::UnsplittableContentKind { .. }
    ));
}
