//! The `.mathpack` manifest + serialization (arch doc §10) — slice 1d. The core's share of
//! export/import: build a deterministic manifest over the canonical graph, serialize it, and
//! validate + migrate it back on import. The GLUE assembles the actual `.mathpack` file (zip +
//! asset streaming) around what this module produces.
//!
//! **Core stays hash-free** (decision F / §10). Content hashing pulls `sha2 → cpufeatures →
//! libc`, which `scripts/check-core-deps.sh` denylists and the wasm32 purity gate rejects — so
//! checksums are computed in the I/O shell (the glue, and the `schema-gen`/`core-node` build
//! path that already sha256s the artifact). This module only *validates*, *serializes*, and
//! *imports* (running each object through the migration read path); it never hashes. Asset
//! checksums travel as glue-supplied data (`AssetChecksum`), opaque to the core.
//!
//! Slice 1 carries only the slice-1 entities; sections for deferred tables (sources,
//! annotations, notation, journal_day, review_items) are simply ABSENT until their slice lands.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CoreError, ValidationError};
use crate::ids::SpaceId;
use crate::model::{
    Alias, CanonicalObject, DefinitionDetail, Handle, Link, ObjectVersion, Provenance,
    ProvenanceDerivation, Tag, Tagging, UnitContent,
};
use crate::ops::MathContent;
use crate::validate::{validate_link, validate_prose_inline, validate_tagging};

/// The pack format tag (distinct from the canonical model's `schema_version`).
pub const MATHPACK_FORMAT: &str = "mathmeander.mathpack";
/// The pack format's own version (the envelope shape; bumped if the manifest reshapes).
pub const MATHPACK_FORMAT_VERSION: u32 = 1;

/// The glue-supplied scalars the core cannot derive itself (the space, and asset checksums
/// computed in the I/O shell). Counts and the format/version/schema fields are core-derived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MathpackMeta {
    pub space_id: SpaceId,
    /// One entry per referenced asset; `sha256` is computed in the I/O shell and handed in
    /// (the core never hashes). Empty in slice 1 (no assets until sources, slice 3).
    pub asset_checksums: Vec<AssetChecksum>,
}

/// A content-hashed asset reference (§10). The hash is glue-computed; the core only carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct AssetChecksum {
    pub name: String,
    pub sha256: String,
}

/// Derived element counts, for a self-describing manifest (§10) and a cheap integrity probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MathpackCounts {
    pub objects: u32,
    pub units: u32,
    pub links: u32,
    pub aliases: u32,
    pub handles: u32,
    pub tags: u32,
    pub taggings: u32,
    pub object_versions: u32,
    pub definition_details: u32,
    /// The trust-spine rows travel with the graph (`MathpackGraph.provenance`), so they are
    /// counted too — every graph vec has a count (a complete self-describing manifest).
    pub provenance: u32,
    pub provenance_derivations: u32,
}

/// The manifest header (§10). `format`/`format_version` are pinned consts; `schema_version` is
/// this core's `CURRENT_SCHEMA_VERSION` at export; `created_at` is passed in (the core reads no
/// clock). No content-hash field lives here — the I/O shell wraps the serialized bytes with a
/// checksum sidecar (decision F).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MathpackManifest {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    pub created_at: DateTime<Utc>,
    pub space_id: SpaceId,
    pub counts: MathpackCounts,
    pub assets: Vec<AssetChecksum>,
}

/// The canonical graph over slice-1 entities (§10). One `MathContent` per object carries that
/// object's units. Deferred entity sections are ABSENT (added when their slice lands), so the
/// shape never claims to round-trip tables that don't exist yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MathpackGraph {
    pub objects: Vec<CanonicalObject>,
    /// The provenance rows the graph references — the trust spine travels with the data.
    pub provenance: Vec<Provenance>,
    pub provenance_derivations: Vec<ProvenanceDerivation>,
    /// One per object; `MathContent.units` carries that object's content units.
    pub content: Vec<MathContent>,
    pub links: Vec<Link>,
    pub aliases: Vec<Alias>,
    pub handles: Vec<Handle>,
    pub tags: Vec<Tag>,
    pub taggings: Vec<Tagging>,
    pub object_versions: Vec<ObjectVersion>,
    pub definition_details: Vec<DefinitionDetail>,
}

