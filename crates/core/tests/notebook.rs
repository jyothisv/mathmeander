//! Stage 2 — the `notebook` surface create path (§6.5 / §B). `create_notebook` mirrors
//! `create_journal_day` with a `slug` (identity) in place of `date`: the slug arrives normalized at the
//! FFI boundary, so here it must be non-empty + bounded, and the object type must be `notebook`. (Slug
//! NORMALIZATION itself lives in `api::create_notebook` and is exercised via the FFI / e2e.)

use chrono::{DateTime, Utc};
use uuid::Uuid;

use mathmeander_core::error::ValidationError;
use mathmeander_core::model::{ObjectStatus, ObjectType, Origin};
use mathmeander_core::validate::{CreateContext, CreateObjectInput, create_notebook};

fn v7(tag: u128) -> Uuid {
    let bits = (tag & !(0xF << 76)) | (0x7 << 76);
    let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
    Uuid::from_u128(bits)
}
fn now() -> DateTime<Utc> {
    DateTime::from_timestamp(1_780_000_000, 0).expect("in range")
}
const SPACE: &str = "0197675f-71f4-7000-8000-000000000003";

fn input(object_type: &str, title: Option<&str>) -> CreateObjectInput {
    CreateObjectInput {
        id: v7(0xa1).to_string(),
        object_type: object_type.to_string(),
        title: title.map(str::to_string),
        raw_source: None,
    }
}
fn ctx() -> CreateContext {
    CreateContext {
        provenance_id: v7(0xd1).to_string(),
        origin: Origin::User,
        created_by: Some("user-1".to_string()),
    }
}

#[test]
fn create_notebook_mints_object_provenance_and_detail() {
    let (object, _prov, detail) = create_notebook(
        &input("notebook", Some("Linear Algebra")),
        &ctx(),
        SPACE,
        "linear-algebra",
        now(),
    )
    .expect("valid notebook");
    assert_eq!(object.object_type, ObjectType::Notebook);
    assert_eq!(object.status, ObjectStatus::Draft);
    assert_eq!(object.title.as_deref(), Some("Linear Algebra")); // title rides on the object
    assert_eq!(detail.object_id, object.id);
    assert_eq!(detail.slug, "linear-algebra"); // slug is identity, on the detail
}

#[test]
fn create_notebook_rejects_an_empty_slug() {
    // A title that normalized to nothing (e.g. punctuation only) → an unaddressable surface, refused.
    let err =
        create_notebook(&input("notebook", Some("!!!")), &ctx(), SPACE, "", now()).unwrap_err();
    assert!(matches!(err, ValidationError::ContentSaveInvalid { .. }));
}

#[test]
fn create_notebook_rejects_a_wrong_type() {
    // The surface mints notebooks only; a mismatched type is a glue bug, surfaced as DetailTypeMismatch.
    let err = create_notebook(&input("note", Some("X")), &ctx(), SPACE, "x", now()).unwrap_err();
    assert!(matches!(err, ValidationError::DetailTypeMismatch { .. }));
}
