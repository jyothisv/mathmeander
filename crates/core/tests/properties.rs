//! Property tests (arch doc §16): the serialize/deserialize round-trip, validation
//! totality (no panics on arbitrary input), patch semantics, and create invariants.
//! These are the heart of the §2.2 "no lost user effort" guarantee.

use chrono::{DateTime, NaiveDate, Utc};
use proptest::prelude::*;
use uuid::Uuid;

use mathmeander_core::ids::{ObjectId, ProvenanceId, SpaceId};
use mathmeander_core::model::{CanonicalObject, ObjectStatus, ObjectType, Origin};
use mathmeander_core::patch::Patch;
use mathmeander_core::validate::{
    CreateContext, CreateObjectInput, MAX_TITLE_CHARS, ObjectPatch, apply_title_patch,
    create_journal_day, create_object,
};

// ── Slice 1c canonical-operation imports (the expression-id stability matrix) ──
use mathmeander_core::error::ValidationError;
use mathmeander_core::ids::{ExpressionId, LinkId, ObjectVersionId, TagId, TaggingId, UnitId};
use mathmeander_core::model::{
    CharSpan, ContentLocator, DeclaredBy, ExtractedStructureEnvelope, Inline, Link, LinkStatus,
    LinkType, MathExpression, Occurrence, OccurrenceTarget, ParseStatus, SurfaceFormat, Tagging,
    Unit, UnitContent, UnitStatus, UnitType,
};
use mathmeander_core::ops::{
    ExpressionIdRemap, InsertReferenceInput, LinkDraft, MaterializeObjectInput, MathContent,
    MergeUnitsInput, OpContext, ResolveOccurrenceInput, ResolveTarget, RewriteSurfaceInput,
    SetUnitTypeInput, SplitUnitInput, ToggleExpressionPlacementInput, UnitIdRemap,
    insert_reference, materialize_object, merge_units, resolve_occurrence, rewrite_surface,
    save_content, set_unit_type, split_unit, toggle_expression_placement,
};

fn arb_uuid() -> impl Strategy<Value = Uuid> {
    any::<u128>().prop_map(Uuid::from_u128)
}

fn arb_uuid_v7() -> impl Strategy<Value = Uuid> {
    any::<u128>().prop_map(|bits| {
        // Force version 7 + RFC variant bits.
        let bits = (bits & !(0xF << 76)) | (0x7 << 76);
        let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
        Uuid::from_u128(bits)
    })
}

/// A uuid whose version is forced to 4 — never v7. Generating directly (vs `arb_uuid()` +
/// `prop_assume!(v != 7)`) keeps the test from exhausting proptest's global reject budget at
/// high case counts.
fn arb_uuid_non_v7() -> impl Strategy<Value = Uuid> {
    any::<u128>().prop_map(|bits| Uuid::from_u128((bits & !(0xF << 76)) | (0x4 << 76)))
}

fn arb_datetime() -> impl Strategy<Value = DateTime<Utc>> {
    (0i64..=4_102_444_800, 0u32..1_000_000_000)
        .prop_map(|(secs, nanos)| DateTime::from_timestamp(secs, nanos).expect("in range"))
}

fn arb_status() -> impl Strategy<Value = ObjectStatus> {
    prop_oneof![
        Just(ObjectStatus::Raw),
        Just(ObjectStatus::Draft),
        Just(ObjectStatus::AiDrafted),
        Just(ObjectStatus::UserVerified),
        Just(ObjectStatus::Trusted),
        Just(ObjectStatus::NeedsReview),
        Just(ObjectStatus::Deprecated),
    ]
}

/// Tri-state titles: unset, explicitly empty, and arbitrary unicode values.
fn arb_title() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        Just(None),
        Just(Some(String::new())),
        any::<String>().prop_map(Some),
    ]
}

/// Foreign fields that must survive round trips. Keys are prefixed so they can never
/// collide with real field names.
fn arb_extra() -> impl Strategy<Value = serde_json::Map<String, serde_json::Value>> {
    proptest::collection::vec(("[a-z]{1,8}", any::<i64>()), 0..3).prop_map(|pairs| {
        pairs
            .into_iter()
            .map(|(k, v)| (format!("x_{k}"), serde_json::json!(v)))
            .collect()
    })
}

prop_compose! {
    fn arb_object()(
        id in arb_uuid(),
        title in arb_title(),
        raw_source in arb_title(),
        status in arb_status(),
        revision in 1u32..u32::MAX,
        provenance_id in arb_uuid(),
        space_id in arb_uuid(),
        created_at in arb_datetime(),
        updated_at in arb_datetime(),
        extra in arb_extra(),
    ) -> CanonicalObject {
        CanonicalObject {
            id: ObjectId(id),
            object_type: ObjectType::Note,
            title,
            raw_source,
            status,
            schema_version: mathmeander_core::CURRENT_SCHEMA_VERSION,
            revision,
            provenance_id: ProvenanceId(provenance_id),
            space_id: SpaceId(space_id),
            created_at,
            updated_at,
            extra,
        }
    }
}

/// Arbitrary JSON for totality tests (depth-limited).
fn arb_json() -> impl Strategy<Value = serde_json::Value> {
    let leaf = prop_oneof![
        Just(serde_json::Value::Null),
        any::<bool>().prop_map(serde_json::Value::from),
        any::<i64>().prop_map(serde_json::Value::from),
        any::<String>().prop_map(serde_json::Value::from),
    ];
    leaf.prop_recursive(3, 24, 4, |inner| {
        prop_oneof![
            proptest::collection::vec(inner.clone(), 0..4).prop_map(serde_json::Value::from),
            proptest::collection::btree_map("[a-z_]{1,12}", inner, 0..4)
                .prop_map(|m| serde_json::Value::Object(m.into_iter().collect())),
        ]
    })
}