/// What export produces: a deterministic manifest + the canonical graph. The glue writes this
/// into the actual `.mathpack` (zip + `assets/`) and stamps the checksum sidecar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct Mathpack {
    pub manifest: MathpackManifest,
    pub graph: MathpackGraph,
}

/// What import yields: the validated, per-object-migrated graph with a manifest rebuilt at the
/// current schema version. A distinct type from `Mathpack` so import can diverge later (e.g.
/// id remapping on collision) without reshaping export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct MathpackImport {
    pub manifest: MathpackManifest,
    pub graph: MathpackGraph,
}

/// Validate a manifest header (§10): the format tag and version must match, and the data must
/// not claim a schema newer than this core understands (refusing loudly beats misreading, §2.2).
pub fn validate_mathpack_manifest(manifest: &MathpackManifest) -> Result<(), CoreError> {
    if manifest.format != MATHPACK_FORMAT {
        return Err(CoreError::MalformedInput {
            context: "mathpack manifest".into(),
            message: format!(
                "unexpected format {:?}, expected {MATHPACK_FORMAT:?}",
                manifest.format
            ),
        });
    }
    if manifest.format_version != MATHPACK_FORMAT_VERSION {
        return Err(CoreError::MalformedInput {
            context: "mathpack manifest".into(),
            message: format!(
                "unsupported format_version {}, this core handles {MATHPACK_FORMAT_VERSION}",
                manifest.format_version
            ),
        });
    }
    if manifest.schema_version > crate::CURRENT_SCHEMA_VERSION {
        return Err(ValidationError::SchemaVersionFromTheFuture {
            given: manifest.schema_version,
            current: crate::CURRENT_SCHEMA_VERSION,
        }
        .into());
    }
    Ok(())
}

/// Build an export bundle: derive counts, stamp the manifest at the current schema version with
/// the passed-in `now`, validate it, and pair it with the graph. The manifest is deterministic
/// given the graph; the core preserves the caller's row order verbatim, so byte-reproducible
/// export (for the glue's checksum sidecar, decision F) requires the glue to query the graph in a
/// canonical (e.g. id) order — that ordering is the glue's contract, not enforced here.
pub fn serialize_mathpack(
    meta: &MathpackMeta,
    graph: MathpackGraph,
    now: DateTime<Utc>,
) -> Result<Mathpack, CoreError> {
    let manifest = MathpackManifest {
        format: MATHPACK_FORMAT.to_string(),
        format_version: MATHPACK_FORMAT_VERSION,
        schema_version: crate::CURRENT_SCHEMA_VERSION,
        created_at: now,
        space_id: meta.space_id,
        counts: derive_counts(&graph),
        assets: meta.asset_checksums.clone(),
    };
    validate_mathpack_manifest(&manifest)?;
    Ok(Mathpack { manifest, graph })
}

