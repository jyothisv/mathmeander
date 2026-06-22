// Pure recognizer for inline `$…$` math regions in a single text run — the editable-syntax rule decided in
// docs/authoring-numbering-citations.md ("`$…$` recognition & math-mode entry"). It is pandoc-style with the
// digit guard on the CLOSE (not the open), so digit-leading math (`$3x$`, `$2\pi$`, `$0$`) is recognized while
// currency (`$5 and $10`, `$20,000 and $30,000`, "it costs $5") stays plain text. `\$` is a literal-dollar
// escape. `$$` is RESERVED for display math (Phase C): an empty-inner region (e.g. `$$`) is skipped here, so
// the inline recognizer never claims it. Offsets are JS string indices into `text`; the caller maps them to
// document positions. Regions are non-overlapping, left-to-right, nearest-valid-close-wins, and cover the
// FULL `$…$` including both delimiters.

/** Number of consecutive backslashes immediately before `i` — a `$` is escaped (a literal `$`) when odd. */
function backslashesBefore(text: string, i: number): number {
  let n = 0;
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++;
  return n;
}
const isEscaped = (text: string, i: number): boolean => backslashesBefore(text, i) % 2 === 1;
// A missing neighbour (start/end of run) counts as whitespace: a `$` at the very edge can't open/close math.
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** A `$` at `i` can OPEN inline math: unescaped, with a non-space immediately to its right. (No digit guard
 *  on the open — that is what lets `$3x$` work; the guard lives on the close.) */
function opensAt(text: string, i: number): boolean {
  return text[i] === '$' && !isEscaped(text, i) && !isSpace(text[i + 1]);
}

/** A `$` at `j` can CLOSE inline math: unescaped, a non-space immediately to its left, and NOT immediately
 *  followed by a digit (so `$20,000 and $30,000` and `$x$5` don't form math). */
function closesAt(text: string, j: number): boolean {
  return text[j] === '$' && !isEscaped(text, j) && !isSpace(text[j - 1]) && !isDigit(text[j + 1]);
}

/** Stricter than `opensAt`: also excludes a leading digit. The LIVE "math mode" open rule (openRegionStart) —
 *  so currency (`$5 in my pocket`) never flips into math styling while typing. Digit-leading math (`$3x$`) is
 *  still recognized on close (findMathRegions' digit-on-close), it just isn't live-styled before then. */
function opensLiveAt(text: string, i: number): boolean {
  return opensAt(text, i) && !isDigit(text[i + 1]);
}

/** Find the inline-math regions in `text`. Each region is `[start, end)` over the string, covering the whole
 *  `$…$` (both `$`); the inner source is `text.slice(start + 1, end - 1)`. */
export function findMathRegions(text: string): { start: number; end: number }[] {
  const regions: { start: number; end: number }[] = [];
  let i = 0;
  while (i < text.length) {
    if (!opensAt(text, i)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && !closesAt(text, j)) j++;
    if (j >= text.length) {
      i++; // no valid closer — the opener is a literal `$`; resume just after it
      continue;
    }
    // A non-empty pair is inline math; an empty pair (`$$`) is reserved for display math (Phase C) — skip it.
    if (j - (i + 1) > 0) regions.push({ start: i, end: j + 1 });
    i = j + 1; // resume after the closer
  }
  return regions;
}

/** The start index of an UNCLOSED ("open") math region containing `caretOffset`, or null. This is the LIVE
 *  "math mode" signal while a region is still being typed — its source is colored from this index to the end
 *  of the run. Returns null if the caret is inside a COMPLETE region (that is the recognizer/mark's job). Uses
 *  the conservative open rule (`opensLiveAt`: non-space AND non-digit), so currency (`$5 in my pocket`) never
 *  flips into math styling while typing; digit-leading math (`$3x$`) still becomes math on close. */
export function openRegionStart(text: string, caretOffset: number): number | null {
  for (const r of findMathRegions(text)) {
    if (caretOffset > r.start && caretOffset < r.end) return null; // caret inside a complete `$…$`
  }
  let openStart = -1;
  for (let i = 0; i < caretOffset; i++) {
    if (openStart < 0) {
      if (opensLiveAt(text, i)) openStart = i;
    } else if (closesAt(text, i)) {
      openStart = -1;
    }
  }
  return openStart >= 0 ? openStart : null;
}
