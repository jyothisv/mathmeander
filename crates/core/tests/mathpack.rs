//! `.mathpack` round-trip + migration tests (arch doc §10/§16) — slice 1d. The heart of the
//! §2.2 guarantee at pack scope: serialize → import is lossless, every object flows through the
//! migration read path, and a wrong/future pack is refused loudly. Core stays hash-free.

use chrono::{DateTime, Utc};
use proptest::prelude::*;
use uuid::Uuid;

use mathmeander_core::ids::{
    AliasId, ExpressionId, LinkId, ObjectId, ObjectVersionId, ProvenanceId, SpaceId, TagId,
    TaggingId, UnitId,
};
use mathmeander_core::mathpack::{
    MathpackGraph, MathpackMeta, import_mathpack, serialize_mathpack,
};
use mathmeander_core::model::{
    Alias, AliasKind, AliasScope, CanonicalObject, CharSpan, DeclaredBy, Inline, Link, LinkStatus,
    LinkType, MathExpression, ObjectStatus, ObjectType, ObjectVersion, Occurrence, Origin,
    ParseStatus, Provenance, SurfaceFormat, Tagging, Unit, UnitContent, UnitStatus,
};
use mathmeander_core::ops::MathContent;

fn v7(tag: u128) -> Uuid {
    let bits = (tag & !(0xF << 76)) | (0x7 << 76);
    let bits = (bits & !(0b11 << 62)) | (0b10 << 62);
    Uuid::from_u128(bits)
}

fn dt() -> DateTime<Utc> {
    DateTime::from_timestamp(1_780_000_000, 0).expect("in range")
}

fn meta() -> MathpackMeta {
    MathpackMeta {
        space_id: SpaceId(v7(3)),
        asset_checksums: Vec::new(),
    }
}

fn an_object(id_tag: u128) -> CanonicalObject {
    CanonicalObject {
        id: ObjectId(v7(id_tag)),
        object_type: ObjectType::Theorem,
        title: Some("Bolzano–Weierstrass".into()),
        raw_source: None,
        status: ObjectStatus::Draft,
        schema_version: mathmeander_core::CURRENT_SCHEMA_VERSION,
        revision: 2,
        provenance_id: ProvenanceId(v7(0xd1)),
        space_id: SpaceId(v7(3)),
        created_at: dt(),
        updated_at: dt(),
        extra: serde_json::Map::new(),
    }
}

fn a_prose_unit(id_tag: u128, object_id: ObjectId, position: u32, text: &str) -> Unit {
    Unit {
        id: UnitId(v7(id_tag)),
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
            inline: Vec::new(),
        },
        provenance_id: ProvenanceId(v7(0xd1)),
    }
}

fn a_provenance(id_tag: u128) -> Provenance {
    Provenance {
        id: ProvenanceId(v7(id_tag)),
        origin: Origin::User,
        created_by: Some("user-1".into()),
        occurred_at: dt(),
    }
}

fn a_link(id_tag: u128, object_id: ObjectId) -> Link {
    Link {
        id: LinkId(v7(id_tag)),
        source_object_id: object_id,
        target_object_id: Some(object_id),
        target_unit_id: None,
        unresolved_text: None,
        target_selector: None,
        link_type: LinkType::Related,
        status: LinkStatus::Active,
        from_content: false,
        source_unit_id: None,
        content_locator: None,
        provenance_id: ProvenanceId(v7(0xd1)),
        created_at: dt(),
    }
}

fn an_alias(id_tag: u128, object_id: ObjectId, name: &str) -> Alias {
    Alias {
        id: AliasId(v7(id_tag)),
        object_id,
        name: name.to_string(),
        kind: AliasKind::User,
        scope: AliasScope::Global,
        scope_ref: None,
    }
}

