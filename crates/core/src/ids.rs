//! Typed id newtypes. Representation accepts any well-formed UUID (so stored data and
//! fixtures always parse); the UUIDv7 requirement for newly minted ids (arch doc §4/§6.3
//! — sortable, client-mintable) is a CREATE-TIME validation invariant enforced in
//! `validate`, yielding typed errors instead of serde failures.
//!
//! The core never mints ids — minting needs entropy. Object ids are client-minted;
//! provenance ids are glue-minted; both are validated here.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_newtype {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn is_uuid_v7(&self) -> bool {
                self.0.get_version_num() == 7
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

id_newtype!(
    /// Identity of a canonical object (client-minted UUIDv7).
    ObjectId
);
id_newtype!(
    /// Identity of a space (glue-minted UUIDv7).
    SpaceId
);
id_newtype!(
    /// Identity of a provenance row (glue-minted UUIDv7).
    ProvenanceId
);

// ── Slice 1 canonical-object-core entities (arch doc §6) ──────────────────────
// All client- or glue-minted UUIDv7, like the above; the core mints none of them.

id_newtype!(
    /// Identity of a content unit (`content_units` row, §6.0b) — what annotations
    /// anchor to, AI candidates target, and edges point at.
    UnitId
);
id_newtype!(
    /// Identity of an edge (`links` row, §6.1b).
    LinkId
);
id_newtype!(
    /// Identity of a `MathExpression` (§6.3a). Minted in content, presentation-
    /// independent, and unique workspace-wide (the copy-mints-fresh rule, §6.3a).
    /// Lives inside serialized `UnitContent`, not its own table.
    ExpressionId
);
id_newtype!(
    /// Identity of an alias (`aliases` row, §6.3b) — a name for an object.
    AliasId
);
id_newtype!(
    /// Identity of a handle (`handles` row, §6.3b) — a user name for an intra-object
    /// element (a unit or expression).
    HandleId
);
id_newtype!(
    /// Identity of a tag (`tags` row, §6.0b).
    TagId
);
id_newtype!(
    /// Identity of a tagging (`taggings` row, §6.0b) — a tag applied to a target.
    TaggingId
);
id_newtype!(
    /// Identity of a version checkpoint (`object_versions` row, §6.4).
    ObjectVersionId
);
id_newtype!(
    /// Identity of an `annotation_target` row (§6.2) — the anchor rows a brace/embrace
    /// annotation binds to. The annotation itself IS an object (`ObjectType::Annotation`), so
    /// its identity is an `ObjectId`; a target needs its own id because a primitive draws over
    /// its target row(s) and orphaning flips a target's status by id.
    AnnotationTargetId
);
