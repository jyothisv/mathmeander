// The annotation-identity recognizer (§6.2) — the annoRef twin of idStamper, kept a SEPARATE plugin so it
// unit-tests in node. An `annoRef` mark carries the whole slice-1a annotation (annotationId + targetId +
// kind/gap/label + the structural extent). On COPY-PASTE, ProseMirror duplicates the mark verbatim — two
// ranges would then claim the same annotation object, and the flush would upsert one id twice. This plugin
// walks the doc after every change and RE-MINTS any duplicate occurrence to a fresh annotation + target id
// (copy-mints-fresh, exactly as idStamper does for unit/row/link/name ids) — the FIRST occurrence keeps its
// id. It does NOT touch the primitive or the extent, so a pasted brace keeps its look/binding (a pasted math
// sub-term whose expression was itself copy-minted-fresh simply ORPHANS on the overlay — re-mapping the
// extent's expressionId through the paste is a follow-up; the annotation is never silently duplicated).
//
// ORPHAN detection (a sub-term path that no longer resolves, a phrase edited away) is deliberately NOT here:
// it needs the WASM surface runtime + on-screen geometry, so it lives in the overlay engine (annoLivePreview),
// which flags an unresolvable target visually and lets the server flip it to `stale` on the next re-derive.
import { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { v7 as uuidv7 } from 'uuid';
import { editorSchema } from './schema';

const ANNO = editorSchema.marks.annoRef;

/** One contiguous run of an `annoRef` mark (a whole annotated phrase/expression), with the mark's attrs. */
export interface AnnoOccurrence {
  from: number;
  to: number;
  annotationId: string;
  attrs: Record<string, unknown>;
}

/** Every `annoRef` occurrence in document order, ADJACENT same-annotation runs merged into one — across a
 *  `styled` sub-range split, any marked non-text inline leaf (a HARD_BREAK inside a multi-line `$$…$$` run
 *  carries the mark too; text-only adjacency shredded such a run into "duplicate" occurrences the
 *  copy-mints-fresh dedupe then wrongly re-minted), AND with SEVERAL annoRef marks COEXISTING on one node
 *  (`excludes: ''`): one open run is tracked PER annotationId, so nested/overlapping annotations each yield
 *  exactly one occurrence. Pure — the dedup unit. */
export function annoOccurrences(doc: PMNode): AnnoOccurrence[] {
  const occ: AnnoOccurrence[] = [];
  const openByKey = new Map<string, AnnoOccurrence>(); // annotationId → its currently-open run
  doc.descendants((node, pos) => {
    if (!node.isText && !(node.isInline && node.isLeaf)) return; // blocks: recurse into children
    const marks = node.marks.filter((x) => x.type === ANNO);
    for (const m of marks) {
      const id = m.attrs.annotationId as string;
      // Extension requires EXACT adjacency (open.to === pos): any intervening node occupies that position,
      // so a same-id run resuming after a gap can never false-extend — it becomes a NEW occurrence (exactly
      // the duplicate the dedupe re-mints).
      const open = openByKey.get(id);
      if (open && open.to === pos) open.to = pos + node.nodeSize;
      else {
        const fresh: AnnoOccurrence = {
          from: pos,
          to: pos + node.nodeSize,
          annotationId: id,
          attrs: m.attrs,
        };
        occ.push(fresh);
        openByKey.set(id, fresh);
      }
    }
  });
  return occ;
}

/** The re-mint plan: for each occurrence whose annotationId was ALREADY seen earlier in the doc, a fresh
 *  (annotationId, targetId) to stamp over its range. Pure + deterministic given the fresh-id generator, so the
 *  copy-mints-fresh decision is testable without a running plugin. First occurrence of an id is kept. */
export function dedupePlan(
  occ: AnnoOccurrence[],
  freshId: () => string,
): {
  from: number;
  to: number;
  annotationId: string;
  targetId: string;
  attrs: Record<string, unknown>;
}[] {
  const seen = new Set<string>();
  const plan: {
    from: number;
    to: number;
    annotationId: string;
    targetId: string;
    attrs: Record<string, unknown>;
  }[] = [];
  for (const o of occ) {
    if (!seen.has(o.annotationId)) {
      seen.add(o.annotationId);
      continue;
    }
    const annotationId = freshId();
    plan.push({ from: o.from, to: o.to, annotationId, targetId: freshId(), attrs: o.attrs });
    seen.add(annotationId);
  }
  return plan;
}

export const annoRecognize = new Plugin({
  appendTransaction(_trs, _oldState, newState) {
    const plan = dedupePlan(annoOccurrences(newState.doc), uuidv7);
    if (plan.length === 0) return null;
    let tr = newState.tr;
    for (const p of plan) {
      // Remove the SPECIFIC duplicate mark instance (attrs-equal), never the bare TYPE — with coexistence
      // (`excludes: ''`) a type-level removeMark would strip every OTHER annotation on the range too.
      const dup = ANNO.create(p.attrs);
      const fresh = ANNO.create({ ...p.attrs, annotationId: p.annotationId, targetId: p.targetId });
      tr = tr.removeMark(p.from, p.to, dup).addMark(p.from, p.to, fresh);
    }
    return tr.setMeta('addToHistory', false);
  },
});
