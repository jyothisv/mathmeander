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
