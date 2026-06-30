// §6.3b authored names — a typed block's epithet(s) / definiend(a), held as the block's `names` attr
// (chrome, never body content). Each `{ id, name }`: `id` IS the `Handle.id` (client-minted, stable across
// edits); `name` is a SOURCE string that may carry `$…$` math (rendered at display, edited as source). The
// primary (min-by-id) is the epithet/definiendum shown by default; the rest are aliases.

export interface Name {
  id: string;
  name: string;
}

/** Names in canonical order — by id (UUIDv7 → creation order), so `[0]` is the stable PRIMARY. */
export function sortedNames(names: Name[]): Name[] {
  return [...names].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The primary authored name (min-by-id) of a typed block, or `null` if it has none. */
export function primaryName(names: Name[]): string | null {
  let best: Name | null = null;
  for (const n of names) if (n.name.length > 0 && (best === null || n.id < best.id)) best = n;
  return best ? best.name : null;
}