/// Import a bundle (UNTRUSTED external input). In order: validate the manifest envelope; migrate
/// every object HEADER through the read path (`parse_and_migrate_object`; units are deserialized
/// directly — migration is header-only today, the open "one `schema_version` governs the whole
/// document incl. its units" rule); then SEMANTICALLY validate the graph body (`validate_graph`)
/// and verify the declared counts match it, refusing loudly on either (§2.2). Finally rebuild the
/// manifest's counts + schema_version. The core never verifies asset checksums (the I/O shell does
/// that before calling this).
pub fn import_mathpack(bundle: Value) -> Result<MathpackImport, CoreError> {
    // Objects come in as raw values so each can flow through migration BEFORE being typed; the
    // rest of the graph is version-stable this slice and is deserialized directly.
    #[derive(Deserialize)]
    struct RawBundle {
        manifest: MathpackManifest,
        graph: RawGraph,
    }
    #[derive(Deserialize)]
    struct RawGraph {
        objects: Vec<Value>,
        provenance: Vec<Provenance>,
        provenance_derivations: Vec<ProvenanceDerivation>,
        content: Vec<MathContent>,
        links: Vec<Link>,
        aliases: Vec<Alias>,
        handles: Vec<Handle>,
        tags: Vec<Tag>,
        taggings: Vec<Tagging>,
        object_versions: Vec<ObjectVersion>,
        definition_details: Vec<DefinitionDetail>,
    }

    let raw: RawBundle = serde_json::from_value(bundle).map_err(|e| CoreError::MalformedInput {
        context: "mathpack bundle".into(),
        message: e.to_string(),
    })?;
    validate_mathpack_manifest(&raw.manifest)?;

    let mut objects = Vec::with_capacity(raw.graph.objects.len());
    for object in raw.graph.objects {
        objects.push(crate::migrate::parse_and_migrate_object(object)?);
    }

    let graph = MathpackGraph {
        objects,
        provenance: raw.graph.provenance,
        provenance_derivations: raw.graph.provenance_derivations,
        content: raw.graph.content,
        links: raw.graph.links,
        aliases: raw.graph.aliases,
        handles: raw.graph.handles,
        tags: raw.graph.tags,
        taggings: raw.graph.taggings,
        object_versions: raw.graph.object_versions,
        definition_details: raw.graph.definition_details,
    };
    // The §6.1a invariants the DB can't FK-check — import is the only gate (refuse loudly, §2.2).
    validate_graph(&graph)?;
    // The manifest's declared counts must match its body, or the pack is corrupt/truncated.
    // (Assumes migration preserves row cardinality — true today: migrations reshape fields, never
    // add or remove rows. Revisit if a migration ever splits/merges rows.)
    let counts = derive_counts(&graph);
    if raw.manifest.counts != counts {
        return Err(CoreError::MalformedInput {
            context: "mathpack manifest".into(),
            message: "declared counts disagree with the graph body".into(),
        });
    }
    let manifest = MathpackManifest {
        schema_version: crate::CURRENT_SCHEMA_VERSION,
        counts,
        ..raw.manifest
    };
    Ok(MathpackImport { manifest, graph })
}

/// Count the slice-1 entities for the self-describing manifest. `units` sums each object's
/// content units.
fn derive_counts(graph: &MathpackGraph) -> MathpackCounts {
    let units: usize = graph.content.iter().map(|c| c.units.len()).sum();
    MathpackCounts {
        objects: graph.objects.len() as u32,
        units: units as u32,
        links: graph.links.len() as u32,
        aliases: graph.aliases.len() as u32,
        handles: graph.handles.len() as u32,
        tags: graph.tags.len() as u32,
        taggings: graph.taggings.len() as u32,
        object_versions: graph.object_versions.len() as u32,
        definition_details: graph.definition_details.len() as u32,
        provenance: graph.provenance.len() as u32,
        provenance_derivations: graph.provenance_derivations.len() as u32,
    }
}

/// Semantically validate an imported graph body — the §6.1a invariants a relational schema can't
/// FK-check, which the core owns (`crate::validate`). A `.mathpack` is UNTRUSTED external input
/// (another instance, a hand-edited file, a third-party exporter), so import must run the SAME
/// gate the ops run, over ALL content — fulfilling the `validate.rs` "1d's load path runs it over
/// all content" contract. Refuses loudly (§2.2). `pub` so the Pass-2 glue can reuse it.
///
/// Scope: INTRA-ROW invariants only — full inline well-formedness (in-bounds spans + zero-width
/// atoms, `validate_prose_inline`), exactly-one link / tagging target + content-edge anchors
/// (`validate_link` / `validate_tagging`). REFERENTIAL integrity — does a `target_unit_id` /
/// `provenance_id` / `content.object_id` resolve WITHIN the pack — is the database's job at INSERT
/// (composite FKs, Pass 2), not here.
pub fn validate_graph(graph: &MathpackGraph) -> Result<(), CoreError> {
    for content in &graph.content {
        for unit in &content.units {
            if let UnitContent::Prose { text, inline } = &unit.content {
                validate_prose_inline(text, inline)?;
            }
        }
    }
    for link in &graph.links {
        validate_link(link)?;
    }
    for tagging in &graph.taggings {
        validate_tagging(tagging)?;
    }
    Ok(())
}
