//! Typed validation errors — serde tagged unions carried in the schema artifact, so the
//! glue maps core errors to HTTP error envelopes WITHOUT interpretation (the error `code`
//! the client sees IS the serde tag). This union is also the type-gen pipeline's
//! representative hard case: internally tagged, variants with and without fields.

use serde::{Deserialize, Serialize};

use crate::model::Origin;

/// A domain validation failure. Errors are VALUES crossing the FFI (result envelopes),
/// never exceptions (arch doc §17 boundary discipline).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ValidationError {
    #[error("unknown object type: {given}")]
    UnknownObjectType { given: String },

    #[error("{field} is not a valid UUID")]
    InvalidId { field: String },

    /// Client-minted ids must be UUIDv7 (arch doc §4/§6.3 — sortable, client-mintable).
    #[error("{field} is not a UUIDv7")]
    NotUuidV7 { field: String },

    #[error("title exceeds {max_chars} characters (got {given_chars})")]
    TitleTooLong { max_chars: u32, given_chars: u32 },

    #[error("raw_source exceeds {max_bytes} bytes (got {given_bytes})")]
    RawSourceTooLarge { max_bytes: u64, given_bytes: u64 },

    /// First §6.1a origin-field invariant: `created_by` is required when origin = user.
    #[error("created_by is required when origin is {origin:?}")]
    MissingCreatedBy { origin: Origin },

    /// AI/import provenance is structurally impossible until its columns land (§6.1).
    #[error("origin {origin:?} is not producible yet")]
    OriginNotProducible { origin: Origin },

    #[error("schema_version mismatch: expected {expected}, got {given}")]
    SchemaVersionMismatch { expected: u32, given: u32 },

    /// A stored value claims a schema_version newer than this core understands —
    /// refusing loudly beats misreading user data (§2.2).
    #[error("stored schema_version {given} is newer than current {current}")]
    SchemaVersionFromTheFuture { given: u32, current: u32 },
}

/// Errors crossing the FFI result envelope: a domain validation failure, or input that
/// did not even parse as the expected shape. Tagged so the glue dispatches without
/// string-matching.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreError {
    #[error("malformed {context}: {message}")]
    MalformedInput { context: String, message: String },

    #[error(transparent)]
    Validation {
        #[serde(flatten)]
        #[from]
        error: ValidationError,
    },
}
