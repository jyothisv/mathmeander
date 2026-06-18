//! The numbering / display-name projection (arch doc §6.3b) — slice 1d. A PURE projection
//! over one object's units: it computes, for each unit, a display label made of a stable
//! ordinal (the "Theorem 1.2" number) and/or an optional human name.
//!
//! Two disciplines hold here (§6.3b / §6):
//!   • **Policy is passed in, never stored.** Which unit types get numbered, and whether one
//!     counter spans them all, is presentation config (`NumberingPolicy`) — so the math /
//!     presentation split holds and the core stays policy-free. The projection stores nothing;
//!     reordering recomputes, and stable ids (edges, handles) keep pointing at the same units.
//!   • **A name beats a number for DISPLAY, but the projection returns BOTH** (decision G). The
//!     projection never drops the computed number just because a name exists — that precedence
//!     is the presentation layer's call. A user names a unit/expression via a `handle`, and an
//!     object (shown on an `embed` unit) via an `alias`; where a name exists it is what chips
//!     and `[[ ]]` candidates show, otherwise the computed number shows.
//!
//! Determinism: labels are computed over true reading order — a **pre-order** walk (top-level
//! units by position, each immediately followed by its descendants by position), never the input
//! vec order — so feeding the same units in any order yields the same labels, and a nested
//! numbered unit gets the ordinal its reading position implies.
//!
//! Scope (slice-1 scaffolding, arch §13a.1): numbering is keyed by `unit_type`. Equation
//! numbering — the future "(3.2)" that attaches to a *display-math placement* (§6.3a), whose unit
//! is typeless (`content = Math`, `type = None`) — is NOT expressible here, and `UnitLabel` is
//! unit-keyed rather than expression-keyed. That's a deliberate later extension, not this shape.

use serde::{Deserialize, Serialize};

use crate::ids::UnitId;
use crate::model::{Alias, EmbedTarget, Handle, HandleStatus, Unit, UnitContent, UnitType};

/// Presentation config for the numbering projection (§6.3b) — passed in, never stored, so
/// the core stays policy-free. The numbering *policy* (which types count, one counter vs
/// per-type) lives entirely here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct NumberingPolicy {
    /// The unit types that participate in numbering. A unit whose `type` is absent from this
    /// list gets no number (`number = None`). Order is irrelevant to the result.
    pub numbered_types: Vec<UnitType>,
    /// `true` → ONE counter runs across every numbered type (a single document sequence:
    /// Theorem 1, Definition 2, Lemma 3…); `false` → each type counts independently
    /// (Theorem 1, Theorem 2, Definition 1…).
    pub shared_counter: bool,
}

/// One unit's computed label facets (§6.3b, decision G). BOTH are returned; presentation
/// decides whether the name supersedes the number. `number`/`name` are independently optional.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct UnitLabel {
    pub unit_id: UnitId,
    /// Echoed so presentation can render "Theorem 3" without re-reading the unit. `None` for
    /// a plain (typeless) unit.
    pub unit_type: Option<UnitType>,
    /// The 1-based ordinal among its counter class; `None` when the policy doesn't number this
    /// unit's type.
    pub number: Option<u32>,
    /// A user name override (a `handle` on the unit, or — for an object `embed` — the embedded
    /// object's `alias`). Where present it is what a chip shows; the `number` is still returned.
    pub name: Option<String>,
}

/// The projection's output: one `UnitLabel` per input unit, in stable document order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema-artifact", derive(schemars::JsonSchema))]
pub struct DisplayLabels {
    pub labels: Vec<UnitLabel>,
}

