//! Slice 2a — the §9.y ownership prototype, tested at the PURE-CORE layer (arch doc §18.5).
//! These are the model-level half of the §9.y storage-contract matrix: re-home PRESERVES ids and
//! mutates the host; re-home ∘ dissolve is the identity (so "undo the materialization" is exact and
//! cross-boundary undo is sound); a tagged unit keeps its (id-keyed) tag through the move; dissolving
//! an object that inbound references depend on is a REVIEWABLE refusal, never a silent move; one home
//! holds (no unit in two objects). The editor-bound matrix items (copy-vs-transclude, undo *feel*,
//! chip survival) ride a real editor in 2d; the relational composite-FK cascade (handles/links) is a
//! Pass-B glue test against real Postgres. No commit — the owner stages.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use mathmeander_core::error::ValidationError;
use mathmeander_core::ids::{
    ExpressionId, ObjectId, ObjectVersionId, ProvenanceId, SpaceId, TagId, TaggingId, UnitId,
};
use mathmeander_core::model::{
    CanonicalObject, CharSpan, DeclaredBy, EmbedTarget, MathExpression, ObjectStatus, ObjectType,
    Occurrence, OccurrenceTarget, ParseStatus, SurfaceFormat, Tagging, Unit, UnitContent,
    UnitStatus, UnitType,
};
use mathmeander_core::ops::{
    DissolveObjectInput, MathContent, OpContext, RehomeSubtreeInput, dissolve_object,
    rehome_subtree,
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

const HOST: u128 = 1;
const A: u128 = 10; // a plain prose unit before the theorem
const T_ROOT: u128 = 11; // the declared theorem (a Group)
const T_STMT: u128 = 12; // theorem statement (child prose)
const T_MATH: u128 = 13; // a display expression (child math)
const T_EXPR: u128 = 14; // the math's expression id
const B: u128 = 15; // a plain prose unit after the theorem

fn host_object() -> CanonicalObject {
    CanonicalObject {
        id: ObjectId(v7(HOST)),
        object_type: ObjectType::Note,
        title: None,
        raw_source: None,
        status: ObjectStatus::Draft,
        schema_version: mathmeander_core::CURRENT_SCHEMA_VERSION,
        revision: 5,
        provenance_id: ProvenanceId(v7(50)),
        space_id: SpaceId(v7(51)),
        created_at: op_now(),
        updated_at: op_now(),
        extra: serde_json::Map::new(),
    }
}

fn prose(id: u128, parent: Option<u128>, position: u32, text: &str) -> Unit {
    Unit {
        id: UnitId(v7(id)),
        object_id: ObjectId(v7(HOST)),
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

fn theorem_group(id: u128, parent: Option<u128>, position: u32) -> Unit {
    Unit {
        unit_type: Some(UnitType::Theorem),
        content: UnitContent::Group,
        ..prose(id, parent, position, "")
    }
}

fn math_child(id: u128, parent: u128, position: u32, expr_id: u128) -> Unit {
    Unit {
        content: UnitContent::Math {
            expr: MathExpression {
                id: ExpressionId(v7(expr_id)),
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

/// A host note: prose A · the theorem (a Group with a statement + a display expression) · prose B.
/// Positions are gap-free 0..n so a renumber is idempotent (a clean identity baseline).
fn host_content() -> MathContent {
    MathContent {
        object_id: ObjectId(v7(HOST)),
        revision: 5,
        units: vec![
            prose(A, None, 0, "Before."),
            theorem_group(T_ROOT, None, 1),
            prose(
                T_STMT,
                Some(T_ROOT),
                0,
                "Every compact metric space is complete.",
            ),
            math_child(T_MATH, T_ROOT, 1, T_EXPR),
            prose(B, None, 2, "After."),
        ],
    }
}

fn rehome_input(new_type: ObjectType) -> RehomeSubtreeInput {
    RehomeSubtreeInput {
        expected_revision: 5,
        host_object: host_object(),
        host_content: host_content(),
        subtree_root: UnitId(v7(T_ROOT)),
        new_object_id: ObjectId(v7(900)),
        new_object_type: new_type,
        embed_unit_id: UnitId(v7(901)),
        new_version_id: ObjectVersionId(v7(902)),
    }
}

fn by_id(content: &MathContent) -> HashMap<UnitId, Unit> {
    content.units.iter().map(|u| (u.id, u.clone())).collect()
}

/// `by_id` with every position zeroed — for comparing structure (parent/content/type) when the
/// round-trip is expected to renormalize positions rather than preserve them exactly.
fn zeroed_positions(content: &MathContent) -> HashMap<UnitId, Unit> {
    content
        .units
        .iter()
        .map(|u| {
            let mut u = u.clone();
            u.position = 0;
            (u.id, u)
        })
        .collect()
}

fn ids(content: &MathContent) -> Vec<UnitId> {
    content.units.iter().map(|u| u.id).collect()
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[test]
fn rehome_preserves_ids_and_mutates_host() {
    let out = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now())
        .expect("producible type");

    // The new object owns the WHOLE subtree, ids PRESERVED, object_id rewritten, root re-parented.
    let new_ids = ids(&out.content);
    assert_eq!(new_ids.len(), 3, "root + statement + math moved");
    for u in &out.content.units {
        assert_eq!(
            u.object_id,
            ObjectId(v7(900)),
            "re-homed onto the new object"
        );
    }
    let root = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(T_ROOT)))
        .expect("root present, id preserved");
    assert_eq!(
        root.parent_unit_id, None,
        "root becomes top-level in the new object"
    );
    assert_eq!(
        root.unit_type,
        Some(UnitType::Theorem),
        "type carried with the unit"
    );
    // The expression id is PRESERVED — the inverse of the copy path's re-mint (§6.3a/§18.7).
    let math = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(T_MATH)))
        .unwrap();
    assert!(matches!(&math.content,
        UnitContent::Math { expr } if expr.id == ExpressionId(v7(T_EXPR))));
    assert!(
        out.expression_id_remap.is_empty(),
        "ids preserved, not re-minted"
    );

    // The host kept A and B and gained exactly one embed where the theorem was.
    let host = out
        .host_content
        .expect("a two-object write returns the mutated host");
    let host_ids = ids(&host);
    assert!(host_ids.contains(&UnitId(v7(A))) && host_ids.contains(&UnitId(v7(B))));
    let embeds: Vec<&Unit> = host
        .units
        .iter()
        .filter(|u| matches!(u.content, UnitContent::Embed { .. }))
        .collect();
    assert_eq!(embeds.len(), 1, "exactly one embed appearance");
    assert!(matches!(&embeds[0].content,
        UnitContent::Embed { target: EmbedTarget::Object { object_id } } if *object_id == ObjectId(v7(900))));
    assert_eq!(
        embeds[0].position, 1,
        "the embed stands where the theorem's root was"
    );

    // The new object row + both version snapshots are present (one transaction, Pass B).
    assert_eq!(out.new_objects.len(), 1);
    assert_eq!(out.new_objects[0].object_type, ObjectType::Theorem);
    assert_eq!(out.new_objects[0].status, ObjectStatus::Draft);
    // The new object's snapshot is its own (id, revision 1); the host's is the host at its bumped
    // revision — the two checkpoints of the one transaction.
    assert_eq!(out.version_snapshot.object_id, ObjectId(v7(900)));
    assert_eq!(out.version_snapshot.version_no, 1);
    let hv = out
        .host_version_snapshot
        .as_ref()
        .expect("a two-object write checkpoints the host too");
    assert_eq!(hv.object_id, ObjectId(v7(HOST)));
    assert_eq!(
        hv.version_no, host.revision,
        "host snapshot at the bumped revision"
    );
    assert!(
        out.links_upserted.is_empty(),
        "the embed IS the connection (no derived_from edge)"
    );
    assert!(out.objects_removed.is_empty());
}

#[test]
fn rehome_then_dissolve_restores_host_modulo_position_renumber() {
    // Undo-the-materialization. This fixture is gap-free, so positions are also preserved and the
    // restoration is byte-identical; the general claim (round-trip NORMALIZES positions, not bare
    // identity) is proven by `..._normalizes_nonzero_gap_positions` below.
    let original = host_content();
    let r = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let host_after_rehome = r.host_content.clone().unwrap();

    let dissolve = DissolveObjectInput {
        expected_revision: host_after_rehome.revision,
        expected_dissolved_revision: 1,
        host_content: host_after_rehome,
        embed_unit_id: UnitId(v7(901)),
        dissolved_object_id: ObjectId(v7(900)),
        dissolved_content: r.content.clone(),
        inbound_references: vec![],
    };
    let d = dissolve_object(&dissolve, &op_ctx(), op_now()).unwrap();

    assert_eq!(
        by_id(&d.content),
        by_id(&original),
        "round-trip restores the host (gap-free fixture ⇒ byte-identical)"
    );
    assert_eq!(d.objects_removed, vec![ObjectId(v7(900))]);
    assert!(
        d.host_content.is_none(),
        "dissolve survivor is the host (the primary content)"
    );
}

#[test]
fn rehome_then_dissolve_normalizes_nonzero_gap_positions() {
    // A host with non-gap-free top-level positions (0, 5, 10). rehome ∘ dissolve restores the same
    // units/structure but RENORMALIZES positions to gap-free reading order — so the round-trip is
    // identity modulo position-renumber, not bare identity.
    let mut original = host_content();
    for (u, pos) in original.units.iter_mut().zip([0u32, 5, 0, 1, 10]) {
        // top-level A/T_ROOT/B get 0/5/10; the two children keep 0/1
        u.position = pos;
    }
    let mut input = rehome_input(ObjectType::Theorem);
    input.host_content = original.clone();
    let r = rehome_subtree(&input, &op_ctx(), op_now()).unwrap();
    let host_after = r.host_content.clone().unwrap();
    let d = dissolve_object(
        &DissolveObjectInput {
            expected_revision: host_after.revision,
            expected_dissolved_revision: 1,
            host_content: host_after,
            embed_unit_id: UnitId(v7(901)),
            dissolved_object_id: ObjectId(v7(900)),
            dissolved_content: r.content.clone(),
            inbound_references: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();

    // Same units + structure (compare with positions zeroed)…
    assert_eq!(zeroed_positions(&d.content), zeroed_positions(&original));
    // …and top-level positions are now gap-free 0..n (normalized, not the original 0/5/10).
    let mut top: Vec<u32> = d
        .content
        .units
        .iter()
        .filter(|u| u.parent_unit_id.is_none())
        .map(|u| u.position)
        .collect();
    top.sort_unstable();
    assert_eq!(top, vec![0, 1, 2], "positions renormalized gap-free");
}

#[test]
fn a_moved_units_tag_still_resolves() {
    // A unit tagged "central" before materialization. The tagging's FK is on `tagged_unit_id`
    // (id only, db/migrations 0002), so it survives re-home for free: the unit id is preserved,
    // only its object_id changes. We assert the moved unit keeps its id (the property the FK relies
    // on); the live FK behaviour is a Pass-B integration test.
    let tagging = Tagging {
        id: TaggingId(v7(700)),
        tag_id: TagId(v7(701)),
        tagged_object_id: None,
        tagged_unit_id: Some(UnitId(v7(T_STMT))),
        created_at: op_now(),
    };
    let out = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let tagged_unit_still_exists = out
        .content
        .units
        .iter()
        .any(|u| Some(u.id) == tagging.tagged_unit_id);
    assert!(
        tagged_unit_still_exists,
        "the tagged unit kept its id, now under the new object"
    );
}

#[test]
fn dissolution_with_inbound_references_is_a_reviewable_refusal() {
    // The canonical scenario: a theorem with a `proves` edge from a proof object. Un-typing the
    // theorem must NOT silently move content — it surfaces the referencing ids for review (§9.y:1118).
    let r = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let proof_edge_id = v7(800).to_string();
    let blocked = DissolveObjectInput {
        expected_revision: r.host_content.as_ref().unwrap().revision,
        expected_dissolved_revision: 1,
        host_content: r.host_content.clone().unwrap(),
        embed_unit_id: UnitId(v7(901)),
        dissolved_object_id: ObjectId(v7(900)),
        dissolved_content: r.content.clone(),
        inbound_references: vec![proof_edge_id.clone()],
    };
    match dissolve_object(&blocked, &op_ctx(), op_now()) {
        Err(ValidationError::DissolutionBlocked { references }) => {
            assert_eq!(
                references,
                vec![proof_edge_id],
                "the refusal names the referencing edge"
            );
        }
        other => panic!("expected DissolutionBlocked, got {other:?}"),
    }
    // With no inbound references, the same dissolution succeeds — the gate is the *references*,
    // not the operation.
    let ok = DissolveObjectInput {
        inbound_references: vec![],
        ..blocked
    };
    assert!(dissolve_object(&ok, &op_ctx(), op_now()).is_ok());
}

#[test]
fn one_home_no_unit_in_two_objects() {
    let out = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let host = out.host_content.unwrap();
    let moved: std::collections::HashSet<UnitId> = out.content.units.iter().map(|u| u.id).collect();
    for u in &host.units {
        assert!(
            !moved.contains(&u.id),
            "a moved unit must not remain in the host (one home, §6.0b)"
        );
    }
}

#[test]
fn rehome_rejects_a_non_producible_type() {
    // Only the formal family materializes; the reserved source/annotation types (and `trail`) have
    // no detail machinery yet (§13a/§6.1a).
    let err = rehome_subtree(&rehome_input(ObjectType::Trail), &op_ctx(), op_now()).unwrap_err();
    assert!(matches!(err, ValidationError::TypeNotProducibleYet { .. }));
}

#[test]
fn rehome_rejects_a_surface_target() {
    // `journal_day` is PRODUCIBLE since slice 2b, but it is a §6.5 SURFACE — created via its own op
    // (`create_journal_day`), never greedy-captured. The `is_producible` lift must NOT open it as a
    // rehome target (that would mint a dateless, detail-less day, bypassing UNIQUE(space_id, date)).
    let err =
        rehome_subtree(&rehome_input(ObjectType::JournalDay), &op_ctx(), op_now()).unwrap_err();
    assert!(matches!(err, ValidationError::TypeNotMaterializable { .. }));
}

#[test]
fn rehome_unknown_root_is_not_found() {
    let mut input = rehome_input(ObjectType::Theorem);
    input.subtree_root = UnitId(v7(99999));
    let err = rehome_subtree(&input, &op_ctx(), op_now()).unwrap_err();
    assert!(matches!(err, ValidationError::UnitNotFound { .. }));
}

#[test]
fn empty_transient_theorem_dissolves_clean() {
    // The backspace-past-empty gesture: declare `Thm.`, type nothing, dissolve. A single empty
    // theorem unit re-homes then folds straight back to a plain unit — no orphan, no leftover embed.
    let host = MathContent {
        object_id: ObjectId(v7(HOST)),
        revision: 1,
        units: vec![theorem_group(T_ROOT, None, 0)],
    };
    let input = RehomeSubtreeInput {
        expected_revision: 1,
        host_object: host_object(),
        host_content: host.clone(),
        subtree_root: UnitId(v7(T_ROOT)),
        new_object_id: ObjectId(v7(900)),
        new_object_type: ObjectType::Theorem,
        embed_unit_id: UnitId(v7(901)),
        new_version_id: ObjectVersionId(v7(902)),
    };
    let r = rehome_subtree(&input, &op_ctx(), op_now()).unwrap();
    let host_after = r.host_content.clone().unwrap();
    assert_eq!(host_after.units.len(), 1, "just the embed remains");

    let d = dissolve_object(
        &DissolveObjectInput {
            expected_revision: host_after.revision,
            expected_dissolved_revision: 1,
            host_content: host_after,
            embed_unit_id: UnitId(v7(901)),
            dissolved_object_id: ObjectId(v7(900)),
            dissolved_content: r.content.clone(),
            inbound_references: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_eq!(
        by_id(&d.content),
        by_id(&host),
        "the theorem unit returns, plain and whole"
    );
    assert!(
        !d.content
            .units
            .iter()
            .any(|u| matches!(u.content, UnitContent::Embed { .. })),
        "no leftover embed"
    );
}

#[test]
fn nested_embed_survives_rehome_target_unchanged() {
    // The load-bearing "move rewrites HOME, never references" invariant: an `Embed{Object{Y}}` that
    // lives INSIDE the moved subtree keeps pointing at Y — only its own home `object_id` flips to the
    // new object. (This is the exact shape a future global object_id remap would have to respect.)
    const Y: u128 = 77; // some other object the theorem embeds
    const NESTED_EMBED: u128 = 16;
    let mut host = host_content();
    host.units.push(Unit {
        content: UnitContent::Embed {
            target: EmbedTarget::Object {
                object_id: ObjectId(v7(Y)),
            },
        },
        ..prose(NESTED_EMBED, Some(T_ROOT), 2, "")
    });
    let mut input = rehome_input(ObjectType::Theorem);
    input.host_content = host;

    let out = rehome_subtree(&input, &op_ctx(), op_now()).unwrap();
    let moved_embed = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(NESTED_EMBED)))
        .expect("the nested embed moved with the subtree");
    assert_eq!(
        moved_embed.object_id,
        ObjectId(v7(900)),
        "its HOME flipped to the new object"
    );
    assert!(
        matches!(&moved_embed.content,
            UnitContent::Embed { target: EmbedTarget::Object { object_id } } if *object_id == ObjectId(v7(Y))),
        "its TARGET is untouched — move rewrites home, never references"
    );
}

#[test]
fn rehome_preserves_occurrence_carrying_content_byte_for_byte() {
    // rehome never touches `content` — a moved unit's expression ids, surface, and occurrence
    // selectors/targets come through identical, so the edges/locators the glue re-points still
    // resolve (the source-side obligation in the op doc).
    let mut host = host_content();
    let math = host
        .units
        .iter_mut()
        .find(|u| u.id == UnitId(v7(T_MATH)))
        .unwrap();
    if let UnitContent::Math { expr } = &mut math.content {
        expr.occurrences = vec![Occurrence {
            selector: CharSpan { start: 0, end: 1 }, // in-bounds over "x"
            target: Some(OccurrenceTarget::Object {
                object_id: ObjectId(v7(77)),
            }),
        }];
    }
    let expected = math.content.clone();
    let mut input = rehome_input(ObjectType::Theorem);
    input.host_content = host;

    let out = rehome_subtree(&input, &op_ctx(), op_now()).unwrap();
    let moved = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(T_MATH)))
        .unwrap();
    assert_eq!(
        moved.content, expected,
        "occurrence-carrying content is byte-identical after re-home"
    );
}

#[test]
fn rehome_moves_a_multi_level_subtree_whole() {
    // A 3-level subtree (root → child → grandchild) moves entirely; ids preserved, the grandchild
    // keeps its parent, and nothing of the subtree remains in the host.
    const GRANDCHILD: u128 = 17;
    let mut host = host_content();
    host.units
        .push(prose(GRANDCHILD, Some(T_STMT), 0, "a deeper line")); // child of T_STMT (itself a child of T_ROOT)
    let mut input = rehome_input(ObjectType::Theorem);
    input.host_content = host;

    let out = rehome_subtree(&input, &op_ctx(), op_now()).unwrap();
    let moved_ids: std::collections::HashSet<UnitId> =
        out.content.units.iter().map(|u| u.id).collect();
    assert!(
        moved_ids.contains(&UnitId(v7(GRANDCHILD))),
        "the grandchild moved"
    );
    assert_eq!(
        out.content.units.len(),
        4,
        "root + statement + math + grandchild"
    );
    let gc = out
        .content
        .units
        .iter()
        .find(|u| u.id == UnitId(v7(GRANDCHILD)))
        .unwrap();
    assert_eq!(
        gc.parent_unit_id,
        Some(UnitId(v7(T_STMT))),
        "grandchild keeps its parent"
    );
    let host = out.host_content.unwrap();
    assert!(
        !host.units.iter().any(|u| u.id == UnitId(v7(GRANDCHILD))),
        "no part of the subtree remains in the host"
    );
}

#[test]
fn rehome_embed_inherits_the_root_slot() {
    // A subtree declared inside a container (slot = "body") keeps its container-internal role: the
    // embed standing in for it inherits the root's slot.
    let mut host = host_content();
    host.units
        .iter_mut()
        .find(|u| u.id == UnitId(v7(T_ROOT)))
        .unwrap()
        .slot = Some("body".to_string());
    let mut input = rehome_input(ObjectType::Theorem);
    input.host_content = host;

    let out = rehome_subtree(&input, &op_ctx(), op_now()).unwrap();
    let host = out.host_content.unwrap();
    let embed = host
        .units
        .iter()
        .find(|u| matches!(u.content, UnitContent::Embed { .. }))
        .unwrap();
    assert_eq!(
        embed.slot.as_deref(),
        Some("body"),
        "the embed took the root's slot"
    );
}

#[test]
fn dissolve_rejects_foreign_content() {
    // The destructive op never trusts `dissolved_content`: content not belonging to the object being
    // dissolved is a glue precondition bug, not a silent fold of foreign units.
    let r = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let mut foreign = r.content.clone();
    foreign.object_id = ObjectId(v7(424242)); // not dissolved_object_id
    let err = dissolve_object(
        &DissolveObjectInput {
            expected_revision: r.host_content.as_ref().unwrap().revision,
            expected_dissolved_revision: 1,
            host_content: r.host_content.clone().unwrap(),
            embed_unit_id: UnitId(v7(901)),
            dissolved_object_id: ObjectId(v7(900)),
            dissolved_content: foreign,
            inbound_references: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::DissolveInputInconsistent { .. }
    ));
}

#[test]
fn dissolve_rejects_a_present_but_wrong_embed() {
    // A present-but-wrong embed_unit_id is a glue inconsistency (distinct from a genuinely absent
    // embed, which is UnitNotFound).
    let r = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let err = dissolve_object(
        &DissolveObjectInput {
            expected_revision: r.host_content.as_ref().unwrap().revision,
            expected_dissolved_revision: 1,
            host_content: r.host_content.clone().unwrap(),
            embed_unit_id: UnitId(v7(A)), // a prose unit, not the embed
            dissolved_object_id: ObjectId(v7(900)),
            dissolved_content: r.content.clone(),
            inbound_references: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::DissolveInputInconsistent { .. }
    ));
}

#[test]
fn dissolve_rejects_an_absent_embed() {
    let r = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let err = dissolve_object(
        &DissolveObjectInput {
            expected_revision: r.host_content.as_ref().unwrap().revision,
            expected_dissolved_revision: 1,
            host_content: r.host_content.clone().unwrap(),
            embed_unit_id: UnitId(v7(424243)), // no such unit
            dissolved_object_id: ObjectId(v7(900)),
            dissolved_content: r.content.clone(),
            inbound_references: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert!(matches!(err, ValidationError::UnitNotFound { .. }));
}

#[test]
fn dissolve_rejects_a_fold_id_collision() {
    // A folded-back unit must not already exist in the host (one home, §6.0b) — the destructive
    // mirror of materialize's duplicate-source guard.
    let r = rehome_subtree(&rehome_input(ObjectType::Theorem), &op_ctx(), op_now()).unwrap();
    let mut host = r.host_content.clone().unwrap();
    // Inject a host unit colliding with one of the dissolved object's unit ids (T_STMT).
    host.units.push(prose(T_STMT, None, 9, "collision"));
    let err = dissolve_object(
        &DissolveObjectInput {
            expected_revision: host.revision,
            expected_dissolved_revision: 1,
            host_content: host,
            embed_unit_id: UnitId(v7(901)),
            dissolved_object_id: ObjectId(v7(900)),
            dissolved_content: r.content.clone(),
            inbound_references: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert!(matches!(err, ValidationError::UnitInMultipleObjects { .. }));
}
