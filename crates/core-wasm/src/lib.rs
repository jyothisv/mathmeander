//! mathmeander-core-wasm — the browser seam over `mathmeander-core`'s pure projections (arch doc §5).
//!
//! Mirrors `crates/surface-wasm` (and `crates/core-node`, the napi seam): every `#[wasm_bindgen]`
//! function is a one-line delegation into `mathmeander_core`, with JSON strings crossing the boundary.
//! Keeping wasm-bindgen HERE — never in `mathmeander-core` — is what keeps the core pure and WASM-clean
//! (the wasm32 / cargo-tree purity guards audit `core`, not this wrapper).
//!
//! The editor numbers its typed blocks LOCALLY via this module — no server round-trip — so the numbers
//! are reactive and offline, and the numbering stays single-source (the Rust `project_display_labels`),
//! never reimplemented in TypeScript ("numbering is the absence of stored numbers", §6.3b).
use mathmeander_core::ids::{HandleId, ObjectId, ProvenanceId, SpaceId, UnitId};
use mathmeander_core::model::{
    DeclaredBy, Handle, HandleScope, HandleStatus, Unit, UnitContent, UnitStatus, UnitType,
};
use mathmeander_core::numbering::{NumberingPolicy, project_display_labels};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

/// The minimal per-block input the editor can build straight from the ProseMirror doc. Numbering reads
/// ONLY `(id, unit_type, parent_unit_id, position)`; every other `Unit` field is an inert placeholder
/// filled in `to_unit` below — that defaulting is data-shaping, NOT numbering logic.
#[derive(serde::Deserialize)]
struct BlockDto {
    id: UnitId,
    #[serde(rename = "type")]
    unit_type: Option<UnitType>,
    parent_unit_id: Option<UnitId>,
    position: u32,
}

fn to_unit(b: BlockDto) -> Unit {
    Unit {
        id: b.id,
        // Placeholders — `project_display_labels` ignores these (it reads only id/type/parent/position).
        object_id: ObjectId(Uuid::nil()),
        parent_unit_id: b.parent_unit_id,
        position: b.position,
        slot: None,
        row_relation: None,
        unit_type: b.unit_type,
        example_kind: None,
        status: UnitStatus::Rough,
        declared_by: DeclaredBy::User,
        extracted_structure: None,
        content: UnitContent::Prose {
            text: String::new(),
            inline: Vec::new(),
        },
        provenance_id: ProvenanceId(Uuid::nil()),
    }
}

/// The minimal per-name input: which unit carries which authored name. The editor reads it straight
/// off the doc; `project_display_labels` resolves it into `UnitLabel.name`. The other `Handle` fields
/// are inert placeholders (`handle_name` matches only on `status == Active` + `target_unit_id`).
#[derive(serde::Deserialize)]
struct HandleDto {
    target_unit_id: UnitId,
    name: String,
}

fn to_handle(h: HandleDto) -> Handle {
    Handle {
        id: HandleId(Uuid::nil()),
        space_id: SpaceId(Uuid::nil()),
        name: h.name,
        target_object_id: ObjectId(Uuid::nil()),
        target_unit_id: Some(h.target_unit_id),
        target_expression_id: None,
        status: HandleStatus::Active,
        scope: HandleScope::Object,
        provenance_id: ProvenanceId(Uuid::nil()),
    }
}

/// Project display labels for a document's typed blocks. Input: `blocks_json` =
/// `[{ id, type, parent_unit_id, position }, …]` (document order), `handles_json` =
/// `[{ target_unit_id, name }, …]` (a unit's authored epithet/definiendum, §6.3b), `policy_json` =
/// a `NumberingPolicy`. Output: `{ "labels": [{ unit_id, unit_type, number, name }, …] }` — the core's
/// `DisplayLabels` (number AND name; presentation picks). Malformed JSON degrades to empty, never panics.
#[wasm_bindgen(js_name = displayLabels)]
pub fn display_labels(blocks_json: &str, handles_json: &str, policy_json: &str) -> String {
    let blocks: Vec<BlockDto> = serde_json::from_str(blocks_json).unwrap_or_default();
    let handles: Vec<HandleDto> = serde_json::from_str(handles_json).unwrap_or_default();
    let policy: NumberingPolicy = serde_json::from_str(policy_json).unwrap_or(NumberingPolicy {
        numbered_types: Vec::new(),
        shared_counter: false,
    });
    let units: Vec<Unit> = blocks.into_iter().map(to_unit).collect();
    let handles: Vec<Handle> = handles.into_iter().map(to_handle).collect();
    let labels = project_display_labels(&units, &[], &handles, &policy);
    serde_json::to_string(&labels).unwrap_or_else(|_| r#"{"labels":[]}"#.to_string())
}
