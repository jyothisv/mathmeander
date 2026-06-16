//! Property tests (arch doc §16): the serialize/deserialize round-trip, validation
//! totality (no panics on arbitrary input), patch semantics, and create invariants.
//! These are the heart of the §2.2 "no lost user effort" guarantee.

use chrono::{DateTime, Utc};
use proptest::prelude::*;
use uuid::Uuid;

use mathmeander_core::ids::{ObjectId, ProvenanceId, SpaceId};
use mathmeander_core::model::{CanonicalObject, ObjectStatus, ObjectType, Origin};
use mathmeander_core::patch::Patch;
use mathmeander_core::validate::{
    CreateContext, CreateObjectInput, MAX_TITLE_CHARS, ObjectPatch, apply_title_patch,
    create_object,
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
    fn create_rejects_non_v7_ids(id in arb_uuid(), provenance_id in arb_uuid_v7(), now in arb_datetime()) {
        prop_assume!(id.get_version_num() != 7);
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

    // widened, producible vocabulary → creates (the slice-1 flip)
    let mut input = base_input.clone();
    input.object_type = "theorem".into();
    create_object(&input, &ctx, space, now).expect("theorem is producible in slice 1");

    // reserved vocabulary (valid on read, not producible yet) → typed error (§6.1a)
    let mut input = base_input;
    input.object_type = "trail".into();
    let err = create_object(&input, &ctx, space, now).expect_err("must fail");
    assert_eq!(
        serde_json::to_value(&err).expect("serializes")["code"],
        "type_not_producible_yet"
    );
}
