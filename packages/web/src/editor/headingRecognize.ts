// §B heading recognition (Obsidian-style, slice 2c-3) — the structural-axis twin of `mathRecognize`. The
// `#`/`##` markers are KEPT as ordinary editable text (never consumed); this appendTransaction reads the
// LIVE `#` prefix of each block and reconciles the canonical-bearing node attrs the structural drain syncs:
//   • a plain block whose text gains a leading `#`×n + space → PROMOTE (set `heading: true` + the depth-n
//     `parentId`) — replacing the old consuming cue;
//   • a heading whose `#` count changed → re-derive `parentId` (so editing the hashes changes depth);
//   • a heading whose `#` prefix was deleted → DEMOTE (`heading: false`) → `drainStructure` dissolves it.
// The hashes themselves stay in the text (hidden/dimmed by `headingLivePreview`, stripped at the flush seam
// by `projection.flushToContent`). Recognition is a frontend adapter; the KIND change is the canonical
// `toggle_heading`/`reparent_unit` ops the controller drains from these attrs (§6.0a).
import { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { parentForHeadingDepth } from './cues';
import { HEADING_PREFIX_RE } from './headingSyntax';

/** A heading is a SINGLE-LINE title. A block with a within-block soft-line (`hard_break`) is multi-line. */
const isMultiLine = (block: PMNode): boolean => {
  let multi = false;
  block.forEach((c) => {
    if (c.type.name === 'hard_break') multi = true;
  });
  return multi;
};

export const headingRecognize = new Plugin({
  appendTransaction(transactions, _old, newState) {
    // Pure caret moves change no text → the attrs are settled; only the live-preview decoration reacts.
    if (!transactions.some((t) => t.docChanged)) return null;
    let tr: ReturnType<typeof newState.tr.setNodeAttribute> | null = null;
    newState.doc.forEach((block, offset, index) => {
      if (block.type.name !== 'prose') return;
      const m = HEADING_PREFIX_RE.exec(block.textContent);
      const depth = m ? m[1]!.length : 0;
      const isHeading = (block.attrs.heading as boolean) ?? false;
      const curParent = (block.attrs.parentId as string | null) ?? null;

      if (depth > 0 && !block.attrs.unitType) {
        // Don't AUTO-PROMOTE a MULTI-LINE block: a heading is a single-line title, and promoting a
        // multi-line block would absorb all its soft-lines into the title and fold the `#` into the hidden
        // prefix (the "the `#` is silently consumed" bug, reachable when a `# ` prefix arrives via paste or
        // by typing `#` before an existing space — paths that don't fire the line-splitting headingCueRule).
        // The `# ` line stays LITERAL prose (the `#` is visible); the cue rule is the only promote path that
        // creates a heading from a multi-line block, and it splits the first line off first.
        if (!isHeading && isMultiLine(block)) return;
        // A `#`-prefixed block is a section heading at depth `n`; its parent is the nearest shallower
        // heading's appropriate ancestor (clamped). A typed unit (`unitType`) is left alone — its leading
        // `#` is literal, not a heading cue.
        const wantParent = parentForHeadingDepth(newState.doc, index, depth);
        if (!isHeading) {
          tr = (tr ?? newState.tr).setNodeAttribute(offset, 'heading', true);
          if (curParent !== wantParent) tr.setNodeAttribute(offset, 'parentId', wantParent);
        } else if (curParent !== wantParent) {
          tr = (tr ?? newState.tr).setNodeAttribute(offset, 'parentId', wantParent);
        }
      } else if (isHeading) {
        // The `#` prefix is gone → this is no longer a heading. Demote (drainStructure runs toggle_heading,
        // which lifts the body; the controller's residual-reproject brings the doc into agreement).
        tr = (tr ?? newState.tr).setNodeAttribute(offset, 'heading', false);
      }
    });
    return tr;
  },
});
