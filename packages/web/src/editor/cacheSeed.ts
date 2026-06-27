// Keep the TanStack Query cache coherent after a save (slice 2c autosave). The editor saves out of
// band; without this the `['journal', date]` cache keeps the pre-edit content and reopen paints stale
// then background-refetches (the "missing on first reopen, present on the second" bug). After a save
// we seed the cache with the core's CANONICAL echo via this pure, immutable updater — no refetch, no
// stale paint. Returns `prev` unchanged (undefined) when nothing is cached, so `setQueryData` no-ops
// rather than fabricating a partial entry.
import type { MathContent, MathpackGraph } from '@mathmeander/schema';
import type { JournalDayEager } from '../api/client';

/** Seed the canonical echo into ANY eager surface entry (a `{ graph }` shape — journal day OR notebook):
 *  replace the matching object's content in `graph.content`, append if absent, preserving every other field.
 *  Generic so one editor serves both surfaces; `seedDayContent` is the journal-typed alias. */
export function seedEagerContent<T extends { graph: MathpackGraph }>(
  prev: T | undefined,
  objectId: string,
  next: MathContent,
): T | undefined {
  if (!prev) return prev;
  const content = prev.graph.content;
  const idx = content.findIndex((c) => c.object_id === objectId);
  const nextContent = idx >= 0 ? content.map((c, i) => (i === idx ? next : c)) : [...content, next];
  return { ...prev, graph: { ...prev.graph, content: nextContent } };
}

export function seedDayContent(
  prev: JournalDayEager | undefined,
  objectId: string,
  next: MathContent,
): JournalDayEager | undefined {
  return seedEagerContent(prev, objectId, next);
}
