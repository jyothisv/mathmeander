// §B re-sectioning — the structural-axis twin of headingRecognize. A SINGLE pass that derives EVERY block's
// `parentId` from the flat heading `#`-depth sequence, so adding / removing / re-indenting a heading
// re-sections the document: the blocks beneath a heading become its children, until the next heading at the
// same-or-shallower depth. headingRecognize owns the `heading` FLAG (from the `#` count); this owns
// `parentId`. It runs as an appendTransaction AFTER headingRecognize (so flags are settled), sets the
// `parentId` attr ONLY where it differs (idempotent — a no-op once the doc matches its `#` sequence), and the
// structural drain (projection.structuralNeeds → reparent_unit, one move at a time) persists the changes.
//
// This replaces headingRecognize's old per-heading `parentForHeadingDepth` computation, which only set a NEW
// heading's OWN parent and never adopted the following body blocks (the "adding a heading doesn't nest the
// blocks under it" bug).
import { Plugin } from 'prosemirror-state';
import { HEADING_PREFIX_RE } from './headingSyntax';

export const headingResection = new Plugin({
  appendTransaction(transactions, _old, newState) {
    // Pure caret moves change no text → sectioning is settled (decorations handle the rest).
    if (!transactions.some((t) => t.docChanged)) return null;
    let tr: ReturnType<typeof newState.tr.setNodeAttribute> | null = null;
    // The stack of OPEN section headings, deepest last. A heading at depth `d` pops every same-or-deeper
    // heading, then takes the (now shallower) top as its parent; a body block takes the deepest open heading.
    const stack: { id: string | null; depth: number }[] = [];
    newState.doc.forEach((block, offset) => {
      if (block.type.name !== 'prose') {
        // The config (notation home) is a non-prose block. A TOP-LEVEL one ends the open sections for the
        // blocks that FOLLOW it (a top-level block can't sit inside a section in the canonical tree) — pop the
        // whole stack so a trailing placeholder / following content stays top-level rather than inheriting the
        // prior heading. KNOWN EDGE (minor, self-healing): a following `##` heading also flattens to top-level
        // here (keeps its `##` → renders one level shallower after reload); the alternative (leave the stack)
        // keeps that nesting but reorders a following PLAIN block before the config on reproject — a worse
        // surprise. A config mid-section is unusual (the move steps over whole sections), so we accept the
        // flatten. A nested config (future) is left alone — its following blocks stay inside that section.
        if (((block.attrs.parentId as string | null) ?? null) === null) stack.length = 0;
        return;
      }
      const isHeading = (block.attrs.heading as boolean) ?? false;
      let wantParent: string | null;
      if (isHeading) {
        const m = HEADING_PREFIX_RE.exec(block.textContent);
        const depth = m ? m[1]!.length : 1; // a flagged heading has a `#` prefix; fall back to top level
        while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
        wantParent = stack.length > 0 ? stack[stack.length - 1]!.id : null;
        stack.push({ id: (block.attrs.unitId as string | null) ?? null, depth });
      } else {
        wantParent = stack.length > 0 ? stack[stack.length - 1]!.id : null;
      }
      const curParent = (block.attrs.parentId as string | null) ?? null;
      if (curParent !== wantParent) {
        tr = (tr ?? newState.tr).setNodeAttribute(offset, 'parentId', wantParent);
      }
    });
    return tr;
  },
});