proptest! {
    /// deserialize(serialize(x)) == x — including tri-state titles (None ≠ Some(""))
    /// and foreign `extra` fields (§2.2 preservation).
    #[test]
    fn object_serde_round_trip(object in arb_object()) {
        let json = serde_json::to_string(&object).expect("serializes");
        let back: CanonicalObject = serde_json::from_str(&json).expect("deserializes");
        prop_assert_eq!(back, object);
    }

    /// The FFI read path never panics, whatever JSON (or non-JSON) arrives.
    #[test]
    fn parse_and_migrate_is_total_on_json(value in arb_json()) {
        let envelope = mathmeander_core::api::parse_and_migrate_object(&value.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        prop_assert!(parsed["ok"].is_boolean());
    }

    #[test]
    fn parse_and_migrate_is_total_on_garbage(input in any::<String>()) {
        let envelope = mathmeander_core::api::parse_and_migrate_object(&input);
        let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
        prop_assert!(parsed["ok"].is_boolean());
    }

    /// Patch semantics: absent keeps, null clears, value sets; revision strictly
    /// increments; updated_at becomes now; everything else untouched.
    #[test]
    fn title_patch_semantics(
        object in arb_object(),
        patch_title in prop_oneof![
            Just(Patch::Absent),
            Just(Patch::Clear),
            Just(Patch::Set(String::new())),
            "[\\PC]{0,64}".prop_map(Patch::Set),
        ],
        now in arb_datetime(),
    ) {
        prop_assume!(object.revision < u32::MAX);
        let patch = ObjectPatch { expected_revision: object.revision, title: patch_title.clone() };
        let next = apply_title_patch(&object, &patch, now).expect("valid patch applies");

        match patch_title {
            Patch::Absent => prop_assert_eq!(&next.title, &object.title),
            Patch::Clear => prop_assert_eq!(&next.title, &None),
            Patch::Set(v) => prop_assert_eq!(&next.title, &Some(v)),
        }
        prop_assert_eq!(next.revision, object.revision + 1);
        prop_assert_eq!(next.updated_at, now);
        prop_assert_eq!(next.created_at, object.created_at);
        prop_assert_eq!(&next.raw_source, &object.raw_source);
        prop_assert_eq!(next.id, object.id);
        prop_assert_eq!(&next.extra, &object.extra);
    }

    /// Create stamps what the core owns and preserves what the user gave — verbatim.
    #[test]
    fn create_object_invariants(
        id in arb_uuid_v7(),
        provenance_id in arb_uuid_v7(),
        space_id in arb_uuid(),
        title in arb_title(),
        raw_source in arb_title(),
        now in arb_datetime(),
    ) {
        prop_assume!(title.as_ref().is_none_or(|t| t.chars().count() as u32 <= MAX_TITLE_CHARS));
        let input = CreateObjectInput {
            id: id.to_string(),
            object_type: "note".into(),
            title: title.clone(),
            raw_source: raw_source.clone(),
        };
        let ctx = CreateContext {
            provenance_id: provenance_id.to_string(),
            origin: Origin::User,
            created_by: Some("user-1".into()),
        };
        let (object, provenance) =
            create_object(&input, &ctx, &space_id.to_string(), now).expect("valid create");

        prop_assert_eq!(object.id, ObjectId(id));
        prop_assert_eq!(object.status, ObjectStatus::Draft);
        prop_assert_eq!(object.schema_version, mathmeander_core::CURRENT_SCHEMA_VERSION);
        prop_assert_eq!(object.revision, 1);
        prop_assert_eq!(&object.title, &title);          // Some("") stays Some("")
        prop_assert_eq!(&object.raw_source, &raw_source); // verbatim, byte for byte
        prop_assert_eq!(object.created_at, now);
        prop_assert_eq!(object.provenance_id, provenance.id);
        prop_assert_eq!(provenance.occurred_at, now);
    }

    /// Non-v7 ids are rejected with the TYPED error (the §6.3 client-mintable check).
    #[test]
    fn create_rejects_non_v7_ids(id in arb_uuid_non_v7(), provenance_id in arb_uuid_v7(), now in arb_datetime()) {
        let input = CreateObjectInput {
            id: id.to_string(),
            object_type: "note".into(),
            title: None,
            raw_source: None,
        };
        let ctx = CreateContext {
            provenance_id: provenance_id.to_string(),
            origin: Origin::User,
            created_by: Some("user-1".into()),
        };
        let err = create_object(&input, &ctx, &Uuid::nil().to_string(), now)
            .expect_err("non-v7 id must be rejected");
        let code = serde_json::to_value(&err).expect("err serializes");
        prop_assert_eq!(code["code"].as_str(), Some("not_uuid_v7"));
    }
}

#[test]
fn create_enforces_origin_invariants() {
    let now = DateTime::from_timestamp(1_780_000_000, 0).expect("in range");
    let base_input = CreateObjectInput {
        id: "0197675f-71f4-7000-8000-000000000001".into(),
        object_type: "note".into(),
        title: None,
        raw_source: None,
    };
    let space = "0197675f-71f4-7000-8000-000000000003";

    // user without created_by → missing_created_by (§6.1a)
    let ctx = CreateContext {
        provenance_id: "0197675f-71f4-7000-8000-000000000002".into(),
        origin: Origin::User,
        created_by: None,
    };
    let err = create_object(&base_input, &ctx, space, now).expect_err("must fail");
    assert_eq!(
        serde_json::to_value(&err).expect("serializes")["code"],
        "missing_created_by"
    );

    // ai / imported are not producible yet (§6.1)
    for origin in [Origin::Ai, Origin::Imported] {
        let ctx = CreateContext {
            provenance_id: "0197675f-71f4-7000-8000-000000000002".into(),
            origin,
            created_by: Some("x".into()),
        };
        let err = create_object(&base_input, &ctx, space, now).expect_err("must fail");
        assert_eq!(
            serde_json::to_value(&err).expect("serializes")["code"],
            "origin_not_producible"
        );
    }

    // unknown type → typed error with the offending value (`theorem` is now valid
    // vocabulary, so use a genuinely unknown one)
    let mut input = base_input.clone();
    input.object_type = "frobnicate".into();
    let ctx = CreateContext {
        provenance_id: "0197675f-71f4-7000-8000-000000000002".into(),
        origin: Origin::User,
        created_by: Some("u".into()),
    };
    let err = create_object(&input, &ctx, space, now).expect_err("must fail");
    assert_eq!(
        serde_json::to_value(&err).expect("serializes")["code"],
        "unknown_object_type"
    );

    // formal family: producible (via materialize), but NOT by direct create — it enters by
    // declaration → materialization (§9.y, slice 2). Distinct from the reserved tier below.
    let mut input = base_input.clone();
    input.object_type = "theorem".into();
    let err = create_object(&input, &ctx, space, now).expect_err("theorem is declaration-only");
    let err = serde_json::to_value(&err).expect("serializes");
    assert_eq!(err["code"], "type_not_directly_creatable");
    assert_eq!(err["object_type"], "theorem");

    // reserved vocabulary (valid on read, not producible yet) → typed error (§6.1a)
    let mut input = base_input;
    input.object_type = "trail".into();
    let err = create_object(&input, &ctx, space, now).expect_err("must fail");
    assert_eq!(
        serde_json::to_value(&err).expect("serializes")["code"],
        "type_not_producible_yet"
    );
}

/// §6.5 / slice 2b: `journal_day` is PRODUCIBLE (it joined the producible set) but NOT
/// directly-creatable — so the plain typed POST path still refuses it (the §9.y declaration
/// rule), while the dedicated surface accepts it. This is the producibility shift the lift hinges
/// on; the direct-create gate must stay narrower than producibility.
#[test]
fn journal_day_is_producible_but_not_directly_creatable() {
    assert!(ObjectType::JournalDay.is_producible());
    assert!(!ObjectType::JournalDay.is_directly_creatable());

    let now = DateTime::from_timestamp(1_780_000_000, 0).expect("in range");
    let input = CreateObjectInput {
        id: "0197675f-71f4-7000-8000-0000000000b1".into(),
        object_type: "journal_day".into(),
        title: None,
        raw_source: None,
    };
    let ctx = CreateContext {
        provenance_id: "0197675f-71f4-7000-8000-000000000002".into(),
        origin: Origin::User,
        created_by: Some("u".into()),
    };
    let space = "0197675f-71f4-7000-8000-000000000003";
    // The plain create path: producible, so NOT type_not_producible_yet — but gated as
    // declaration-only (the surface, not a raw POST).
    let err = create_object(&input, &ctx, space, now).expect_err("journal_day is surface-only");
    let err = serde_json::to_value(&err).expect("serializes");
    assert_eq!(err["code"], "type_not_directly_creatable");
    assert_eq!(err["object_type"], "journal_day");
}

/// The §6.5 surface stamps exactly what `create_object` does (Draft / rev 1 / CURRENT / `now`),
/// preserves the client's id verbatim, and carries the PASSED-IN date into the detail (the core
/// reads no clock) — the detail's `object_id` matches the object so the glue persists a consistent
/// triplet.
#[test]
fn create_journal_day_stamps_and_carries_date() {
    let now = DateTime::from_timestamp(1_780_000_000, 0).expect("in range");
    let date = NaiveDate::from_ymd_opt(2026, 6, 18).expect("valid date");
    let input = CreateObjectInput {
        id: "0197675f-71f4-7000-8000-0000000000b1".into(),
        object_type: "journal_day".into(),
        title: None,
        raw_source: None,
    };
    let ctx = CreateContext {
        provenance_id: "0197675f-71f4-7000-8000-000000000002".into(),
        origin: Origin::User,
        created_by: Some("u".into()),
    };
    let space = "0197675f-71f4-7000-8000-000000000003";

    let (object, provenance, detail) =
        create_journal_day(&input, &ctx, space, date, now).expect("valid journal_day create");

    assert_eq!(object.object_type, ObjectType::JournalDay);
    assert_eq!(object.status, ObjectStatus::Draft);
    assert_eq!(
        object.schema_version,
        mathmeander_core::CURRENT_SCHEMA_VERSION
    );
    assert_eq!(object.revision, 1);
    assert_eq!(object.created_at, now);
    assert_eq!(object.provenance_id, provenance.id);
    assert_eq!(provenance.occurred_at, now);
    assert_eq!(provenance.origin, Origin::User);
    // The date rides into the detail, keyed by the object's own id (§6.5 — date is identity).
    assert_eq!(detail.object_id, object.id);
    assert_eq!(detail.date, date);
}

/// The surface mints journal_days ONLY: a wrong type (a glue bug — the route always supplies
/// `journal_day`) is the type-qualified detail mismatch SQL can't FK-check (§6.1a), a 500 code,
/// never silently accepted.
#[test]
fn create_journal_day_rejects_wrong_type() {
    let now = DateTime::from_timestamp(1_780_000_000, 0).expect("in range");
    let date = NaiveDate::from_ymd_opt(2026, 6, 18).expect("valid date");
    let input = CreateObjectInput {
        id: "0197675f-71f4-7000-8000-0000000000b1".into(),
        object_type: "note".into(), // not journal_day
        title: None,
        raw_source: None,
    };
    let ctx = CreateContext {
        provenance_id: "0197675f-71f4-7000-8000-000000000002".into(),
        origin: Origin::User,
        created_by: Some("u".into()),
    };
    let space = "0197675f-71f4-7000-8000-000000000003";
    let err = create_journal_day(&input, &ctx, space, date, now).expect_err("wrong type refused");
    let err = serde_json::to_value(&err).expect("serializes");
    assert_eq!(err["code"], "detail_type_mismatch");
    assert_eq!(err["expected"], "journal_day");
    assert_eq!(err["given"], "note");
}

/// The FFI boundary parses the date string (like `now`): a malformed date is a TYPED
/// `malformed_input` envelope, never a panic or an opaque serde failure (§17).
#[test]
fn api_create_journal_day_rejects_bad_date() {
    let input = serde_json::json!({
        "id": "0197675f-71f4-7000-8000-0000000000b1",
        "type": "journal_day", "title": null, "raw_source": null
    })
    .to_string();
    let ctx = serde_json::json!({
        "provenance_id": "0197675f-71f4-7000-8000-000000000002",
        "origin": "user", "created_by": "u"
    })
    .to_string();
    let space = "0197675f-71f4-7000-8000-000000000003";
    let now = "2026-06-18T00:00:00Z";

    let envelope =
        mathmeander_core::api::create_journal_day(&input, &ctx, space, "2026-13-40", now);
    let parsed: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
    assert_eq!(parsed["ok"], false);
    // CoreError is tagged `kind`; MalformedInput carries the boundary `context`.
    assert_eq!(parsed["error"]["kind"], "malformed_input");
    assert_eq!(parsed["error"]["context"], "date");

    // And the happy path through the FFI yields a well-formed CreateJournalDayResult.
    let ok = mathmeander_core::api::create_journal_day(&input, &ctx, space, "2026-06-18", now);
    let ok: serde_json::Value = serde_json::from_str(&ok).expect("envelope is JSON");
    assert_eq!(ok["ok"], true);
    assert_eq!(ok["value"]["detail"]["date"], "2026-06-18");
    assert_eq!(ok["value"]["object"]["type"], "journal_day");
}

// ════════════════════════════════════════════════════════════════════════════════
// Slice 1c — the expression-id stability matrix (arch doc §6.3a/§13a)
//
// The load-bearing invariant: split/merge/toggle PRESERVE expression ids (empty remap);
// only materialize_object mints fresh ones (a populated remap). Plus: rewrite_surface
// re-anchors-or-stales (never wrong) while keeping `id`+`original_input` verbatim; the ops
// are TOTAL (typed errors, never panics); and `expected_revision` is echoed, never gated.
// ════════════════════════════════════════════════════════════════════════════════

/// A v7 uuid with a caller-chosen low payload (distinct tags ⇒ distinct ids).
fn v7(tag: u128) -> Uuid {
    let bits = (tag & !(0xF << 76)) | (0x7 << 76);
    let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
    Uuid::from_u128(bits)
}

fn op_ctx() -> OpContext {
    OpContext {
        provenance_id: ProvenanceId(v7(100)),
        version_id: ObjectVersionId(v7(101)),
    }
}

fn op_now() -> DateTime<Utc> {
    DateTime::from_timestamp(1_780_000_000, 0).expect("in range")
}

fn an_expr(id: ExpressionId, surface: &str, occurrences: Vec<Occurrence>) -> MathExpression {
    MathExpression {
        id,
        surface_text: surface.to_string(),
        surface_format: SurfaceFormat::Mathmeander,
        input_syntax: None,
        original_input: surface.to_string(),
        parse_status: ParseStatus::Renderable,
        occurrences,
    }
}

fn a_prose_unit(
    id: UnitId,
    object_id: ObjectId,
    position: u32,
    text: &str,
    inline: Vec<Inline>,
) -> Unit {
    Unit {
        id,
        object_id,
        parent_unit_id: None,
        position,
        slot: None,
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

fn a_math_unit(id: UnitId, object_id: ObjectId, position: u32, expr: MathExpression) -> Unit {
    Unit {
        id,
        object_id,
        parent_unit_id: None,
        position,
        slot: None,
        unit_type: None,
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content: UnitContent::Math { expr },
        provenance_id: ProvenanceId(v7(9)),
    }
}

fn an_object(id: ObjectId) -> CanonicalObject {
    CanonicalObject {
        id,
        object_type: ObjectType::Note,
        title: None,
        raw_source: None,
        status: ObjectStatus::Draft,
        schema_version: mathmeander_core::CURRENT_SCHEMA_VERSION,
        revision: 1,
        provenance_id: ProvenanceId(v7(50)),
        space_id: SpaceId(v7(51)),
        created_at: op_now(),
        updated_at: op_now(),
        extra: serde_json::Map::new(),
    }
}

/// Every expression id in the content, sorted — the multiset the stability laws compare.
fn expr_id_multiset(content: &MathContent) -> Vec<ExpressionId> {
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
    ids.sort_by_key(|e| e.0);
    ids
}

fn expr_of(content: &MathContent, id: ExpressionId) -> &MathExpression {
    for u in &content.units {
        match &u.content {
            UnitContent::Math { expr } if expr.id == id => return expr,
            UnitContent::Prose { inline, .. } => {
                for el in inline {
                    if let Inline::Math { expr, .. } = el
                        && expr.id == id
                    {
                        return expr;
                    }
                }
            }
            _ => {}
        }
    }
    panic!("expression {id} not found in content");
}

fn err_code(e: &ValidationError) -> String {
    serde_json::to_value(e).expect("error serializes")["code"]
        .as_str()
        .expect("code is a string")
        .to_string()
}

/// Structural well-formedness after an op: per-parent positions are gap-free 0..n, every inline
/// span is within its prose `text` bounds, and every `Math`/`Reference` atom is zero-width (the
/// §6.0 contract). The single invariant the structural-op tests assert.
fn assert_content_well_formed(content: &MathContent) {
    use std::collections::HashMap;
    // Positions: gap-free 0..n within each parent.
    let mut by_parent: HashMap<Option<UnitId>, Vec<u32>> = HashMap::new();
    for u in &content.units {
        by_parent
            .entry(u.parent_unit_id)
            .or_default()
            .push(u.position);
    }
    for (parent, mut ps) in by_parent {
        ps.sort_unstable();
        let expected: Vec<u32> = (0..ps.len() as u32).collect();
        assert_eq!(
            ps, expected,
            "positions not gap-free 0..n under parent {parent:?}"
        );
    }
    // Inline spans: in-bounds; atoms zero-width.
    for u in &content.units {
        if let UnitContent::Prose { text, inline } = &u.content {
            let len = text.chars().count() as u32;
            for el in inline {
                let (span, is_atom) = match el {
                    Inline::Mark { span, .. } => (*span, false),
                    Inline::Math { span, .. } | Inline::Reference { span, .. } => (*span, true),
                };
                assert!(
                    span.start <= span.end && span.end <= len,
                    "inline span {span:?} out of bounds for text len {len}"
                );
                if is_atom {
                    assert_eq!(
                        span.start, span.end,
                        "inline atom must be zero-width: {span:?}"
                    );
                }
            }
        }
    }
}

// ── Strategies ──────────────────────────────────────────────────────────────

prop_compose! {
    /// A single prose unit (id v7(2), object v7(1)) with 0..4 inline-math elements, each a
    /// distinct expression id — plus that id list, to compare before/after a split.
    fn arb_inline_math_prose()(
        text_len in 1usize..12,
        starts in proptest::collection::vec(0u32..12, 0..4),
    ) -> (MathContent, Vec<ExpressionId>) {
        let text: String = "abcdefghijkl".chars().take(text_len).collect();
        let tl = text.chars().count() as u32;
        let mut inline = Vec::new();
        let mut ids = Vec::new();
        for (i, raw) in starts.iter().enumerate() {
            let eid = ExpressionId(v7(6000 + i as u128));
            let start = (*raw).min(tl); // zero-width atom position, anywhere in [0, len]
            ids.push(eid);
            inline.push(Inline::Math { span: CharSpan::new(start, start), expr: an_expr(eid, "x", vec![]) });
        }
        let unit = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, &text, inline);
        (MathContent { object_id: ObjectId(v7(1)), revision: 5, units: vec![unit] }, ids)
    }
}

prop_compose! {
    /// Two adjacent prose siblings (v7(2) @0, v7(3) @1), each with 0..3 inline maths.
    fn arb_two_prose()(k1 in 0usize..3, k2 in 0usize..3) -> (MathContent, Vec<ExpressionId>) {
        let mut ids = Vec::new();
        let mut ctr = 6100u128;
        let mut inline1 = Vec::new();
        for _ in 0..k1 {
            let e = ExpressionId(v7(ctr));
            ctr += 1;
            ids.push(e);
            inline1.push(Inline::Math { span: CharSpan::new(0, 0), expr: an_expr(e, "x", vec![]) });
        }
        let mut inline2 = Vec::new();
        for _ in 0..k2 {
            let e = ExpressionId(v7(ctr));
            ctr += 1;
            ids.push(e);
            inline2.push(Inline::Math { span: CharSpan::new(0, 0), expr: an_expr(e, "x", vec![]) });
        }
        let u1 = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "ab", inline1);
        let u2 = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, "cd", inline2);
        (MathContent { object_id: ObjectId(v7(1)), revision: 1, units: vec![u1, u2] }, ids)
    }
}