fn an_object_version(id_tag: u128, object_id: ObjectId) -> ObjectVersion {
    ObjectVersion {
        id: ObjectVersionId(v7(id_tag)),
        object_id,
        version_no: 2,
        snapshot: serde_json::json!({ "revision": 2, "units": [] }),
        provenance_id: ProvenanceId(v7(0xd1)),
        created_at: dt(),
    }
}

/// A populated slice-1 graph (object + content + a link + alias + a version row).
fn sample_graph() -> MathpackGraph {
    let object = an_object(0xa1);
    let unit = a_prose_unit(
        0xb1,
        object.id,
        0,
        "Every bounded sequence has a convergent subsequence.",
    );
    let content = MathContent {
        object_id: object.id,
        revision: object.revision,
        units: vec![unit],
    };
    MathpackGraph {
        objects: vec![object.clone()],
        provenance: vec![a_provenance(0xd1)],
        provenance_derivations: Vec::new(),
        content: vec![content],
        links: vec![a_link(0xa3, object.id)],
        aliases: vec![an_alias(0xa5, object.id, "BW")],
        handles: Vec::new(),
        tags: Vec::new(),
        taggings: Vec::new(),
        object_versions: vec![an_object_version(0xa6, object.id)],
        definition_details: Vec::new(),
    }
}

/// A valid serialized pack, as the JSON `Value` the import path consumes.
fn valid_pack_value() -> serde_json::Value {
    let pack = serialize_mathpack(&meta(), sample_graph(), dt()).expect("serialize");
    serde_json::to_value(&pack).expect("pack serializes to value")
}

/// serialize → (JSON) → import yields the identical graph, and the import manifest equals the
/// export manifest (counts derived, schema_version stamped, the rest preserved).
#[test]
fn round_trip_identity() {
    let graph = sample_graph();
    let pack = serialize_mathpack(&meta(), graph.clone(), dt()).expect("serialize");

    // The manifest is self-describing: counts match the graph, format/version are pinned.
    assert_eq!(pack.manifest.counts.objects, 1);
    assert_eq!(pack.manifest.counts.units, 1);
    assert_eq!(pack.manifest.counts.links, 1);
    assert_eq!(pack.manifest.format, "mathmeander.mathpack");
    assert_eq!(pack.manifest.format_version, 1);

    let value = serde_json::to_value(&pack).expect("pack serializes to value");
    let imported = import_mathpack(value).expect("import");

    assert_eq!(imported.graph, graph, "graph round-trips byte-for-byte");
    assert_eq!(imported.manifest, pack.manifest, "manifest round-trips");
}

/// Every object flows through `parse_and_migrate_object` on import — so unknown (foreign) fields
/// survive non-destructively (§2.2), exactly like a normal read.
#[test]
fn migration_runs_per_object() {
    let mut object = an_object(0xa1);
    object.extra.insert(
        "x_from_future".into(),
        serde_json::json!({ "carried": true }),
    );
    let graph = MathpackGraph {
        objects: vec![object.clone()],
        content: Vec::new(),
        ..sample_graph()
    };

    let pack = serialize_mathpack(&meta(), graph, dt()).expect("serialize");
    let value = serde_json::to_value(&pack).expect("pack serializes to value");
    let imported = import_mathpack(value).expect("import");

    let imported_object = &imported.graph.objects[0];
    assert!(
        imported_object.extra.contains_key("x_from_future"),
        "foreign fields survive the migration read path"
    );
    assert_eq!(*imported_object, object, "migration is non-destructive");
}

#[test]
fn rejects_wrong_format() {
    let mut value = valid_pack_value();
    value["manifest"]["format"] = serde_json::json!("zip");
    assert!(import_mathpack(value).is_err());
}

#[test]
fn rejects_future_format_version() {
    let mut value = valid_pack_value();
    value["manifest"]["format_version"] = serde_json::json!(999);
    assert!(import_mathpack(value).is_err());
}

