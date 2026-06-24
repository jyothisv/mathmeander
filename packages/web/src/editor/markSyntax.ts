// Pure recognizer for inline FORMATTING regions in a single text run — the markdown-style marks the owner
// asked for: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``. The KEYBOARD-FRIENDLY decision (owner): the
// delimiters are NOT consumed (no input-rule deletion) — they stay as editable source text, exactly like the
// `$…$` math delimiters, so there is never hidden text to navigate and the marks round-trip through the
// existing projection (a `styled` mark over the INNER text; the `**` stay plain text). markRecognize applies
// the mark; math WINS on overlap (regions inside a `$…$` span are dropped by the plugin, not here).
//
// Rules (mirroring mathSyntax's discipline): regions are non-overlapping, left-to-right, longest-delimiter-
// first (`**` before `*`); a `\`-escaped delimiter is literal; a delimiter adjacent to whitespace on the inner
// side can't open/close (so `a ** b` and `2 * 3` stay plain); the inner must be non-empty. Offsets are JS
// string indices into `text`; the caller maps them to document positions.

/** A recognized formatting region. `[start,end)` covers the whole `delim…delim`; `[innerStart,innerEnd)` is the
 *  styled inner text (what the `styled` mark covers — the delimiters stay unmarked plain text). */
export interface MarkRegion {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  style: string;
}

/** The markdown delimiter for each inline style — the SINGLE source shared with markLivePreview (hide/reveal)
 *  and the toggle shortcuts, so the scanner, the preview, and the keymap can never disagree on what wraps what. */
export const MARK_DELIM: Record<string, string> = {
  strong: '**',
  strike: '~~',
  em: '*',
  code: '`',
};

/** Openers tried LONGEST FIRST (stable sort) so `**`/`~~` win over a single `*` at the same spot. `code` is
 *  literal: no nested marks are recognized inside a `` `…` `` span (the scanner resumes after it). */
const DELIMS: { d: string; style: string }[] = Object.entries(MARK_DELIM)
  .map(([style, d]) => ({ style, d }))
  .sort((a, b) => b.d.length - a.d.length);

/** Number of consecutive backslashes immediately before `i` — a delimiter is escaped (literal) when odd. */
function backslashesBefore(text: string, i: number): number {
  let n = 0;
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++;
  return n;
}
const isEscaped = (text: string, i: number): boolean => backslashesBefore(text, i) % 2 === 1;
// A missing neighbour (start/end of run) counts as whitespace: a delimiter at the very edge of the inner side
// can't open/close (markdown intraword rules in spirit — keeps `2 * 3` and a trailing `*` from forming marks).
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

// A lone `*` (em) must not sit next to another `*`: that would be a `**` (strong, handled separately) or a
// malformed run like `** x **` that should stay literal. `**`/`~~`/`` ` `` have no such single/double ambiguity.
const loneStarOk = (text: string, k: number, d: string): boolean =>
  d !== '*' || (text[k - 1] !== '*' && text[k + 1] !== '*');

/** Does the delimiter `d` OPEN at `i`? Present, not escaped, non-space immediately inside, and (for `*`) lone. */
function opensAt(text: string, i: number, d: string): boolean {
  return (
    text.startsWith(d, i) &&
    !isEscaped(text, i) &&
    !isSpace(text[i + d.length]) &&
    loneStarOk(text, i, d)
  );
}

/** Does the delimiter `d` CLOSE at `j`? Present, not escaped, non-space immediately before, and (for `*`) lone. */
function closesAt(text: string, j: number, d: string): boolean {
  return (
    text.startsWith(d, j) && !isEscaped(text, j) && !isSpace(text[j - 1]) && loneStarOk(text, j, d)
  );
}

/** Find the formatting regions in `text`. Non-overlapping, left-to-right, nearest-valid-close-wins. */
export function findMarkRegions(text: string): MarkRegion[] {
  const regions: MarkRegion[] = [];
  let i = 0;
  while (i < text.length) {
    // Longest-first opener at `i` (so a `**` is never read as two `*`).
    const opener = DELIMS.find((o) => opensAt(text, i, o.d));
    if (!opener) {
      i++;
      continue;
    }
    const { d, style } = opener;
    const innerStart = i + d.length;
    // The closer can't sit at `innerStart` (that would be an empty pair like `****` / `` `` ``) — start the
    // search one past it, so an empty just-inserted delimiter pair is left literal until something is typed.
    let j = innerStart + 1;
    while (j < text.length && !closesAt(text, j, d)) j++;
    if (j >= text.length) {
      i += d.length; // no valid closer — the opener is literal; resume just past it
      continue;
    }
    // Non-empty inner (innerStart < j). Record and resume after the closer.
    regions.push({ start: i, end: j + d.length, innerStart, innerEnd: j, style });
    i = j + d.length;
  }
  return regions;
}
