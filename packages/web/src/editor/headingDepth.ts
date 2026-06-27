// §B outline editing (slice 3c-1) — Tab / Shift-Tab to change a heading's DEPTH (indent / outdent a
// section). The `#` count is the SOURCE OF TRUTH for depth: headingRecognize derives `parentId` from it
// (via parentForHeadingDepth). So a depth change REWRITES the `#` prefix — never sets `parentId` directly
// (the recognizer would overwrite it). Indenting/outdenting a section must shift the `#` count of the
// heading AND every DESCENDANT heading by the same delta in ONE transaction (else the recognizer reparents
// subsections from stale `#` counts). The recognizer then recomputes `parentId`; the existing structural
// drain (structuralNeeds → drainStructure → reparent_unit) persists it. Editor-only; no canonical edit here.
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { headingDepthOf, headingIndex, parentForHeadingDepth } from './cues';
import { HEADING_PREFIX_RE } from './headingSyntax';

/** Does `block`'s `parentId` chain reach `ancestorId`? (cycle-guarded). */
export function isDescendantOf(block: PMNode, ancestorId: string, byId: Map<string, PMNode>): boolean {
  let pid = block.attrs.parentId as string | null;
  const guard = new Set<string>();
  while (pid && !guard.has(pid)) {
    if (pid === ancestorId) return true;
    guard.add(pid);
    pid = (byId.get(pid)?.attrs.parentId as string | null) ?? null;
  }
  return false;
}

/** The doc positions of the HEADING blocks in a heading's subtree (the heading itself + every descendant
 *  heading — the blocks that carry a `#` prefix to shift). Body (non-heading) descendants need no text
 *  change: their `parentId` is unchanged and `reparent_unit` moves them with the section canonically; their
 *  visual depth (headingIndent) recomputes from the chain. Returned in DESCENDING position order so editing
 *  the `#` runs left-to-untouched stays position-stable. */
export function subtreeHeadingPositions(
  doc: PMNode,
  headingPos: number,
  headingId: string | null,
  byId: Map<string, PMNode>,
): number[] {
  const out: number[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== 'prose' || !(block.attrs.heading as boolean)) return;
    const inSubtree =
      offset === headingPos || (headingId != null && isDescendantOf(block, headingId, byId));
    if (!inSubtree) return;
    if (HEADING_PREFIX_RE.test(block.textContent)) out.push(offset); // defensive: only blocks with a prefix
  });
  return out.sort((a, b) => b - a); // descending
}

/** Tab (`delta:1`, indent) / Shift-Tab (`delta:-1`, outdent) on a heading. Returns false for a range
 *  selection or a non-heading block (Tab falls through). Clamps are SWALLOWED (handled, no edit): outdent at
 *  depth 1 (never demote to prose — that's the Backspace-prefix gesture), and indent with no preceding
 *  heading at the current depth to nest under (would make the `#` count disagree with parentForHeadingDepth's
 *  clamp). Otherwise shift the `#` prefix of the whole subtree by `delta`; the recognizer + drain do the rest. */
export function changeHeadingDepth(delta: 1 | -1): Command {
  return (state: EditorState, dispatch) => {
    const { $cursor } = state.selection as TextSelection;
    if (!$cursor || $cursor.parent.type.name !== 'prose') return false;
    const block = $cursor.parent;
    if (!(block.attrs.heading as boolean)) return false; // a body block → fall through (Tab default)

    const byId = headingIndex(state.doc);
    const depth = headingDepthOf(block, byId);
    const index = $cursor.index(0);

    if (delta === -1 && depth <= 1) return false; // can't outdent a top-level heading → let Tab fall through (a11y)
    // The moved heading's NEW parent (the only parent that changes — a uniform subtree shift leaves every
    // descendant pointing at its existing parent by id). Computed on the PRE-shift doc (preceding headings
    // aren't in the subtree, so their depths are stable).
    const newParent = parentForHeadingDepth(state.doc, index, depth + delta);
    if (delta === 1) {
      // A valid indent needs a preceding heading at exactly `depth` to nest under; otherwise
      // parentForHeadingDepth would clamp and the `#` count would drift from the resolved depth.
      const newParentDepth = newParent ? headingDepthOf(byId.get(newParent)!, byId) : 0;
      if (newParentDepth !== depth) return false; // no valid parent → let Tab fall through (no drift, no a11y trap)
    }

    if (dispatch) {
      const headingPos = $cursor.before();
      const positions = subtreeHeadingPositions(state.doc, headingPos, block.attrs.unitId as string | null, byId);
      const tr = state.tr;
      // Shift the `#` prefix of every heading in the subtree (descending → positions stay valid).
      for (const pos of positions) {
        const at = pos + 1; // the first `#` of this heading's prefix
        if (delta === 1) tr.insertText('#', at);
        else tr.delete(at, at + 1);
      }
      // Set the moved heading's parentId DIRECTLY so the recognizer's single post-pass sees a consistent
      // doc (headingRecognize's appendTransaction runs ONCE, not to a fixpoint — a stale ancestor would
      // otherwise mis-reparent descendants). `headingPos` is unmoved (all `#` edits are at ≥ headingPos+1).
      // INVARIANT (shared with headingRecognize + projection.flushToContent): a heading's parentId must stay
      // DERIVABLE from its live `#` count via `parentForHeadingDepth` (the recognizer recomputes it that way,
      // and reload re-derives it). So depth changes by shifting the `#` PREFIX (above) — never parentId alone;
      // `newParent` here equals what `parentForHeadingDepth` yields for the new `#` count, so they agree.
      tr.setNodeAttribute(headingPos, 'parentId', newParent);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