prop_compose! {
    /// A prose unit (v7(2)) holding exactly one inline math (id v7(70)).
    fn arb_prose_with_one_math()(text_len in 1usize..8, start in 0u32..8) -> MathContent {
        let text: String = "abcdefgh".chars().take(text_len).collect();
        let tl = text.chars().count() as u32;
        let s = start.min(tl); // zero-width atom position
        let unit = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, &text,
            vec![Inline::Math { span: CharSpan::new(s, s), expr: an_expr(ExpressionId(v7(70)), "x", vec![]) }]);
        MathContent { object_id: ObjectId(v7(1)), revision: 1, units: vec![unit] }
    }
}

#[derive(Debug, Clone)]
enum UnitSpec {
    Math,
    Prose(usize),
}

fn arb_unit_spec() -> impl Strategy<Value = UnitSpec> {
    prop_oneof![Just(UnitSpec::Math), (0usize..3).prop_map(UnitSpec::Prose)]
}

prop_compose! {
    /// Source content for materialize: 1..5 units, unique unit ids, unique expression ids,
    /// contiguous positions — a copy-able aggregate.
    fn arb_source_content()(specs in proptest::collection::vec(arb_unit_spec(), 1..5)) -> MathContent {
        let mut units = Vec::new();
        let mut expr_ctr = 5000u128;
        for (i, spec) in specs.iter().enumerate() {
            let uid = UnitId(v7(1000 + i as u128));
            let unit = match spec {
                UnitSpec::Math => {
                    let e = ExpressionId(v7(expr_ctr));
                    expr_ctr += 1;
                    a_math_unit(uid, ObjectId(v7(1)), i as u32, an_expr(e, "x", vec![]))
                }
                UnitSpec::Prose(k) => {
                    let mut inline = Vec::new();
                    for _ in 0..*k {
                        let e = ExpressionId(v7(expr_ctr));
                        expr_ctr += 1;
                        inline.push(Inline::Math { span: CharSpan::new(0, 0), expr: an_expr(e, "x", vec![]) });
                    }
                    a_prose_unit(uid, ObjectId(v7(1)), i as u32, "ab", inline)
                }
            };
            units.push(unit);
        }
        MathContent { object_id: ObjectId(v7(1)), revision: 1, units }
    }
}

