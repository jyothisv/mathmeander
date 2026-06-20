// Safe ADDITIVE merge for a 409 (slice 2c autosave) — PURE, so it unit-tests in node. When my flush
// loses a revision race (another tab/device wrote), we rebase my local delta onto the fresh server
// content. The hard invariant: NEVER silently lose content. If my changes and the server's changes since
// our last-synced baseline touch DIFFERENT units, we keep BOTH (additive). If they touch the SAME unit,
// we refuse to guess and return a conflict (the caller keeps the user's work on screen + in the draft).
// True live co-editing (CRDT/OT) is future; this is a conservative one-shot. Flat-prose only (the editor
// surface); anything else fails safe to conflict.
import type { MathContent, Unit } from '@mathmeander/schema';
import { contentKeyOf, isFlatProse } from './projection';

/** The shape of `flushToContent`'s return — the editor's own delta. */
export type Delta = { upserts: Unit[]; deletes: string[] };

export type ConflictReason =
  | 'both-edited-same-unit'
  | 'i-edited-server-deleted'
  | 'i-deleted-server-edited'
  | 'non-flat';

export type MergeResult =
  | { kind: 'merged'; content: MathContent; rebasedDelta: Delta }
  | { kind: 'conflict'; reason: ConflictReason };

export interface MergeInput {
  /** Last-synced server content (the flush baseline, revision N). */
  baseline: MathContent;
  /** Fresh server content (revision M > N) fetched after the 409. */
  server: MathContent;
  /** My local delta vs `baseline` = flushToContent(doc, baseline). */
  mine: Delta;
}

/** What the server changed since our baseline (by unit id). `new` is tracked separately because a
 *  brand-new server unit can never collide with one of my edits (my edits reference baseline ids). */
function serverDiff(baseline: MathContent, server: MathContent) {
  const baseById = new Map(baseline.units.map((u) => [u.id, u]));
  const serverIds = new Set(server.units.map((u) => u.id));
  const changed = new Set<string>();
  for (const u of server.units) {
    const prev = baseById.get(u.id);
    if (
      prev &&
      (u.position !== prev.position || contentKeyOf(u.content) !== contentKeyOf(prev.content))
    )
      changed.add(u.id);
  }
  const deleted = new Set<string>();
  for (const u of baseline.units) if (!serverIds.has(u.id)) deleted.add(u.id);
  return { changed, deleted, serverIds };
}

/** The minimal delta to transform `base` → `target` (the units-array analog of flushToContent: compares
 *  by id + position + canonical content, so renumbered server units shifted by my deletes are upserted). */
function diffUnits(target: Unit[], base: MathContent): Delta {
  const baseById = new Map(base.units.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const upserts: Unit[] = [];
  for (const u of target) {
    seen.add(u.id);
    const prev = baseById.get(u.id);
    if (
      !prev ||
      u.position !== prev.position ||
      contentKeyOf(u.content) !== contentKeyOf(prev.content)
    )
      upserts.push(u);
  }
  const deletes = base.units.filter((u) => !seen.has(u.id)).map((u) => u.id);
  return { upserts, deletes };
}

export function planMerge({ baseline, server, mine }: MergeInput): MergeResult {
  // Fail safe: the flat-prose construction below only reasons about top-level prose.
  if (!isFlatProse(baseline) || !isFlatProse(server))
    return { kind: 'conflict', reason: 'non-flat' };

  const baseIds = new Set(baseline.units.map((u) => u.id));
  const myEdited = mine.upserts.filter((u) => baseIds.has(u.id)); // edits/reorders to existing units
  const myNew = mine.upserts.filter((u) => !baseIds.has(u.id)); // brand-new units (disjoint ids)
  const myEditedIds = new Set(myEdited.map((u) => u.id));
  const myDeleted = new Set(mine.deletes);

  const srv = serverDiff(baseline, server);

  // Overlap → conflict (the ONLY non-additive cases). Deterministic order for stable assertions.
  for (const id of myEditedIds) if (srv.changed.has(id)) return conflict('both-edited-same-unit');
  for (const id of myEditedIds) if (srv.deleted.has(id)) return conflict('i-edited-server-deleted');
  for (const id of myDeleted) if (srv.changed.has(id)) return conflict('i-deleted-server-edited');

  // Disjoint → ADDITIVE merge, built from server.units so every foreign/server-new unit is preserved.
  const myEditedById = new Map(myEdited.map((u) => [u.id, u]));
  const kept: Unit[] = [];
  for (const u of server.units) {
    if (myDeleted.has(u.id)) continue; // my delete of a server-untouched unit (no-overlap proven above)
    const edit = myEditedById.get(u.id);
    kept.push(edit ? { ...u, content: edit.content } : u); // apply my content edit; keep server fields
  }
  // Append my new units after the server's; renumber gap-free in final order. (A pure REORDER of
  // server-untouched units is conservatively dropped — server order wins, no content lost.)
  const merged = [...kept, ...myNew].map((u, i) => ({ ...u, position: i }));
  const content: MathContent = {
    object_id: baseline.object_id,
    revision: server.revision,
    units: merged,
  };
  return { kind: 'merged', content, rebasedDelta: diffUnits(merged, server) };
}

function conflict(reason: ConflictReason): MergeResult {
  return { kind: 'conflict', reason };
}
