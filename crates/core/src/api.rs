//! The core's FFI surface: string-in/string-out PURE functions, wrapped 1:1 by the
//! napi addon (and, later, a WASM build — same functions). JSON strings cross the
//! boundary; results are ENVELOPES (`{ok:true,value}` / `{ok:false,error}`) — domain
//! failures are values, never exceptions (arch doc §17).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::model::{CanonicalObject, Provenance};
use crate::validate::{CreateContext, CreateObjectInput, ObjectPatch};

/// Serializes as literal `true`; gives the envelope a real discriminator in the
/// schema artifact (and a `z.literal(true)` in generated zod).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OkTrue;

/// Serializes as literal `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OkFalse;

impl Serialize for OkTrue {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}
impl Serialize for OkFalse {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(false)
    }
}
impl<'de> Deserialize<'de> for OkTrue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match bool::deserialize(d)? {
            true => Ok(OkTrue),
            false => Err(serde::de::Error::custom("expected literal true")),
        }
    }
}
impl<'de> Deserialize<'de> for OkFalse {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match bool::deserialize(d)? {
            false => Ok(OkFalse),
            true => Err(serde::de::Error::custom("expected literal false")),
        }
    }
}

#[cfg(feature = "schema-artifact")]
mod ok_schemas {
    use super::{OkFalse, OkTrue};

    impl schemars::JsonSchema for OkTrue {
        fn schema_name() -> std::borrow::Cow<'static, str> {
            "OkTrue".into()
        }
        fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
            schemars::json_schema!({ "type": "boolean", "const": true })
        }
    }
    impl schemars::JsonSchema for OkFalse {
        fn schema_name() -> std::borrow::Cow<'static, str> {
            "OkFalse".into()
        }
        fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
            schemars::json_schema!({ "type": "boolean", "const": false })
        }
    }
}

macro_rules! core_result {
    ($(#[$doc:meta])* $name:ident, $ok:ty) => {
        $(#[$doc])*
        #[derive(Debug, Serialize, Deserialize)]
        #[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
        #[serde(untagged)]
        // Envelopes are constructed once and serialized immediately; the Ok/Err size
        // skew clippy flags is irrelevant here.
        #[allow(clippy::large_enum_variant)]
        pub enum $name {
            Ok { ok: OkTrue, value: $ok },
            Err { ok: OkFalse, error: CoreError },
        }

        impl $name {
            fn from_result(r: Result<$ok, CoreError>) -> Self {
                match r {
                    Result::Ok(value) => Self::Ok { ok: OkTrue, value },
                    Result::Err(error) => Self::Err { ok: OkFalse, error },
                }
            }

            fn to_json(&self) -> String {
                serde_json::to_string(self).expect("envelope serializes")
            }
        }
    };
}

/// What a successful create yields: both rows the glue persists in ONE transaction.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct CreatedObject {
    pub object: CanonicalObject,
    pub provenance: Provenance,
}

core_result!(
    /// Envelope of `create_object`.
    CreateObjectResult, CreatedObject
);
core_result!(
    /// Envelope of `apply_title_patch` and `parse_and_migrate_object`.
    ObjectResult, CanonicalObject
);

fn parse_input<T: serde::de::DeserializeOwned>(
    context: &'static str,
    json: &str,
) -> Result<T, CoreError> {
    serde_json::from_str(json).map_err(|e| CoreError::MalformedInput {
        context: context.into(),
        message: e.to_string(),
    })
}

fn parse_now(now_iso: &str) -> Result<DateTime<Utc>, CoreError> {
    DateTime::parse_from_rfc3339(now_iso)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|e| CoreError::MalformedInput {
            context: "now".into(),
            message: e.to_string(),
        })
}

/// Create: untrusted input + server context + now → (object, provenance) envelope.
pub fn create_object(input_json: &str, ctx_json: &str, space_id: &str, now_iso: &str) -> String {
    let result = (|| {
        let input: CreateObjectInput = parse_input("create input", input_json)?;
        let ctx: CreateContext = parse_input("create context", ctx_json)?;
        let now = parse_now(now_iso)?;
        let (object, provenance) = crate::validate::create_object(&input, &ctx, space_id, now)?;
        Ok(CreatedObject { object, provenance })
    })();
    CreateObjectResult::from_result(result).to_json()
}

/// Patch object metadata (pure; concurrency is the glue's conditional UPDATE, §6.4).
pub fn apply_title_patch(current_json: &str, patch_json: &str, now_iso: &str) -> String {
    let result = (|| {
        let current: CanonicalObject = parse_input("current object", current_json)?;
        let patch: ObjectPatch = parse_input("patch", patch_json)?;
        let now = parse_now(now_iso)?;
        Ok(crate::validate::apply_title_patch(&current, &patch, now)?)
    })();
    ObjectResult::from_result(result).to_json()
}

/// The read path: stored JSON → migrate → validate → canonical object envelope.
pub fn parse_and_migrate_object(stored_json: &str) -> String {
    let result = (|| {
        let stored: serde_json::Value = parse_input("stored object", stored_json)?;
        crate::migrate::parse_and_migrate_object(stored)
    })();
    ObjectResult::from_result(result).to_json()
}