// ── Expression-id stability (split / merge / toggle PRESERVE; materialize MINTS) ──

proptest! {
    /// Splitting a prose unit preserves every expression id (empty remap), keeps positions
    /// gap-free, and bumps the revision. Out-of-range `at` returns a typed error (not Ok).
    #[test]
    fn split_preserves_expression_ids((content, ids) in arb_inline_math_prose(), at in 0u32..15) {
        let mut expected = ids.clone();
        expected.sort_by_key(|e| e.0);
        let input = SplitUnitInput {
            expected_revision: 5,
            unit_id: UnitId(v7(2)),
            at,
            new_unit_id: UnitId(v7(3)),
            propagate_taggings: vec![],
            new_tagging_ids: vec![],
        };
        if let Ok(out) = split_unit(content, &input, &op_ctx(), op_now()) {
            prop_assert!(out.expression_id_remap.is_empty());
            prop_assert_eq!(expr_id_multiset(&out.content), expected);
            prop_assert_eq!(out.content.units.len(), 2);
            assert_content_well_formed(&out.content);
            prop_assert_eq!(out.content.revision, 6);
        }
    }

    /// Merging two adjacent prose siblings preserves every expression id (empty remap),
    /// collapses to one unit at position 0, and bumps the revision.
    #[test]
    fn merge_preserves_expression_ids((content, ids) in arb_two_prose()) {
        let mut expected = ids.clone();
        expected.sort_by_key(|e| e.0);
        let input = MergeUnitsInput {
            expected_revision: 1,
            first_unit_id: UnitId(v7(2)),
            second_unit_id: UnitId(v7(3)),
        };
        let out = merge_units(content, &[], &input, &op_ctx(), op_now()).expect("adjacent prose merge");
        prop_assert!(out.expression_id_remap.is_empty());
        prop_assert_eq!(expr_id_multiset(&out.content), expected);
        prop_assert_eq!(out.content.units.len(), 1);
        assert_content_well_formed(&out.content);
        prop_assert_eq!(out.content.revision, 2);
    }

    /// Toggling an inline expression to display preserves its id (empty remap) and keeps
    /// positions gap-free; the expression now lives in a standalone `Math` unit.
    #[test]
    fn toggle_inline_to_display_preserves_id(content in arb_prose_with_one_math()) {
        let e = ExpressionId(v7(70));
        let input = ToggleExpressionPlacementInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            display_unit_id: UnitId(v7(3)),
            trailing_unit_id: UnitId(v7(4)),
        };
        let out = toggle_expression_placement(content, &input, &op_ctx(), op_now()).expect("toggle");
        prop_assert!(out.expression_id_remap.is_empty());
        prop_assert_eq!(expr_id_multiset(&out.content), vec![e]);
        let has_display = out
            .content
            .units
            .iter()
            .any(|u| matches!(&u.content, UnitContent::Math { expr } if expr.id == e));
        prop_assert!(has_display);
        assert_content_well_formed(&out.content);
    }

    /// materialize_object mints FRESH expression ids: the copy's ids are disjoint from the
    /// source's, the remap is the full applied bijection, the source is untouched, and the
    /// copy carries exactly one `derived_from` edge back to the origin.
    #[test]
    fn materialize_mints_fresh_expression_ids(source in arb_source_content()) {
        let src_exprs = expr_id_multiset(&source);
        let expr_id_map: Vec<ExpressionIdRemap> = src_exprs
            .iter()
            .enumerate()
            .map(|(i, e)| ExpressionIdRemap { from: *e, to: ExpressionId(v7(9000 + i as u128)) })
            .collect();
        let unit_id_map: Vec<UnitIdRemap> = source
            .units
            .iter()
            .enumerate()
            .map(|(i, u)| UnitIdRemap { from: u.id, to: UnitId(v7(8000 + i as u128)) })
            .collect();
        let input = MaterializeObjectInput {
            expected_revision: 1,
            source_object: an_object(ObjectId(v7(1))),
            source_content: source.clone(),
            new_object_id: ObjectId(v7(2)),
            new_provenance_id: ProvenanceId(v7(102)),
            edge_link_id: LinkId(v7(103)),
            expr_id_map,
            unit_id_map,
        };
        let out = materialize_object(&input, &op_ctx(), op_now()).expect("total maps");
        let new_exprs = expr_id_multiset(&out.content);
        for e in &new_exprs {
            prop_assert!(!src_exprs.contains(e), "copied id collides with source");
        }
        prop_assert_eq!(new_exprs.len(), src_exprs.len());
        prop_assert_eq!(out.expression_id_remap.len(), src_exprs.len());
        for r in &out.expression_id_remap {
            prop_assert!(src_exprs.contains(&r.from));
            prop_assert!(!src_exprs.contains(&r.to));
        }
        prop_assert_eq!(&input.source_content, &source); // source untouched
        prop_assert_eq!(out.new_objects.len(), 1);
        prop_assert_eq!(out.links_upserted.len(), 1);
        prop_assert_eq!(out.links_upserted[0].link_type, LinkType::DerivedFrom);
        prop_assert_eq!(out.content.revision, 1);
    }

    /// Totality: ops return typed errors (never panic) on hostile ids / offsets / indices.
    #[test]
    fn ops_never_panic_on_hostile_input(uid in arb_uuid(), at in any::<u32>(), idx in any::<u32>()) {
        let e = ExpressionId(v7(70));
        let content = || MathContent {
            object_id: ObjectId(v7(1)),
            revision: 1,
            units: vec![
                a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "ab", vec![]),
                a_math_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, an_expr(e, "x", vec![Occurrence { selector: CharSpan::new(0, 1), target: None }])),
            ],
        };
        let _ = set_unit_type(content(), &SetUnitTypeInput { expected_revision: 1, unit_id: UnitId(uid), unit_type: Patch::Set(UnitType::Lemma) }, &op_ctx(), op_now());
        let _ = split_unit(content(), &SplitUnitInput { expected_revision: 1, unit_id: UnitId(uid), at, new_unit_id: UnitId(v7(50)), propagate_taggings: vec![], new_tagging_ids: vec![] }, &op_ctx(), op_now());
        let _ = resolve_occurrence(content(), &ResolveOccurrenceInput { expected_revision: 1, unit_id: UnitId(v7(3)), expression_id: e, occurrence_index: idx, link_id: LinkId(v7(80)), target: ResolveTarget::Object { object_id: ObjectId(v7(9)) } }, &op_ctx(), op_now());
        prop_assert!(true); // reaching here ⇒ no panic
    }
}

