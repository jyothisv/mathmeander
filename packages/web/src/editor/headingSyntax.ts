// §B heading SOURCE-prefix syntax — the ONE definition of "a heading title's leading `#`×depth + space"
// shared by every consumer so "is this a heading line?" (paste segmentation) can never desync from
// "strip the prefix" (the flush) or "hide/dim the prefix" (live preview) / "promote from the `#` count"
// (the recognizer). projection.ts renders WITH `headingPrefix(depth)` and strips WITH `HEADING_PREFIX_RE`;
// they MUST stay exact inverses (project shift +N ⇄ flush unshift −N), which is why both live here.

/** A heading title's leading prefix at `depth` (top-level = 1): `#`×depth + a single space. */
export const headingPrefix = (depth: number): string => '#'.repeat(Math.max(1, depth)) + ' ';

/** Matches that prefix at the very start of a block's text; `m[1]` is the `#` run (its length = depth).
 *  The separator is `\s` (not a literal space) so a tab/newline after the `#`s is still recognized AND
 *  stripped identically everywhere — segmentation, flush, preview, and the recognizer never disagree. */
export const HEADING_PREFIX_RE = /^(#+)\s/;
