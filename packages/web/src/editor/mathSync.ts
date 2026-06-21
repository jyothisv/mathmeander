// Keep each inline-math node's `attrs.expr` in step with its editable source TEXT (the math sibling of
// idStamper/exprStamper, running as an appendTransaction after every change). The node's text content is the
// live editing buffer; `attrs.expr` is the authoritative MathExpression that projection.ts/flush read — so
// this plugin is what lets those stay PURE and unchanged while editing happens in the DOM. Three jobs:
//
//   1. KEYSTONE GATE (§6.3a) — only FRESH exprs (no anchors) are managed here. An anchored expr's surface
//      edits go through the core's span-preserving `rewrite_surface` op and must NEVER be re-normalized, so
//      this plugin skips them outright. Together with the open-gesture guards (isFreshMath at `$`-create /
//      double-click / Backspace-after / Delete-before), the keystone is now enforced mechanically AT the
//      normalize chokepoint, not only at the gesture edges.
//   2. SYNC — when a fresh node's text drifts from `expr.surface_text`, recompute `parse_status` via the WASM
//      `normalizeFresh` and store the text VERBATIM as `surface_text` + `original_input`. The sentinel is
//      `surface_text === textContent`, so a freshly-loaded expr never re-syncs → no spurious upsert on open.
//      NOTE (2d-deferred): `surface_text` is stored verbatim (== `original_input`); `normalizeFresh`'s
//      `canonicalText` is intentionally discarded for now. Canonicalization — which §6.3a dedup/search/
//      transclude hang off — lands with the ANCHORING slice, where canonical form is load-bearing and there
//      is a clear commit point; doing it in 2d would also introduce load-time churn (server echo vs the raw
//      editing buffer). If the WASM runtime failed to load, the text is still mirrored (lossless) but
//      `parse_status` is left as-is (no crash on every keystroke).
//   3. CLEANUP — drop a fresh inline-math node that is EMPTY and NOT currently open (the caret is elsewhere):
//      an abandoned `$` (clicked away before typing). The open empty node — the in-progress create or a
//      just-emptied source — is kept.
import { Plugin, TextSelection } from 'prosemirror-state';
import type { MathExpression } from '@mathmeander/schema';
import { normalizeFresh, isMathRuntimeReady } from './mathRuntime';

export const mathSync = new Plugin({
  appendTransaction(_trs, _old, newState) {
    const sel = newState.selection;
    const openPos =
      sel instanceof TextSelection && sel.$from.parent.type.name === 'inlineMath'
        ? sel.$from.before()
        : null;

    let tr: ReturnType<typeof newState.tr.setNodeMarkup> | null = null;
    const deletes: { from: number; to: number }[] = [];

    newState.doc.descendants((node, pos) => {
      if (node.type.name !== 'inlineMath') return undefined; // descend into prose to reach inline math
      const expr = node.attrs.expr as MathExpression | undefined;
      if (expr && (expr.occurrences?.length ?? 0) > 0) return false; // anchored → core-managed; never touch
      const raw = node.textContent;
      if (raw.length === 0 && pos !== openPos) {
        deletes.push({ from: pos, to: pos + node.nodeSize }); // empty + abandoned → drop
        return false;
      }
      if (expr && expr.surface_text === raw) return false; // already in sync
      const parseStatus = isMathRuntimeReady()
        ? normalizeFresh(raw).parseStatus
        : (expr?.parse_status ?? 'unresolved');
      const next: MathExpression = {
        ...(expr as MathExpression),
        surface_text: raw, // verbatim (2d-deferred; see header) — canonicalization belongs to anchoring
        original_input: raw,
        parse_status: parseStatus,
        surface_format: 'mathmeander',
        input_syntax: 'mathmeander',
      };
      tr = (tr ?? newState.tr).setNodeMarkup(pos, undefined, { ...node.attrs, expr: next });
      return false; // math nodes are atoms — don't descend into their text
    });

    if (deletes.length === 0) return tr;
    tr = tr ?? newState.tr;
    // setNodeMarkup above is size-preserving, so the original positions are still valid; apply deletes
    // right-to-left so each delete can't shift a later one.
    for (const d of deletes.sort((a, b) => b.from - a.from)) tr.delete(d.from, d.to);
    return tr;
  },
});
