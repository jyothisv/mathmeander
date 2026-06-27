// Move a block (or a whole folded section) up / down — Alt-↑ / Alt-↓. Granularity follows FOLD STATE: a body
// block or an UNFOLDED heading moves as a SINGLE block (it's visually one line); a FOLDED heading moves with
// its WHOLE subtree (the collapsed section is one visual item). This is a pure DOC REORDER — the flush
// recomputes `position` from doc order and `headingResection` recomputes `parentId` from the new `#`-sequence,
// so moving a block across a section boundary re-sections naturally and persists via the normal autosave +
// structural drain (no new core op).
import { type Command, Selection, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { headingIndex } from './cues';
import { isDescendantOf } from './headingDepth';
import { foldedSet } from './headingFold';

/** A movable ITEM = a contiguous run of top-level blocks treated as one: a single block, or (a FOLDED
 *  heading) the heading + its whole descendant subtree. `from`/`to` are doc positions spanning the run. */
interface Item {
  from: number;
  to: number;
}

export function movableItems(doc: PMNode, folded: Set<string>): Item[] {
  const byId = headingIndex(doc);
  const blocks: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, pos) => blocks.push({ node, pos }));
  const out: Item[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    const id = b.node.attrs.unitId as string | null;
    const isFoldedHeading = !!(b.node.attrs.heading as boolean) && !!id && folded.has(id);
    if (isFoldedHeading) {
      // The folded section's descendants are contiguous in doc order (pre-order DFS); span them all.
      let j = i + 1;
      while (j < blocks.length && isDescendantOf(blocks[j]!.node, id, byId)) j += 1;
      const last = blocks[j - 1]!;
      out.push({ from: b.pos, to: last.pos + last.node.nodeSize });
      i = j;
    } else {
      out.push({ from: b.pos, to: b.pos + b.node.nodeSize });
      i += 1;
    }
  }
  return out;
}

/** Items at one section LEVEL: every block whose parent is `parentId`, each paired with its whole descendant
 *  subtree (contiguous in the pre-order doc). Moving a top-level NON-heading block (the config / notation
 *  home) uses this — so it steps OVER a whole adjacent section instead of landing INSIDE it. */
export function levelSiblingItems(doc: PMNode, parentId: string | null): Item[] {
  const byId = headingIndex(doc);
  const blocks: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, pos) => blocks.push({ node, pos }));
  const out: Item[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (((b.node.attrs.parentId as string | null) ?? null) !== parentId) {
      i += 1; // inside another sibling's subtree — it travels with that sibling, not on its own
      continue;
    }
    const id = b.node.attrs.unitId as string | null;
    let j = i + 1;
    // A null-id (unstamped) or non-heading sibling has no addressable subtree → it's a single-block item.
    while (id != null && j < blocks.length && isDescendantOf(blocks[j]!.node, id, byId)) j += 1;
    const last = blocks[j - 1]!;
    out.push({ from: b.pos, to: last.pos + last.node.nodeSize });
    i = j;
  }
  return out;
}

/** Move the block/section containing the caret one item up (`'up'`) or down (`'down'`). No-op (returns false,
 *  so Alt-arrow falls through) for a range selection or at the document boundary.
 *  NOTE (intentional, per the fold-state rule): an UNFOLDED heading moves as a SINGLE line, so Alt-↑ on an
 *  unfolded SUBSECTION past its parent carries only the title — headingResection then re-homes the orphaned
 *  body to the grandparent. It converges + persists (no loss/wedge); FOLD a section to move it wholesale. */
export function moveBlock(dir: 'up' | 'down'): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.$cursor) return false; // only a collapsed caret moves a block
    const $c = sel.$cursor;
    if ($c.depth < 1) return false;
    const blockStart = $c.before(1); // the caret's top-level block start
    const block = $c.node(1); // the top-level block under the caret
    // The config (notation) home is a top-level non-heading block: it steps OVER a whole adjacent section
    // (levelSiblingItems groups each sibling with its subtree) so it can reach the top instead of interleaving
    // INTO a section. Prose bodies + headings keep the fold-state granularity (movableItems), unchanged.
    const list =
      block.type.name === 'config'
        ? levelSiblingItems(state.doc, (block.attrs.parentId as string | null) ?? null)
        : movableItems(state.doc, foldedSet(state));
    const k = list.findIndex((it) => it.from <= blockStart && blockStart < it.to);
    if (k < 0) return false;
    const cur = list[k]!;
    const target = dir === 'up' ? list[k - 1] : list[k + 1];
    if (!target) return false; // at the boundary

    if (dispatch) {
      const offsetInItem = $c.pos - cur.from; // keep the caret at the same spot within the moved item
      const content = state.doc.slice(cur.from, cur.to).content;
      const size = cur.to - cur.from;
      // Delete the moved item, then re-insert it on the far side of the target. For 'up' the target is
      // BEFORE `cur` (unaffected by the delete); for 'down' the target's end shifts left by `size`.
      let tr = state.tr.delete(cur.from, cur.to);
      const insertAt = dir === 'up' ? target.from : target.to - size;
      tr = tr.insert(insertAt, content);
      const caret = Math.min(insertAt + offsetInItem, tr.doc.content.size);
      dispatch(tr.setSelection(Selection.near(tr.doc.resolve(caret), 1)).scrollIntoView());
    }
    return true;
  };
}
