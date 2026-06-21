// The MathExpression-identity stamper (the math sibling of idStamper). Every math node (inline or display)
// must carry a unique `expr.id`: a brand-new node needs one minted, and a DUPLICATE — e.g. an internal
// copy/paste of a math node, which would otherwise alias the source expression's id — must be re-minted, so
// "copy mints fresh" holds (§6.3a) and two nodes never claim one expression identity. First occurrence in
// document order keeps the id; later duplicates are re-minted.
import { Plugin } from 'prosemirror-state';
import { v7 as uuidv7 } from 'uuid';
import type { MathExpression } from '@mathmeander/schema';
import { emptyExpr } from './mathExpr';

const isMath = (name: string): boolean => name === 'inlineMath' || name === 'displayMath';

export const exprStamper = new Plugin({
  appendTransaction(_trs, _oldState, newState) {
    const seen = new Set<string>();
    let tr: ReturnType<typeof newState.tr.setNodeMarkup> | null = null;
    newState.doc.descendants((node, pos) => {
      if (!isMath(node.type.name)) return; // descend into prose to reach inline math
      const expr = node.attrs.expr as MathExpression | undefined;
      const id = expr?.id;
      if (!id || seen.has(id)) {
        const fresh: MathExpression = { ...(expr ?? emptyExpr()), id: uuidv7() };
        tr = (tr ?? newState.tr).setNodeMarkup(pos, undefined, { ...node.attrs, expr: fresh });
      } else {
        seen.add(id);
      }
      return false; // math nodes are atoms — no relevant descendants
    });
    return tr ?? null;
  },
});
