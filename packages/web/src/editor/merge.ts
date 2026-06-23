// Safe ADDITIVE merge for a 409 (slice 2c autosave) — PURE, so it unit-tests in node. When my flush
// loses a revision race (another tab/device wrote), we rebase my local delta onto the fresh server
// content. The hard invariant: NEVER silently lose content. If my changes and the server's changes since
// our last-synced baseline touch DIFFERENT units, we keep BOTH (additive). If they touch the SAME unit,
// we refuse to guess and return a conflict (the caller keeps the user's work on screen + in the draft).
// True live co-editing (CRDT/OT) is future; this is a conservative one-shot. Gated in lockstep with the
// editor (`isEditable`: top-level prose + display math); anything else (nesting, …) fails safe to conflict.
import type { MathContent, Unit } from '@mathmeander/schema';
import { contentKeyOf, isEditable } from './projection';

/** The shape of `flushToContent`'s return — the editor's own delta. */
export type Delta = { upserts: Unit[]; deletes: string[] };

export type ConflictReason =
  | 'both-edited-same-unit'
  | 'i-edited-server-deleted'
  | 'i-deleted-server-edited'
  | 'new-id-collision'
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
  /** "Keep mine" resolution: skip the overlap→conflict checks so MY version wins on a clash, while the
   *  other side's SEPARATE additions (server-new units + server edits to units I didn't touch) survive. */
  force?: boolean;
}

/** What the server changed since our baseline (by unit id). Server-new ids aren't returned for overlap:
 *  my NEW units carry freshly client-minted UUIDv7s (§6.3), so they're disjoint from every server id —
 *  hence appending mine can't collide (the one place this is verified, not assumed, is the
 *  `myNew ∩ serverIds` guard in `planMerge`). */
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

export function planMerge({ baseline, server, mine, force }: MergeInput): MergeResult {
  // Gate in LOCKSTEP with the editor (`isEditable`): the additive construction below is purely unit-id-keyed
  // (diff by id, apply my content edits to server units, drop my deletes, keep foreign units), so it handles
  // TOP-LEVEL display-math units exactly like prose — disjoint edits on a display-math day still auto-merge.
  // Anything the editor won't open (nested structure, etc.) also fails safe to a manual conflict here.
  if (!isEditable(baseline) || !isEditable(server)) return { kind: 'conflict', reason: 'non-flat' };

  const baseIds = new Set(baseline.units.map((u) => u.id));
  const myEdited = mine.upserts.filter((u) => baseIds.has(u.id)); // edits/reorders to existing units
  const myNew = mine.upserts.filter((u) => !baseIds.has(u.id)); // brand-new units (disjoint ids)
  const myEditedIds = new Set(myEdited.map((u) => u.id));
  const myDeleted = new Set(mine.deletes);

  const srv = serverDiff(baseline, server);

  // Verify the one invariant the construction relies on (unreachable with UUIDv7): a "new" unit of mine
  // must not already exist on the server, or it'd appear twice. Conflict even under `force` — it's a
  // structural impossibility, not a content clash to resolve.
  for (const u of myNew) if (srv.serverIds.has(u.id)) return conflict('new-id-collision');

  // Overlap → conflict (the ONLY non-additive cases) — UNLESS `force` (keep-mine) resolves in my favor.
  // Deterministic order for stable assertions.
  if (!force) {
    for (const id of myEditedIds) if (srv.changed.has(id)) return conflict('both-edited-same-unit');
    for (const id of myEditedIds)
      if (srv.deleted.has(id)) return conflict('i-edited-server-deleted');
    for (const id of myDeleted) if (srv.changed.has(id)) return conflict('i-deleted-server-edited');
  }

  // ADDITIVE merge, built from server.units so every foreign/server-new unit is preserved. My edits
  // apply to units present on the server; my deletes drop them. (Under `force`/keep-mine these "win" over
  // a server change to the same unit; under detect, such overlaps already returned a conflict above.)
  const myEditedById = new Map(myEdited.map((u) => [u.id, u]));
  const kept: Unit[] = [];
  for (const u of server.units) {
    if (myDeleted.has(u.id)) continue; // my delete drops it
    const edit = myEditedById.get(u.id);
    kept.push(edit ? { ...u, content: edit.content } : u); // apply my content edit; keep server fields
  }
  // Under `force`, an edit of mine to a unit the SERVER deleted is resurrected (keep-mine → my version
  // survives); in detect mode that overlap already conflicted, so this is empty there. A resurrected unit is
  // re-emitted as a brand-new upsert (its id is no longer on the server) — `save_content` now accepts a new
  // zero-anchor PROSE *or* `Math` unit (the structured-math relaxation), so a resurrected display equation no
  // longer 422s. (A CITED Math unit can't be re-created this way — but the core keystone rejects that cleanly,
  // it never silently corrupts; and citations don't exist yet.)
  const resurrected = myEdited.filter((u) => !srv.serverIds.has(u.id));
  // Append my new units (+ any resurrected) after the server's; renumber gap-free. (A pure REORDER of
  // server-untouched units is conservatively dropped — server order wins, no content lost.)
  const merged = [...kept, ...myNew, ...resurrected].map((u, i) => ({ ...u, position: i }));
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