#[test]
fn rejects_future_schema_version() {
    let mut value = valid_pack_value();
    value["manifest"]["schema_version"] = serde_json::json!(999);
    let err = import_mathpack(value).expect_err("a future schema_version is refused");
    // Reuses the existing typed read-path error (refusing loudly beats misreading, §2.2).
    let serialized = serde_json::to_value(&err).expect("error serializes");
    assert_eq!(serialized["code"], "schema_version_from_the_future");
}

// ── import is the untrusted-input gate: hostile packs are refused (§6.1a, validate_graph) ──

/// A graph carrying only `objects` + `content` (every other section empty) — for building a pack
/// whose single hostile row is the thing under test.
fn graph_with(objects: Vec<CanonicalObject>, content: Vec<MathContent>) -> MathpackGraph {
    MathpackGraph {
        objects,
        provenance: Vec::new(),
        provenance_derivations: Vec::new(),
        content,
        links: Vec::new(),
        aliases: Vec::new(),
        handles: Vec::new(),
        tags: Vec::new(),
        taggings: Vec::new(),
        object_versions: Vec::new(),
        definition_details: Vec::new(),
    }
}

/// Serialize a (possibly hostile) graph to the JSON value the import path consumes. Export
/// validates only the manifest, so a hostile body is constructible here on purpose.
fn pack_value(graph: MathpackGraph) -> serde_json::Value {
    let pack = serialize_mathpack(&meta(), graph, dt()).expect("serialize (manifest-only)");
    serde_json::to_value(&pack).expect("pack serializes to value")
}

fn an_expr(tag: u128) -> MathExpression {
    MathExpression {
        id: ExpressionId(v7(tag)),
        surface_text: "x".into(),
        surface_format: SurfaceFormat::Mathmeander,
        input_syntax: None,
        original_input: "x".into(),
        parse_status: ParseStatus::Renderable,
        occurrences: Vec::new(),
    }
}

/// The error `code` (validation) or `kind` (malformed_input) of a refused import — so hostile
/// tests assert the SPECIFIC failure, not merely that something failed.
fn err_code(err: &mathmeander_core::error::CoreError) -> String {
    let value = serde_json::to_value(err).expect("error serializes");
    value
        .get("code")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("kind").and_then(serde_json::Value::as_str))
        .unwrap_or("<none>")
        .to_string()
}

/// A prose unit (text `"xy"`) whose only inline is the given element, wrapped as a one-unit pack.
fn prose_with_inline(inline: Inline) -> serde_json::Value {
    let object = an_object(0xa1);
    let mut unit = a_prose_unit(0xb1, object.id, 0, "xy");
    unit.content = UnitContent::Prose {
        text: "xy".into(),
        inline: vec![inline],
    };
    let content = MathContent {
        object_id: object.id,
        revision: object.revision,
        units: vec![unit],
    };
    pack_value(graph_with(vec![object], vec![content]))
}

/// A width-bearing inline-math atom corrupts prose offsets on the next rewrite (§6.3a) — the exact
/// slice-1c blocker `validate_inline` exists to make unreachable. Span `[0,2]` is IN-bounds so the
/// zero-width rule (not the bounds rule) is what fires. Import must refuse it.
#[test]
fn import_rejects_width_bearing_inline_atom() {
    let value = prose_with_inline(Inline::Math {
        span: CharSpan { start: 0, end: 2 }, // in-bounds, but NOT zero-width — banned atom
        expr: an_expr(0xc1),
    });
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "inline_atom_not_zero_width");
}

/// A link setting BOTH target arms (object + unresolved_text) violates exactly-one-target.
#[test]
fn import_rejects_malformed_link() {
    let object = an_object(0xa1);
    let mut link = a_link(0xa3, object.id); // object arm set
    link.unresolved_text = Some("[[X]]".into()); // ...and now the unresolved arm too
    let mut graph = graph_with(vec![object], Vec::new());
    graph.links = vec![link];
    let err = import_mathpack(pack_value(graph)).expect_err("rejected");
    assert_eq!(err_code(&err), "link_target_not_exactly_one");
}