// ── rewrite_surface, insert_reference, resolve_occurrence, materialize (targeted) ──

#[test]
fn rewrite_surface_remaps_then_stales() {
    let e = ExpressionId(v7(70));
    let mk_content = || MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![a_math_unit(
            UnitId(v7(2)),
            ObjectId(v7(1)),
            0,
            an_expr(
                e,
                "x + y",
                vec![Occurrence {
                    selector: CharSpan::new(0, 1),
                    target: None,
                }],
            ),
        )],
    };
    let link = Link {
        id: LinkId(v7(80)),
        source_object_id: ObjectId(v7(1)),
        target_object_id: Some(ObjectId(v7(9))),
        target_unit_id: None,
        unresolved_text: None,
        target_selector: None,
        link_type: LinkType::Related,
        status: LinkStatus::Active,
        from_content: true,
        source_unit_id: Some(UnitId(v7(2))),
        content_locator: Some(ContentLocator::ExpressionSpan {
            expression_id: e,
            start: 0,
            end: 1,
        }),
        provenance_id: ProvenanceId(v7(9)),
        created_at: op_now(),
    };

    // Structure-preserving rename x → z: the anchor re-anchors, never stales.
    let out = rewrite_surface(
        mk_content(),
        std::slice::from_ref(&link),
        &RewriteSurfaceInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            from: "x".into(),
            to: "z".into(),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    let me = expr_of(&out.content, e);
    assert_eq!(me.id, e, "expression id preserved");
    assert_eq!(me.original_input, "x + y", "original_input verbatim");
    assert_eq!(me.surface_text, "z + y");
    assert!(out.links_staled.is_empty());
    assert_eq!(out.links_upserted.len(), 1);
    assert_eq!(out.links_upserted[0].status, LinkStatus::Active);
    assert!(matches!(
        out.links_upserted[0].content_locator,
        Some(ContentLocator::ExpressionSpan {
            start: 0,
            end: 1,
            ..
        })
    ));

    // Rename to a keyword: `f → frac` reshapes `f(a, b)` into a built-up fraction with no head
    // occurrence, so the head anchor can't be re-placed → the edge stales (never wrong, §6.1b).
    let e2 = ExpressionId(v7(71));
    let stale_content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![a_math_unit(
            UnitId(v7(2)),
            ObjectId(v7(1)),
            0,
            an_expr(
                e2,
                "f(a, b)",
                vec![Occurrence {
                    selector: CharSpan::new(0, 1),
                    target: None,
                }],
            ),
        )],
    };
    let stale_link = Link {
        content_locator: Some(ContentLocator::ExpressionSpan {
            expression_id: e2,
            start: 0,
            end: 1,
        }),
        ..link.clone()
    };
    let out2 = rewrite_surface(
        stale_content,
        std::slice::from_ref(&stale_link),
        &RewriteSurfaceInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e2,
            from: "f".into(),
            to: "frac".into(),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    let me2 = expr_of(&out2.content, e2);
    assert_eq!(me2.id, e2);
    assert_eq!(
        me2.original_input, "f(a, b)",
        "original_input verbatim even on stale"
    );
    assert_eq!(out2.links_staled, vec![LinkId(v7(80))]);
    assert!(
        out2.links_upserted.is_empty(),
        "a staled edge is reported in links_staled only, never also upserted"
    );
}

