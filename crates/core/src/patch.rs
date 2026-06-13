//! `Patch<T>` — the tri-state field discipline (arch doc §6.3) in miniature:
//! a patch field is *absent* (leave unchanged), *null* (clear to unset), or *a value*
//! (set). Migrations and edits must never collapse "absent" into "clear" — this type
//! makes the three states unrepresentable as each other.
//!
//! Wire form: absent field ⇒ `Absent` (via `#[serde(default)]` on the containing
//! field), `null` ⇒ `Clear`, value ⇒ `Set(v)`. Always pair with
//! `#[serde(default, skip_serializing_if = "Patch::is_absent")]`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Patch<T> {
    /// Field not present in the patch — leave the current value unchanged.
    #[default]
    Absent,
    /// Field present as `null` — clear the value back to unset.
    Clear,
    /// Field present with a value — set it.
    Set(T),
}

impl<T> Patch<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Patch::Absent)
    }

    /// Resolve this patch against the current `Option` value.
    pub fn apply_to(self, current: Option<T>) -> Option<T> {
        match self {
            Patch::Absent => current,
            Patch::Clear => None,
            Patch::Set(v) => Some(v),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Only reached when the field IS present (absence is handled by serde(default)).
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(v) => Patch::Set(v),
            None => Patch::Clear,
        })
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            // Absent fields are skipped via skip_serializing_if; serializing one anyway
            // degrades to null rather than inventing a marker value.
            Patch::Absent | Patch::Clear => serializer.serialize_none(),
            Patch::Set(v) => serializer.serialize_some(v),
        }
    }
}

#[cfg(feature = "schema-artifact")]
impl<T: schemars::JsonSchema> schemars::JsonSchema for Patch<T> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("Patch_{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        // Same wire shape as Option<T>: T or null (absence is expressed by the field
        // not being required on the containing object).
        Option::<T>::json_schema(generator)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Holder {
        #[serde(default, skip_serializing_if = "Patch::is_absent")]
        title: Patch<String>,
    }

    #[test]
    fn absent_null_and_value_are_three_distinct_states() {
        let absent: Holder = serde_json::from_str(r#"{}"#).unwrap();
        let clear: Holder = serde_json::from_str(r#"{"title":null}"#).unwrap();
        let set: Holder = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        assert_eq!(absent.title, Patch::Absent);
        assert_eq!(clear.title, Patch::Clear);
        assert_eq!(set.title, Patch::Set("x".to_string()));
        // And the empty string is a VALUE, never collapsed into clear/unset (§6.3).
        let empty: Holder = serde_json::from_str(r#"{"title":""}"#).unwrap();
        assert_eq!(empty.title, Patch::Set(String::new()));
    }

    #[test]
    fn serialization_round_trips_present_states() {
        assert_eq!(
            serde_json::to_string(&Holder {
                title: Patch::Absent
            })
            .unwrap(),
            "{}"
        );
        assert_eq!(
            serde_json::to_string(&Holder {
                title: Patch::Clear
            })
            .unwrap(),
            r#"{"title":null}"#
        );
        assert_eq!(
            serde_json::to_string(&Holder {
                title: Patch::Set("x".into())
            })
            .unwrap(),
            r#"{"title":"x"}"#
        );
    }
}