/// A content-derived edge (`from_content = true`) without its anchor → ContentEdgeMissingAnchor.
#[test]
fn import_rejects_content_edge_missing_anchor() {
    let object = an_object(0xa1);
    let mut link = a_link(0xa3, object.id); // object arm set, source_unit_id/content_locator None
    link.from_content = true; // ...claims to be content-derived but records no anchor
    let mut graph = graph_with(vec![object], Vec::new());
    graph.links = vec![link];
    let err = import_mathpack(pack_value(graph)).expect_err("rejected");
    assert_eq!(err_code(&err), "content_edge_missing_anchor");
}

/// A unit-refinement target without its owning object target → UnitTargetWithoutObject.
#[test]
fn import_rejects_unit_target_without_object() {
    let object = an_object(0xa1);
    let mut link = a_link(0xa3, object.id);
    link.target_object_id = None;
    link.unresolved_text = Some("[[X]]".into()); // the single (non-object) target arm
    link.target_unit_id = Some(UnitId(v7(0xb1))); // a unit refinement with no object target
    link.from_content = true; // skip the off-graph-deliberate check so the unit rule is reached
    link.link_type = LinkType::Related; // related may stay unresolved
    let mut graph = graph_with(vec![object], Vec::new());
    graph.links = vec![link];
    let err = import_mathpack(pack_value(graph)).expect_err("rejected");
    assert_eq!(err_code(&err), "unit_target_without_object");
}

/// A tagging setting BOTH targets (object + unit) violates exactly-one-target.
#[test]
fn import_rejects_malformed_tagging() {
    let object = an_object(0xa1);
    let tagging = Tagging {
        id: TaggingId(v7(0xe1)),
        tag_id: TagId(v7(0xf1)),
        tagged_object_id: Some(object.id),
        tagged_unit_id: Some(UnitId(v7(0xb1))), // two arms set
        created_at: dt(),
    };
    let mut graph = graph_with(vec![object], Vec::new());
    graph.taggings = vec![tagging];
    let err = import_mathpack(pack_value(graph)).expect_err("rejected");
    assert_eq!(err_code(&err), "tagging_target_not_exactly_one");
}

/// A zero-width atom is still illegal if its position is OUT OF BOUNDS ([9,9] in a 2-char text):
/// zero-width passes the atom rule but `end > len` mis-slices on the next op. Import must refuse it.
#[test]
fn import_rejects_out_of_bounds_zero_width_atom() {
    let value = prose_with_inline(Inline::Math {
        span: CharSpan { start: 9, end: 9 }, // zero-width ✓ but past end of "xy"
        expr: an_expr(0xc1),
    });
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "inline_span_out_of_bounds");
}

/// A `Mark` region out of bounds ([100,200) over "xy") is never bounds-checked by the atom rule —
/// `validate_prose_inline` must still reject it on import.
#[test]
fn import_rejects_out_of_bounds_mark() {
    let value = prose_with_inline(Inline::Mark {
        span: CharSpan {
            start: 100,
            end: 200,
        },
        style: "emph".into(),
    });
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "inline_span_out_of_bounds");
}

/// An out-of-bounds occurrence SELECTOR inside an INLINE math expression — the inner expr, one
/// level below the inline span — must be caught (the slice-2 resolution substrate stays sound).
#[test]
fn import_rejects_out_of_bounds_inline_occurrence() {
    let expr = MathExpression {
        // surface "x" (len 1); selector [5,9] is out of bounds
        occurrences: vec![Occurrence {
            selector: CharSpan { start: 5, end: 9 },
            target: None,
        }],
        ..an_expr(0xc1)
    };
    let value = prose_with_inline(Inline::Math {
        span: CharSpan { start: 0, end: 0 }, // the inline span itself is fine (zero-width, in-bounds)
        expr,
    });
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "occurrence_span_out_of_bounds");
}