#[test]
fn toggle_display_to_inline_preserves_id() {
    let e = ExpressionId(v7(70));
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![
            a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "ab", vec![]),
            a_math_unit(
                UnitId(v7(3)),
                ObjectId(v7(1)),
                1,
                an_expr(e, "x + y", vec![]),
            ),
        ],
    };
    let out = toggle_expression_placement(
        content,
        &ToggleExpressionPlacementInput {
            expected_revision: 1,
            unit_id: UnitId(v7(3)),
            expression_id: e,
            display_unit_id: UnitId(v7(9)),
            trailing_unit_id: UnitId(v7(10)),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert!(out.expression_id_remap.is_empty());
    assert_eq!(expr_id_multiset(&out.content), vec![e]);
    assert_eq!(out.content.units.len(), 1);
    assert!(matches!(
        &out.content.units[0].content,
        UnitContent::Prose { inline, .. } if inline.iter().any(|el| matches!(el, Inline::Math { expr, .. } if expr.id == e))
    ));
    assert_content_well_formed(&out.content);
}

#[test]
fn expected_revision_is_echoed_not_gated() {
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 7,
        units: vec![a_prose_unit(
            UnitId(v7(2)),
            ObjectId(v7(1)),
            0,
            "ab",
            vec![],
        )],
    };
    let mk = |rev| SetUnitTypeInput {
        expected_revision: rev,
        unit_id: UnitId(v7(2)),
        unit_type: Patch::Set(UnitType::Lemma),
    };
    let a = set_unit_type(content.clone(), &mk(0), &op_ctx(), op_now()).unwrap();
    let b = set_unit_type(content.clone(), &mk(u32::MAX), &op_ctx(), op_now()).unwrap();
    // Identical delta regardless of expected_revision; the new revision derives from content.
    assert_eq!(a.content, b.content);
    assert_eq!(a.content.revision, 8);
}

#[test]
fn set_unit_type_clears_orphaned_example_kind() {
    let mut unit = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "ab", vec![]);
    unit.unit_type = Some(UnitType::Example);
    unit.example_kind = Some(mathmeander_core::model::ExampleKind::Worked);
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![unit],
    };
    let out = set_unit_type(
        content,
        &SetUnitTypeInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            unit_type: Patch::Set(UnitType::Lemma),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    // type is no longer `example` ⇒ example_kind is cleared (no orphan, §6.0b).
    assert_eq!(out.content.units[0].unit_type, Some(UnitType::Lemma));
    assert_eq!(out.content.units[0].example_kind, None);
}

#[test]
fn insert_reference_enforces_link_invariants() {
    let content = || MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![],
    };
    // Valid: a deliberate edge with an object target.
    let out = insert_reference(
        content(),
        &InsertReferenceInput {
            expected_revision: 1,
            link: LinkDraft {
                id: LinkId(v7(80)),
                source_object_id: ObjectId(v7(1)),
                target_object_id: Some(ObjectId(v7(9))),
                target_unit_id: None,
                unresolved_text: None,
                target_selector: None,
                link_type: LinkType::Proves,
                from_content: false,
                source_unit_id: None,
                content_locator: None,
            },
        },
        &op_ctx(),
        op_now(),
    )
    .expect("valid link");
    assert_eq!(out.links_upserted.len(), 1);
    assert_eq!(out.links_upserted[0].status, LinkStatus::Active);

    // Invalid: a typed edge (proves) with no object target (only unresolved_text).
    let err = insert_reference(
        content(),
        &InsertReferenceInput {
            expected_revision: 1,
            link: LinkDraft {
                id: LinkId(v7(81)),
                source_object_id: ObjectId(v7(1)),
                target_object_id: None,
                target_unit_id: None,
                unresolved_text: Some("[[X]]".into()),
                target_selector: None,
                link_type: LinkType::Proves,
                from_content: true,
                source_unit_id: None,
                content_locator: None,
            },
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert_eq!(err_code(&err), "typed_edge_requires_object_target");
}

#[test]
fn resolve_occurrence_object_notation_and_bounds() {
    let e = ExpressionId(v7(70));
    let mk = || MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![a_math_unit(
            UnitId(v7(2)),
            ObjectId(v7(1)),
            0,
            an_expr(
                e,
                "x",
                vec![Occurrence {
                    selector: CharSpan::new(0, 1),
                    target: None,
                }],
            ),
        )],
    };
    // Object arm: resolves the occurrence + emits the edge.
    let out = resolve_occurrence(
        mk(),
        &ResolveOccurrenceInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            occurrence_index: 0,
            link_id: LinkId(v7(80)),
            target: ResolveTarget::Object {
                object_id: ObjectId(v7(9)),
            },
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_eq!(out.links_upserted.len(), 1);
    let me = expr_of(&out.content, e);
    assert!(
        matches!(me.occurrences[0].target, Some(OccurrenceTarget::Object { object_id }) if object_id == ObjectId(v7(9)))
    );

    // Notation arm: not available yet.
    let err = resolve_occurrence(
        mk(),
        &ResolveOccurrenceInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            occurrence_index: 0,
            link_id: LinkId(v7(80)),
            target: ResolveTarget::Notation {
                notation_id: "n".into(),
            },
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert_eq!(err_code(&err), "target_kind_not_available_yet");

    // Out-of-range occurrence index.
    let err2 = resolve_occurrence(
        mk(),
        &ResolveOccurrenceInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            occurrence_index: 5,
            link_id: LinkId(v7(80)),
            target: ResolveTarget::Object {
                object_id: ObjectId(v7(9)),
            },
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap_err();
    assert_eq!(err_code(&err2), "occurrence_out_of_range");
}

#[test]
fn materialize_requires_total_id_maps() {
    let e = ExpressionId(v7(70));
    let source = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![a_math_unit(
            UnitId(v7(2)),
            ObjectId(v7(1)),
            0,
            an_expr(e, "x", vec![]),
        )],
    };
    // Unit map present, expression map EMPTY ⇒ RemapIncomplete (copying would alias ids).
    let input = MaterializeObjectInput {
        expected_revision: 1,
        source_object: an_object(ObjectId(v7(1))),
        source_content: source,
        new_object_id: ObjectId(v7(2)),
        new_provenance_id: ProvenanceId(v7(102)),
        edge_link_id: LinkId(v7(103)),
        expr_id_map: vec![],
        unit_id_map: vec![UnitIdRemap {
            from: UnitId(v7(2)),
            to: UnitId(v7(50)),
        }],
    };
    let err = materialize_object(&input, &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "remap_incomplete");
}

#[test]
fn materialize_rejects_a_surface_source() {
    // The twin of `rehome_rejects_a_surface_target` (ownership.rs): COPYING a §6.5 surface is refused —
    // a journal_day copy would be dateless + detail-less. The guard fires before any id-remap check.
    let mut source_object = an_object(ObjectId(v7(1)));
    source_object.object_type = ObjectType::JournalDay;
    let input = MaterializeObjectInput {
        expected_revision: 1,
        source_object,
        source_content: MathContent {
            object_id: ObjectId(v7(1)),
            revision: 1,
            units: vec![],
        },
        new_object_id: ObjectId(v7(2)),
        new_provenance_id: ProvenanceId(v7(102)),
        edge_link_id: LinkId(v7(103)),
        expr_id_map: vec![],
        unit_id_map: vec![],
    };
    let err = materialize_object(&input, &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "type_not_materializable");
}

// ── save_content: the §6.0a coarse prose-authoring delta (slice 2c) ──

fn prose_content(units: Vec<Unit>) -> MathContent {
    MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units,
    }
}

#[test]
fn save_content_empty_delta_is_identity_plus_revision() {
    let u = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "Hello.", vec![]);
    let prior = prose_content(vec![u.clone()]);
    let out = save_content(&prior, &[], &[], &op_ctx(), op_now()).expect("empty delta applies");
    assert_eq!(out.content.revision, 2);
    assert_eq!(out.content.units, vec![u]); // byte-identical content
}

#[test]
fn save_content_edits_prose_text_and_appends_and_deletes() {
    let a = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "first", vec![]);
    let b = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, "second", vec![]);
    let prior = prose_content(vec![a, b]);

    // edit a's text, delete b, append c
    let a_edited = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "FIRST!", vec![]);
    let c = a_prose_unit(UnitId(v7(4)), ObjectId(v7(1)), 1, "third", vec![]);
    let out = save_content(
        &prior,
        &[a_edited.clone(), c.clone()],
        &[UnitId(v7(3))],
        &op_ctx(),
        op_now(),
    )
    .expect("prose delta applies");
    assert_eq!(out.content.units, vec![a_edited, c]);
    assert_eq!(out.content.revision, 2);
}

