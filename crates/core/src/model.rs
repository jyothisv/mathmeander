//! Canonical vocabulary types (arch doc §6). These enums are the ONLY home of the
//! evolving kind vocabularies — Postgres stores them as plain text, the schema artifact
//! exports them, and generated zod validates them at the HTTP edge. Adding a variant is
//! a compiler-guided core change (arch doc §5), never a DB migration.

use serde::{Deserialize, Serialize};

use crate::ids::{ObjectId, ProvenanceId, SpaceId};

/// Durable workspace identity of an object (arch doc §6.0b: `object.type` ≠ `unit.type`).
/// Walking skeleton accepts only `note`; slice 1 adds the formal family
/// (theorem/lemma/proposition/corollary/conjecture/claim), definition, proof, example,
/// question, source_excerpt, trail, annotation — each a new variant here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ObjectType {
    Note,
}

/// Object lifecycle (arch doc §5.2/§6) — the full, doc-stable set lands now even though
/// the skeleton's create path can only PRODUCE `Draft`; other values become producible
/// via future status-transition operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ObjectStatus {
    Raw,
    Draft,
    AiDrafted,
    UserVerified,
    Trusted,
    NeedsReview,
    Deprecated,
}

/// Provenance origin (arch doc §6.1). Stable, complete set; only `User` and `System`
/// are producible until the AI/import provenance columns land with their slices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    User,
    Ai,
    Imported,
    System,
}

/// A canonical object — the doc's §6 `objects` row shape, verbatim (all eleven fields).
/// Content (`content_units`/MathContent) is a SEPARATE aggregate arriving in slice 1;
/// an object with zero units is valid, which is what makes that addition purely
/// structural. Named `CanonicalObject` (not `Object`) so the generated TS type never
/// shadows JavaScript's global `Object`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct CanonicalObject {
    /// Client-minted UUIDv7 (arch doc §4/§6.3).
    pub id: ObjectId,
    #[serde(rename = "type")]
    pub object_type: ObjectType,
    /// Tri-state (§6.3): `None` = unset, `Some("")` = explicitly empty — never collapsed.
    pub title: Option<String>,
    /// The rough input, preserved VERBATIM (§2.2). No normalization function exists.
    pub raw_source: Option<String>,
    pub status: ObjectStatus,
    /// Application-level model version (§6.3); migrated by the core's total functions.
    pub schema_version: u32,
    /// Optimistic-concurrency token (§6.4): increments on every persisted write.
    pub revision: u32,
    pub provenance_id: ProvenanceId,
    pub space_id: SpaceId,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    /// Unknown-field preservation (§2.2/§6.3): fields this core version does not know
    /// survive parse → edit → store round trips instead of being silently dropped
    /// (e.g. data from a newer minor import). Never interpreted, only carried.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Provenance — the typed trust spine (arch doc §6.1). One row per provenanced fact;
/// origin-specific fields (model, prompt_template, context_snapshot_id, review_item_id,
/// source_id, source_locator) arrive as `Option` fields together with their target
/// tables — additive in Rust and SQL simultaneously.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct Provenance {
    pub id: ProvenanceId,
    pub origin: Origin,
    /// User/agent id. Required when `origin = user` (arch doc §6.1a) — enforced by
    /// validation, not by the shape.
    pub created_by: Option<String>,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
}
