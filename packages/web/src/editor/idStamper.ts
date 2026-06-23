// The unit-identity stamper (extracted from DayEditor so it is node-testable: deps are only
// prosemirror-state + uuid). Every prose block carries a client-minted `unitId` (§6.3) so the flush
// distinguishes new-vs-existing by id and never double-creates. The plugin runs as an appendTransaction
// after every change and enforces TWO things in one pass, walking the doc in DOCUMENT ORDER:
//   1. a block with a `null` id gets a fresh one (a brand-new block);
//   2. a block whose id was ALREADY SEEN earlier in the doc gets re-minted — so the FIRST occurrence keeps
//      the id and any duplicate is replaced. This kills the duplicate-id-on-split class of bug at the
//      source: ProseMirror's `splitBlock` copies a block's attrs (incl. `unitId`) onto the new half, which
//      would otherwise send the same id twice in one save and trip the core's one-home gate (§6.0b) — a
//      deterministic 422 that strands the editor on "Couldn't save". Firing on the split transaction means
//      live edits never hit it; firing via `stampNullIds` on restore auto-heals an already-stuck draft.
import { Plugin } from 'prosemirror-state';
import { v7 as uuidv7 } from 'uuid';

export const idStamper = new Plugin({
  appendTransaction(_trs, _oldState, newState) {
    const seen = new Set<string>();
    let tr: ReturnType<typeof newState.tr.setNodeAttribute> | null = null;
    newState.doc.descendants((node, pos) => {
      // Identity-bearing blocks are prose blocks (display equations are prose blocks too — a `$$…$$` span).
      if (node.type.name !== 'prose') return false;
      const id = node.attrs.unitId as string | null;
      if (id == null || seen.has(id)) {
        tr = (tr ?? newState.tr).setNodeAttribute(pos, 'unitId', uuidv7());
      } else {
        seen.add(id);
      }
      return false;
    });
    return tr ?? null;
  },
});