#[test]
fn save_content_rejects_type_change_on_existing_unit() {
    let id = UnitId(v7(2));
    let prior = prose_content(vec![a_prose_unit(id, ObjectId(v7(1)), 0, "x", vec![])]);
    let mut typed = a_prose_unit(id, ObjectId(v7(1)), 0, "x", vec![]);
    typed.unit_type = Some(UnitType::Theorem); // a type change is set_unit_type's job
    let err = save_content(&prior, &[typed], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_kind_change_on_existing_unit() {
    let id = UnitId(v7(2));
    let prior = prose_content(vec![a_prose_unit(id, ObjectId(v7(1)), 0, "x", vec![])]);
    let mut as_math = a_prose_unit(id, ObjectId(v7(1)), 0, "x", vec![]);
    as_math.content = UnitContent::Math {
        expr: an_expr(ExpressionId(v7(40)), "y", vec![]),
    };
    let err = save_content(&prior, &[as_math], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_a_typed_new_unit() {
    let prior = prose_content(vec![a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "x",
        vec![],
    )]);
    let mut bad = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, "y", vec![]);
    bad.unit_type = Some(UnitType::Theorem); // a NEW unit must be untyped rough prose
    let err = save_content(&prior, &[bad], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_deleting_a_typed_unit() {
    let id = UnitId(v7(2));
    let mut typed = a_prose_unit(id, ObjectId(v7(1)), 0, "x", vec![]);
    typed.unit_type = Some(UnitType::Theorem);
    let prior = prose_content(vec![typed]);
    let err = save_content(&prior, &[], &[id], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid"); // dissolve, don't coarse-delete
}

#[test]
fn save_content_rejects_position_collision() {
    let prior = prose_content(vec![a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "a",
        vec![],
    )]);
    // a NEW unit at the same position 0 as the untouched existing unit (editor failed to renumber)
    let b = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 0, "b", vec![]);
    let err = save_content(&prior, &[b], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_runs_inline_bounds_validation() {
    let id = UnitId(v7(2));
    let prior = prose_content(vec![a_prose_unit(id, ObjectId(v7(1)), 0, "xy", vec![])]);
    let bad = a_prose_unit(
        id,
        ObjectId(v7(1)),
        0,
        "xy",
        vec![Inline::Mark {
            span: CharSpan::new(0, 9), // out of bounds on a 2-char text
            style: "emph".into(),
        }],
    );
    let err = save_content(&prior, &[bad], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "inline_span_out_of_bounds");
}

#[test]
fn save_content_allows_reordering_prose() {
    // Re-ordering paragraphs is prose authoring, NOT a semantic change — position may differ.
    let a = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "a", vec![]);
    let b = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, "b", vec![]);
    let prior = prose_content(vec![a.clone(), b.clone()]);
    let mut a2 = a;
    a2.position = 1;
    let mut b2 = b;
    b2.position = 0;
    let out = save_content(&prior, &[a2, b2], &[], &op_ctx(), op_now()).expect("reorder applies");
    let pos = |id: UnitId| {
        out.content
            .units
            .iter()
            .find(|u| u.id == id)
            .unwrap()
            .position
    };
    assert_eq!((pos(UnitId(v7(2))), pos(UnitId(v7(3)))), (1, 0));
}

#[test]
fn save_content_allows_middle_delete_with_renumber() {
    // Deleting a middle paragraph shifts its successors' positions — the editor sends the shifted
    // survivors as upserts; the core must accept the position change (the blocker this test guards).
    let a = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "a", vec![]);
    let b = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, "b", vec![]);
    let c = a_prose_unit(UnitId(v7(4)), ObjectId(v7(1)), 2, "c", vec![]);
    let prior = prose_content(vec![a, b, c.clone()]);
    let mut c1 = c;
    c1.position = 1; // shifted up after B's deletion
    let out = save_content(&prior, &[c1], &[UnitId(v7(3))], &op_ctx(), op_now())
        .expect("middle delete applies");
    assert_eq!(out.content.units.len(), 2);
    assert_eq!(
        out.content
            .units
            .iter()
            .find(|u| u.id == UnitId(v7(4)))
            .unwrap()
            .position,
        1
    );
}

#[test]
fn save_content_rejects_reparenting_an_existing_unit() {
    let a = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "a", vec![]);
    let prior = prose_content(vec![a.clone()]);
    let mut moved = a;
    moved.parent_unit_id = Some(UnitId(v7(9))); // re-parenting is rehome's job
    let err = save_content(&prior, &[moved], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_changing_declared_by() {
    // §2.5/§6.0: editor input can't relabel a unit's authorship.
    let a = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "a", vec![]);
    let prior = prose_content(vec![a.clone()]);
    let mut relabeled = a;
    relabeled.declared_by = DeclaredBy::Imported;
    let err = save_content(&prior, &[relabeled], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_new_unit_smuggling_a_parent() {
    let prior = prose_content(vec![a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "a",
        vec![],
    )]);
    let mut child = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 0, "b", vec![]);
    child.parent_unit_id = Some(UnitId(v7(2))); // a "new prose unit" may not nest (structural, §6.0b)
    let err = save_content(&prior, &[child], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_new_unit_forging_extracted_structure() {
    // §2.5: editor input must not be able to fabricate an AI/candidate-decomposition record.
    let prior = prose_content(vec![a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "a",
        vec![],
    )]);
    let mut forged = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 1, "b", vec![]);
    forged.extracted_structure = Some(ExtractedStructureEnvelope {
        kind: "hypothesis_conclusion_decomposition".into(),
        schema_version: 1,
        generated_by: "forged".into(),
        base_object_revision: 1,
        accepted_into: None,
    });
    let err = save_content(&prior, &[forged], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_object_id_mismatch() {
    // A unit must belong to THIS object — no cross-object smuggling.
    let prior = prose_content(vec![a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "a",
        vec![],
    )]);
    let foreign = a_prose_unit(UnitId(v7(3)), ObjectId(v7(99)), 1, "b", vec![]);
    let err = save_content(&prior, &[foreign], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_deleting_unknown_unit() {
    let prior = prose_content(vec![a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "a",
        vec![],
    )]);
    let err = save_content(&prior, &[], &[UnitId(v7(999))], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

#[test]
fn save_content_rejects_editing_nonprose_content() {
    // A day may already hold a display-math unit; save_content carries it unchanged, never edits it.
    let m = a_math_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        an_expr(ExpressionId(v7(40)), "x", vec![]),
    );
    let prior = prose_content(vec![m.clone()]);
    let mut edited = m;
    edited.content = UnitContent::Math {
        expr: an_expr(ExpressionId(v7(40)), "y", vec![]),
    };
    let err = save_content(&prior, &[edited], &[], &op_ctx(), op_now()).unwrap_err();
    assert_eq!(err_code(&err), "content_save_invalid");
}

// ── Inline-atom contract coverage (the review's blind-spot class) ──

#[test]
fn split_through_a_mark_splits_the_mark() {
    // Prose "abcdef" with a bold Mark over [1,5); splitting at 3 splits the mark into
    // Mark[1,3) (left) + Mark[0,2) (right) — lossless, total, no straddle error.
    let unit = a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "abcdef",
        vec![Inline::Mark {
            span: CharSpan::new(1, 5),
            style: "emph".into(),
        }],
    );
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![unit],
    };
    let out = split_unit(
        content,
        &SplitUnitInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            at: 3,
            new_unit_id: UnitId(v7(3)),
            propagate_taggings: vec![],
            new_tagging_ids: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_eq!(out.content.units.len(), 2);
    assert_content_well_formed(&out.content);
    // units[0] is the left half (inserted second goes at idx+1), units[1] the right.
    match &out.content.units[0].content {
        UnitContent::Prose { text, inline } => {
            assert_eq!(text.as_str(), "abc");
            assert_eq!(inline.len(), 1);
            assert!(
                matches!(&inline[0], Inline::Mark { span, .. } if *span == CharSpan::new(1, 3))
            );
        }
        _ => panic!("left not prose"),
    }
    match &out.content.units[1].content {
        UnitContent::Prose { text, inline } => {
            assert_eq!(text.as_str(), "def");
            assert_eq!(inline.len(), 1);
            assert!(
                matches!(&inline[0], Inline::Mark { span, .. } if *span == CharSpan::new(0, 2))
            );
        }
        _ => panic!("right not prose"),
    }
}

#[test]
fn rewrite_on_inline_math_leaves_prose_intact() {
    // The contract dissolves "Blocker 1": rewriting an inline-math atom's surface changes only
    // the expression — the enclosing prose text and ALL inline spans are untouched (the atom is
    // zero-width, so the prose char sequence is unaffected even when the surface grows).
    let e = ExpressionId(v7(70));
    let unit = a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "see  here",
        vec![
            Inline::Mark {
                span: CharSpan::new(0, 3),
                style: "emph".into(),
            },
            Inline::Math {
                span: CharSpan::new(4, 4),
                expr: an_expr(e, "x + y", vec![]),
            },
        ],
    );
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![unit],
    };
    let out = rewrite_surface(
        content,
        &[],
        &RewriteSurfaceInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            from: "x".into(),
            to: "longername".into(),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    match &out.content.units[0].content {
        UnitContent::Prose { text, inline } => {
            assert_eq!(text.as_str(), "see  here", "prose text untouched");
            assert_eq!(inline.len(), 2);
            assert!(
                matches!(&inline[0], Inline::Mark { span, .. } if *span == CharSpan::new(0, 3))
            );
            match &inline[1] {
                Inline::Math { span, expr } => {
                    assert_eq!(*span, CharSpan::new(4, 4), "enclosing atom span untouched");
                    assert_eq!(expr.id, e, "expression id preserved");
                    assert_eq!(expr.original_input, "x + y", "original_input verbatim");
                    assert_eq!(expr.surface_text, "longername + y", "surface updated");
                }
                _ => panic!("expected inline math"),
            }
        }
        _ => panic!("expected prose"),
    }
    assert_content_well_formed(&out.content);
}

#[test]
fn toggle_promote_then_demote_round_trips() {
    // Mid-text inline math: promote splits the prose around the atom into [before, display, after];
    // demote joins them back and reinserts the atom at the join — reversible by construction.
    let e = ExpressionId(v7(70));
    let unit = a_prose_unit(
        UnitId(v7(2)),
        ObjectId(v7(1)),
        0,
        "abcd",
        vec![Inline::Math {
            span: CharSpan::new(2, 2),
            expr: an_expr(e, "x + y", vec![]),
        }],
    );
    let start = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![unit],
    };

    let promoted = toggle_expression_placement(
        start,
        &ToggleExpressionPlacementInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            expression_id: e,
            display_unit_id: UnitId(v7(3)),
            trailing_unit_id: UnitId(v7(4)),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_eq!(promoted.content.units.len(), 3, "before / display / after");
    assert_content_well_formed(&promoted.content);
    assert_eq!(expr_id_multiset(&promoted.content), vec![e]);
    assert!(
        promoted
            .content
            .units
            .iter()
            .any(|u| matches!(&u.content, UnitContent::Math { expr } if expr.id == e))
    );

    let demoted = toggle_expression_placement(
        promoted.content,
        &ToggleExpressionPlacementInput {
            expected_revision: 1,
            unit_id: UnitId(v7(3)), // the display math unit
            expression_id: e,
            display_unit_id: UnitId(v7(8)), // unused on demote
            trailing_unit_id: UnitId(v7(9)),
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_content_well_formed(&demoted.content);
    assert_eq!(expr_id_multiset(&demoted.content), vec![e]);
    assert_eq!(
        demoted.content.units.len(),
        1,
        "joined back to one prose unit"
    );
    match &demoted.content.units[0].content {
        UnitContent::Prose { text, inline } => {
            assert_eq!(text.as_str(), "abcd", "before+after rejoined");
            assert_eq!(inline.len(), 1);
            assert!(
                matches!(&inline[0], Inline::Math { span, expr } if *span == CharSpan::new(2, 2) && expr.id == e),
                "atom reinserted at the join, id preserved"
            );
        }
        _ => panic!("expected prose"),
    }
}

#[test]
fn split_propagates_taggings_to_the_new_unit() {
    let unit = a_prose_unit(UnitId(v7(2)), ObjectId(v7(1)), 0, "abcd", vec![]);
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![unit],
    };
    let tagging = Tagging {
        id: TaggingId(v7(200)),
        tag_id: TagId(v7(201)),
        tagged_object_id: None,
        tagged_unit_id: Some(UnitId(v7(2))),
        created_at: op_now(),
    };
    let out = split_unit(
        content,
        &SplitUnitInput {
            expected_revision: 1,
            unit_id: UnitId(v7(2)),
            at: 2,
            new_unit_id: UnitId(v7(3)),
            propagate_taggings: vec![tagging],
            new_tagging_ids: vec![TaggingId(v7(202))],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_eq!(out.taggings_propagated.len(), 1);
    let t = &out.taggings_propagated[0];
    assert_eq!(t.id, TaggingId(v7(202)), "re-id'd from new_tagging_ids");
    assert_eq!(t.tag_id, TagId(v7(201)), "same tag");
    assert_eq!(
        t.tagged_unit_id,
        Some(UnitId(v7(3))),
        "copied onto the new unit"
    );
    assert_eq!(t.tagged_object_id, None);
}

#[test]
fn split_renumbers_per_parent() {
    // A top-level unit (v7(2)) and two of its children; splitting the first child renumbers ONLY
    // the children (per-parent gap-free), leaving the top-level unit's position alone.
    let parent_id = UnitId(v7(2));
    let mut child_a = a_prose_unit(UnitId(v7(3)), ObjectId(v7(1)), 0, "abcd", vec![]);
    child_a.parent_unit_id = Some(parent_id);
    let mut child_b = a_prose_unit(UnitId(v7(4)), ObjectId(v7(1)), 1, "wxyz", vec![]);
    child_b.parent_unit_id = Some(parent_id);
    let parent = a_prose_unit(parent_id, ObjectId(v7(1)), 0, "parent", vec![]);
    let content = MathContent {
        object_id: ObjectId(v7(1)),
        revision: 1,
        units: vec![parent, child_a, child_b],
    };
    let out = split_unit(
        content,
        &SplitUnitInput {
            expected_revision: 1,
            unit_id: UnitId(v7(3)),
            at: 2,
            new_unit_id: UnitId(v7(5)),
            propagate_taggings: vec![],
            new_tagging_ids: vec![],
        },
        &op_ctx(),
        op_now(),
    )
    .unwrap();
    assert_content_well_formed(&out.content); // per-parent gap-free 0..n
    let p = out
        .content
        .units
        .iter()
        .find(|u| u.id == parent_id)
        .unwrap();
    assert_eq!(p.parent_unit_id, None);
    assert_eq!(p.position, 0, "top-level parent position unaffected");
    let mut child_pos: Vec<u32> = out
        .content
        .units
        .iter()
        .filter(|u| u.parent_unit_id == Some(parent_id))
        .map(|u| u.position)
        .collect();
    child_pos.sort_unstable();
    assert_eq!(child_pos, vec![0, 1, 2], "three children renumbered 0..3");
}