/// The same, for a DISPLAY math unit (`UnitContent::Math { expr }`) — the other carrier.
#[test]
fn import_rejects_out_of_bounds_display_occurrence() {
    let object = an_object(0xa1);
    let expr = MathExpression {
        occurrences: vec![Occurrence {
            selector: CharSpan { start: 5, end: 9 },
            target: None,
        }],
        ..an_expr(0xc1)
    };
    let mut unit = a_prose_unit(0xb1, object.id, 0, "xy");
    unit.content = UnitContent::Math { expr };
    let content = MathContent {
        object_id: object.id,
        revision: object.revision,
        units: vec![unit],
    };
    let value = pack_value(graph_with(vec![object], vec![content]));
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "occurrence_span_out_of_bounds");
}

/// A pack whose declared counts disagree with its body is corrupt — import refuses it.
#[test]
fn import_rejects_count_mismatch() {
    let mut value = valid_pack_value();
    value["manifest"]["counts"]["objects"] = serde_json::json!(99);
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "malformed_input");
}

/// An OBJECT carrying a future `schema_version` is refused per-object — proving the import path runs
/// every object through `parse_and_migrate_object`, not merely that foreign fields survive.
#[test]
fn import_rejects_future_schema_object() {
    let mut object = an_object(0xa1);
    object.schema_version = 999; // newer than this core understands
    let value = pack_value(graph_with(vec![object], Vec::new()));
    let err = import_mathpack(value).expect_err("rejected");
    assert_eq!(err_code(&err), "schema_version_from_the_future");
}

// ── proptest: the migration/object path over many arbitrary objects ──

fn arb_datetime() -> impl Strategy<Value = DateTime<Utc>> {
    (0i64..=4_102_444_800, 0u32..1_000_000_000)
        .prop_map(|(secs, nanos)| DateTime::from_timestamp(secs, nanos).expect("in range"))
}

fn arb_title() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        Just(None),
        Just(Some(String::new())),
        any::<String>().prop_map(Some),
    ]
}

/// Foreign fields that must survive (keys prefixed so they can't collide with real ones).
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
        id in any::<u128>(),
        title in arb_title(),
        raw_source in arb_title(),
        revision in 0u32..u32::MAX,
        created_at in arb_datetime(),
        updated_at in arb_datetime(),
        extra in arb_extra(),
    ) -> CanonicalObject {
        CanonicalObject {
            id: ObjectId(Uuid::from_u128(id)),
            object_type: ObjectType::Note,
            title,
            raw_source,
            status: ObjectStatus::Draft,
            schema_version: mathmeander_core::CURRENT_SCHEMA_VERSION,
            revision,
            provenance_id: ProvenanceId(v7(0xd1)),
            space_id: SpaceId(v7(3)),
            created_at,
            updated_at,
            extra,
        }
    }
}

proptest! {
    /// A pack of arbitrary objects (tri-state titles, foreign fields, arbitrary timestamps)
    /// round-trips losslessly, and the manifest's object count matches.
    #[test]
    fn round_trip_preserves_arbitrary_objects(
        objects in proptest::collection::vec(arb_object(), 0..5)
    ) {
        let expected_n = objects.len() as u32;
        let graph = MathpackGraph {
            objects: objects.clone(),
            provenance: Vec::new(),
            provenance_derivations: Vec::new(),
            content: Vec::new(),
            links: Vec::new(),
            aliases: Vec::new(),
            handles: Vec::new(),
            tags: Vec::new(),
            taggings: Vec::new(),
            object_versions: Vec::new(),
            definition_details: Vec::new(),
        };
        let pack = serialize_mathpack(&meta(), graph, dt()).expect("serialize");
        let value = serde_json::to_value(&pack).expect("pack serializes to value");
        let imported = import_mathpack(value).expect("import");

        prop_assert_eq!(imported.manifest.counts.objects, expected_n);
        prop_assert_eq!(imported.graph.objects, objects);
    }
}
