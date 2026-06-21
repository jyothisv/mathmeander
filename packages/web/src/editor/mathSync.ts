// Keep each inline-math node's `attrs.expr` in step with its editable source TEXT (the math sibling of
// idStamper/exprStamper, running as an appendTransaction after every change). The node's text content is the
// live editing buffer; `attrs.expr` is the authoritative MathExpression that projection.ts/flush read — so
// this plugin is what lets those stay PURE and unchanged while editing happens in the DOM. Two jobs:
//
//   1. SYNC — when a node's text drifts from `expr.surface_text`, recompute `parse_status` via the WASM
//      `normalizeFresh` (the keystone fresh path, §6.3a — only ever applied to FRESH exprs; anchored exprs
//      are never opened for inline-source editing, so they never reach here) and store the text VERBATIM as
//      `surface_text` + `original_input` (lossless, §2.2 — no canonicalization rewrite that would jump the
//      caret; KaTeX renders identically, and the core trusts the client expr as-is). The sentinel is
//      `surface_text === textContent`, so a freshly-loaded expr (projected text == surface_text) never
//      re-syncs → no spurious upsert on open.
//   2. CLEANUP — drop an inline-math node that is EMPTY and NOT currently open (the caret is elsewhere): an
//      abandoned `$` (clicked away before typing). The open empty node — the in-progress create — is kept.
import { Plugin, TextSelection } from 'prosemirror-state';
import type { MathExpression } from '@mathmeander/schema';
import { normalizeFresh } from './mathRuntime';

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
      const raw = node.textContent;
      if (raw.length === 0 && pos !== openPos) {
        deletes.push({ from: pos, to: pos + node.nodeSize }); // empty + abandoned → drop
        return false;
      }
      const expr = node.attrs.expr as MathExpression | undefined;
      if (expr && expr.surface_text === raw) return false; // already in sync
      const n = normalizeFresh(raw);
      const next: MathExpression = {
        ...(expr as MathExpression),
        surface_text: raw,
        original_input: raw,
        parse_status: n.parseStatus,
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
