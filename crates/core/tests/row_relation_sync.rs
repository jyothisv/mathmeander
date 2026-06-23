//! Mechanical sync gate: the core `RowRelation` enum must stay ⊆ AND ⊇ the surface grammar's
//! relation set (`SYMBOLIC_RELATIONS ∪ WORD_RELATIONS`). `Unit.row_relation` (slice 2-A, the
//! math-row model) carries one of these per row; letting the enum drift from the grammar would mean
//! a row could assert a relation the parser doesn't recognize (or vice versa). A new grammar
//! relation, or a new/removed `RowRelation` variant, that isn't mirrored on the other side is a red
//! build here. (`RowRelation::token()` is a non-wildcard match, so adding a variant forces a token
//! decision; this test then catches a token that isn't a real grammar relation, and a grammar
//! relation with no variant.)

use std::collections::BTreeSet;

use mathmeander_core::model::RowRelation;
use mathmeander_surface::grammar::{SYMBOLIC_RELATIONS, WORD_RELATIONS};

#[test]
fn row_relation_tokens_equal_grammar_relations() {
    let from_enum: BTreeSet<&str> = RowRelation::ALL.iter().map(|r| r.token()).collect();
    let from_grammar: BTreeSet<&str> = SYMBOLIC_RELATIONS
        .iter()
        .chain(WORD_RELATIONS)
        .copied()
        .collect();

    assert_eq!(
        from_enum, from_grammar,
        "RowRelation drifted from the grammar relation set — add/remove a variant (and its token) \
         to match SYMBOLIC_RELATIONS ∪ WORD_RELATIONS (slice 2-A §F2 invariant)"
    );
    // No two variants collide onto the same token (ALL has 13 entries; the set must too).
    assert_eq!(
        from_enum.len(),
        RowRelation::ALL.len(),
        "two RowRelation variants map to the same grammar token"
    );
}
