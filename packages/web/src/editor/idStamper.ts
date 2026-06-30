// The unit-identity stamper (extracted from DayEditor so it is node-testable: deps are only
// prosemirror-state + uuid + the pure mathSyntax recognizer). Every prose block carries a client-minted
// `unitId` (§6.3) so the flush distinguishes new-vs-existing by id and never double-creates; a multi-line
// `$$…$$` SYSTEM block (structured-math 2-B) ALSO carries a stable `rowIds` array (one id per co-equal row).
// The plugin runs as an appendTransaction after every change and enforces, walking the doc in DOCUMENT ORDER:
//   1. a block with a `null` id gets a fresh one (a brand-new block);
//   2. a block whose id was ALREADY SEEN earlier gets re-minted — FIRST occurrence keeps the id, any
//      duplicate is replaced. This kills the duplicate-id-on-split bug at the source: ProseMirror's
//      `splitBlock` copies a block's attrs (incl. `unitId`/`rowIds`) onto the new half, which would otherwise
//      send the same id twice in one save and trip the core's one-home gate (§6.0b) — a deterministic 422.
//   3. `rowIds` is SYNCED to the system's row count (a multi-line `$$…$$`): one id per non-empty line,
//      existing ids preserved POSITIONALLY (so an in-place row edit keeps its id → no save-churn), missing
//      minted fresh, duplicates re-minted (paste safety). A non-system block has `rowIds = []`. Row ids and
//      unit ids share one id space (a row IS a unit), so they dedup against the same `seen` set.
import { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { v7 as uuidv7 } from 'uuid';
import { splitSystemRows, wholeDisplaySource } from './mathSyntax';

/** A block's source with `\n` per hard_break (a system's `$$…$$` is multi-line); null if it has a
 *  non-text/non-hard_break inline (then it's not a clean display block). */
function blockSource(block: PMNode): string | null {
  let text = '';
  let ok = true;
  block.forEach((child) => {
    if (child.isText) text += child.text ?? '';
    else if (child.type.name === 'hard_break') text += '\n';
    else ok = false;
  });
  return ok ? text : null;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export const idStamper = new Plugin({
  appendTransaction(_trs, _oldState, newState) {
    const seen = new Set<string>();
    const seenLinks = new Set<string>(); // reference edge ids — a separate id space from units/rows
    const seenNameIds = new Set<string>(); // §6.3b authored-name handle ids — its own id space
    let tr: ReturnType<typeof newState.tr.setNodeAttribute> | null = null;
    newState.doc.descendants((node, pos) => {
      // Identity-bearing blocks: prose blocks (display equations + systems are prose blocks too) AND config
      // (notation-home) blocks. A config block needs the SAME unitId stamping/dedup so a pasted copy — or a
      // null-id "ensure" — doesn't churn a fresh unit (id + provenance) on every save, or alias the source's
      // id (two nodes → one upsert → the first copy's defs silently lost). A config block has no `rowIds`.
      const isProse = node.type.name === 'prose';
      const isConfig = node.type.name === 'config';
      if (!isProse && !isConfig) return false;

      // (1)+(2) unitId — fresh if null, re-minted if a duplicate of an earlier block.
      let id = node.attrs.unitId as string | null;
      if (id == null || seen.has(id)) {
        id = uuidv7();
        tr = (tr ?? newState.tr).setNodeAttribute(pos, 'unitId', id);
      }
      seen.add(id);

      // (3) rowIds — only a prose `$$…$$` SYSTEM carries co-equal rows; config has no rowIds attr at all.
      if (isProse) {
        const src = blockSource(node);
        const inner = src != null ? wholeDisplaySource(src) : null;
        const rowCount = inner != null ? splitSystemRows(inner).length : 0;
        const cur = (node.attrs.rowIds as string[] | undefined) ?? [];
        const next: string[] = [];
        if (rowCount >= 2) {
          for (let i = 0; i < rowCount; i++) {
            let rid = i < cur.length ? cur[i]! : undefined;
            if (rid == null || seen.has(rid)) rid = uuidv7();
            seen.add(rid);
            next.push(rid);
          }
        }
        if (!sameIds(cur, next)) {
          tr = (tr ?? newState.tr).setNodeAttribute(pos, 'rowIds', next);
        }

        // (4) reference linkIds — each mention atom carries its from_content edge's CLIENT-minted id
        // (§6.1b); the core derives the Link from it and mints none. Fill a null (a pasted / unstamped
        // mention) and re-mint a DUPLICATE (a copied mention must not alias one edge → copy-mints-fresh,
        // mirroring rowIds). A reference child sits at `pos + 1 + off` (block content starts at pos+1).
        node.forEach((child, off) => {
          if (child.type.name !== 'reference') return;
          let lid = child.attrs.linkId as string | null;
          if (lid == null || seenLinks.has(lid)) {
            lid = uuidv7();
            tr = (tr ?? newState.tr).setNodeAttribute(pos + 1 + off, 'linkId', lid);
          }
          seenLinks.add(lid);
        });

        // (5) authored-name handle ids (§6.3b) — each `names[i].id` IS a Handle.id; fill a null and re-mint
        // a DUPLICATE (a copied named block must not alias the source's handle → copy-mints-fresh, like
        // rowIds/links). Its own id space (`seenNameIds`).
        const curNames = (node.attrs.names as { id: string; name: string }[] | undefined) ?? [];
        if (curNames.length > 0) {
          let changed = false;
          const nextNames = curNames.map((n) => {
            let nid = n.id;
            if (nid == null || seenNameIds.has(nid)) {
              nid = uuidv7();
              changed = true;
            }
            seenNameIds.add(nid);
            return nid === n.id ? n : { ...n, id: nid };
          });
          if (changed) tr = (tr ?? newState.tr).setNodeAttribute(pos, 'names', nextNames);
        }
      }
      return false;
    });
    return tr ?? null;
  },
});