/// Project display labels for one object's units (§6.3b). Pure and infallible: policy is
/// passed in, the result is recomputed on every write, nothing is stored.
pub fn project_display_labels(
    units: &[Unit],
    aliases: &[Alias],
    handles: &[Handle],
    policy: &NumberingPolicy,
) -> DisplayLabels {
    // Number over true reading order (pre-order) — never the input vec order — so the labels are
    // reorder-invariant AND a nested numbered unit gets its reading-position ordinal.
    let ordered = document_order(units);

    // Counters: one shared running count, or one per numbered type (keyed by its index in
    // `numbered_types` — `UnitType` needn't be `Hash`). `saturating_add` keeps the pure core
    // panic-free (matching the surface serializer), even on absurd inputs.
    let mut shared: u32 = 0;
    let mut per_type: Vec<u32> = vec![0; policy.numbered_types.len()];

    let mut labels = Vec::with_capacity(ordered.len());
    for u in ordered {
        let class = u
            .unit_type
            .and_then(|t| policy.numbered_types.iter().position(|&x| x == t));
        let number = class.map(|i| {
            if policy.shared_counter {
                shared = shared.saturating_add(1);
                shared
            } else {
                per_type[i] = per_type[i].saturating_add(1);
                per_type[i]
            }
        });
        let name = handle_name(handles, u.id).or_else(|| embed_alias_name(aliases, &u.content));
        labels.push(UnitLabel {
            unit_id: u.id,
            unit_type: u.unit_type,
            number,
            name,
        });
    }
    DisplayLabels { labels }
}

/// Units in true reading order (pre-order): top-level units (`parent = None`) by `(position, id)`,
/// each immediately followed by its descendants by `(position, id)` — NOT the input vec order.
/// Total and cycle-safe: a `visited` set guards against parent cycles, and any units never reached
/// from a root (an orphaned/dangling parent, or a cycle) are appended in a deterministic
/// `(parent, position, id)` order so every unit gets exactly one label.
fn document_order(units: &[Unit]) -> Vec<&Unit> {
    use std::collections::{HashMap, HashSet};

    let mut children: HashMap<Option<UnitId>, Vec<&Unit>> = HashMap::new();
    for u in units {
        children.entry(u.parent_unit_id).or_default().push(u);
    }
    for list in children.values_mut() {
        list.sort_by_key(|u| (u.position, u.id.0));
    }

    let mut ordered: Vec<&Unit> = Vec::with_capacity(units.len());
    let mut visited: HashSet<UnitId> = HashSet::new();
    // Iterative pre-order from the roots (avoids recursion depth limits on deep nesting).
    let mut stack: Vec<&Unit> = children.get(&None).cloned().unwrap_or_default();
    stack.reverse(); // so the first root (lowest position) is popped first
    while let Some(u) = stack.pop() {
        if !visited.insert(u.id) {
            continue; // a cycle pointed back at an already-emitted unit
        }
        ordered.push(u);
        if let Some(kids) = children.get(&Some(u.id)) {
            for kid in kids.iter().rev() {
                stack.push(kid); // reversed push → first child popped first
            }
        }
    }

    if ordered.len() < units.len() {
        // Orphans (dangling parent) and cycle members were never reached — append deterministically.
        let mut leftovers: Vec<&Unit> = units.iter().filter(|u| !visited.contains(&u.id)).collect();
        leftovers.sort_by_key(|u| (u.parent_unit_id.map(|p| p.0), u.position, u.id.0));
        for u in leftovers {
            if visited.insert(u.id) {
                ordered.push(u);
            }
        }
    }
    ordered
}

/// The active handle naming this unit, if any (deterministic min-by-id when several exist).
fn handle_name(handles: &[Handle], unit_id: UnitId) -> Option<String> {
    handles
        .iter()
        .filter(|h| h.status == HandleStatus::Active && h.target_unit_id == Some(unit_id))
        .min_by_key(|h| h.id.0)
        .map(|h| h.name.clone())
}

/// For an object `embed` unit, the embedded object's alias name (deterministic min-by-id).
/// Aliases name OBJECTS (handles name intra-object elements), so they surface only here.
fn embed_alias_name(aliases: &[Alias], content: &UnitContent) -> Option<String> {
    let UnitContent::Embed {
        target: EmbedTarget::Object { object_id },
    } = content
    else {
        return None;
    };
    aliases
        .iter()
        .filter(|a| a.object_id == *object_id)
        .min_by_key(|a| a.id.0)
        .map(|a| a.name.clone())
}
