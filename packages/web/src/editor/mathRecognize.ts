// The inline-math RECOGNIZER (slice 2d editable-syntax) — the heart of the editable-syntax model. Runs as an
// appendTransaction after every doc edit: per prose block it reconciles the `mathExpr` mark so each `$…$`
// equation carries it with a synced MathExpression (stable id + `surface_text` + `parse_status`). It subsumes
// the retired atom machinery: mathInput (no atom — `$` is typed text), mathSync (surface/parse mirroring), and
// exprStamper (id minting + copy-mints-fresh).
//
// NON-DESTRUCTIVE reconciliation (the load-bearing property — lossless over reject):
//   • KEEP every existing marked span whose OWN text still self-recognizes as one full `$…$` region. A trailing
//     digit or adjacent prose can change a WHOLE-block scan (`$x$2` → no region) but must NOT strip an intact
//     equation — so we never rescan across a kept span. This is what prevents silently dropping a canonical
//     `Inline::Math` (id/occurrences) — citation corruption once anchoring exists.
//   • Only the GAPS between kept spans are scanned for NEW math (so `$x$2 and $y$` keeps both, no over-wide
//     swallow). New regions mint fresh exprs (inheriting an overlapping released span's id).
//   • KEYSTONE (§6.3a): an anchored expr (occurrences > 0) is never re-normalized. If its delimiters are
//     deleted so it no longer self-recognizes, the mark is KEPT (rendered broken, surfaced) — never silently
//     released — so the cited expr survives. A fresh span that loses its delimiters is released to plain text.
//   • Copy-mints-fresh: a duplicated expr id (paste of a marked equation) is re-minted on the later occurrence.
//   • IDEMPOTENT: a transaction is emitted only when the desired marks differ from the current ones (an
//     unchanged span is reused VERBATIM — no `normalizeFresh` recompute), so loading the server projection
//     produces no spurious edit and the plugin converges in one extra pass.
import { Plugin } from 'prosemirror-state';
import { v7 as uuidv7 } from 'uuid';
import type { Node as PMNode } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { findMathRegions, wholeDisplaySource } from './mathSyntax';
import { normalizeFresh, isMathRuntimeReady } from './mathRuntime';

const MARK = editorSchema.marks.mathExpr;

/** An existing `mathExpr`-marked span (absolute doc positions) and its literal text. */
interface Marked {
  from: number;
  to: number;
  expr: MathExpression;
  text: string;
  display: boolean;
}
/** A reconciled span to apply. */
interface Desired {
  from: number;
  to: number;
  expr: MathExpression;
}

const isAnchored = (expr: MathExpression | undefined): boolean =>
  (expr?.occurrences?.length ?? 0) > 0;

/** Does `text` (a `$…$` span's full text) self-recognize as exactly one region covering its whole length? */
function selfRecognizes(text: string): boolean {
  const r = findMathRegions(text);
  return r.length === 1 && r[0]!.start === 0 && r[0]!.end === text.length;
}

/** A FRESH expr for `inner`: surface verbatim (`surface_text` == `original_input`, 2d-deferred), `parse_status`
 *  via the WASM when ready, keeping `reuse`'s id (in-place edit → citations follow). Called only when the
 *  source actually changed or is brand-new — never for an unchanged span (avoids parse_status churn).
 *  TODO(.mathpack import): this resets occurrences/provenance to a bare fresh expr — preserve imported
 *  provenance fields when re-syncing an imported expr (fresh exprs have none today). TODO(marks): a `$…$`
 *  overlapping a `styled` mark (bold part of an equation) only arises via paste; the styled∩math seam is
 *  unspecified — define it when inline marks (`*…*`) land. */
function freshExpr(inner: string, reuse: MathExpression | undefined): MathExpression {
  const parseStatus = isMathRuntimeReady()
    ? normalizeFresh(inner).parseStatus
    : (reuse?.parse_status ?? 'renderable');
  return {
    id: reuse?.id ?? uuidv7(),
    surface_text: inner,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: inner,
    parse_status: parseStatus,
    occurrences: [],
  };
}

/** The `mathExpr`-marked spans currently in a block (absolute positions), adjacent same-id text nodes merged
 *  (a math span split by an overlapping `styled` mark is rejoined). */
function blockMarked(block: PMNode, contentStart: number): Marked[] {
  const raw: Marked[] = [];
  let pos = contentStart;
  block.forEach((child) => {
    if (child.isText) {
      const m = child.marks.find((x) => x.type === MARK);
      if (m)
        raw.push({
          from: pos,
          to: pos + child.nodeSize,
          expr: m.attrs.expr as MathExpression,
          text: child.text ?? '',
          display: (m.attrs.display as boolean) ?? false,
        });
    }
    pos += child.nodeSize;
  });
  const merged: Marked[] = [];
  for (const m of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.to === m.from && prev.expr.id === m.expr.id) {
      prev.to = m.to;
      prev.text += m.text;
    } else merged.push({ ...m });
  }
  return merged;
}

/** Contiguous text runs of a block (absolute start + text), broken by non-text inline nodes (`hard_break`,
 *  `reference`) — math never crosses them. */
function blockSegments(block: PMNode, contentStart: number): { start: number; text: string }[] {
  const segs: { start: number; text: string }[] = [];
  let start = -1;
  let text = '';
  let pos = contentStart;
  const flush = () => {
    if (text.length > 0) segs.push({ start, text });
    start = -1;
    text = '';
  };
  block.forEach((child) => {
    if (child.isText) {
      if (start < 0) start = pos;
      text += child.text ?? '';
    } else flush();
    pos += child.nodeSize;
  });
  flush();
  return segs;
}

/** The desired marked spans for one block: keep self-recognizing existing spans (resync fresh, never touch
 *  anchored), then scan the gaps between them for new math. `seen` is the DOC-WIDE set of expression ids
 *  already claimed (copy-mints-fresh): a span whose id is already taken (a paste-clone, even across blocks)
 *  is re-minted, so two units never share a `MathExpression.id` (§6.3a). */
function reconcileBlock(
  block: PMNode,
  contentStart: number,
  current: Marked[],
  seen: Set<string>,
): Desired[] {
  // 1. Decide which current spans to KEEP (occupying their range); the rest are released to the gap pool.
  const kept: { from: number; to: number; expr: MathExpression; inner: string }[] = [];
  for (const span of current) {
    const inner = span.text.slice(1, span.text.length - 1); // strip the `$ … $`
    if (selfRecognizes(span.text)) {
      if (isAnchored(span.expr) || span.expr.surface_text === inner) {
        kept.push({ from: span.from, to: span.to, expr: span.expr, inner }); // anchored/unchanged → verbatim
      } else {
        kept.push({ from: span.from, to: span.to, expr: freshExpr(inner, span.expr), inner }); // drifted fresh
      }
    } else if (isAnchored(span.expr)) {
      kept.push({ from: span.from, to: span.to, expr: span.expr, inner }); // keystone: keep cited expr (surfaced)
    }
    // else: fresh + no longer self-recognizing → released (its text rejoins the gap pool below)
  }

  // 2. Scan the GAPS (segment text not covered by a kept span) for NEW regions.
  const gaps: { from: number; to: number; inner: string }[] = [];
  for (const seg of blockSegments(block, contentStart)) {
    const segEnd = seg.start + seg.text.length;
    const within = kept
      .filter((k) => k.from >= seg.start && k.to <= segEnd)
      .sort((a, b) => a.from - b.from);
    let cursor = seg.start;
    const scanGap = (gapStart: number, gapEnd: number) => {
      const gapText = seg.text.slice(gapStart - seg.start, gapEnd - seg.start);
      for (const r of findMathRegions(gapText)) {
        gaps.push({
          from: gapStart + r.start,
          to: gapStart + r.end,
          inner: gapText.slice(r.start + 1, r.end - 1),
        });
      }
    };
    for (const k of within) {
      if (k.from > cursor) scanGap(cursor, k.from);
      cursor = k.to;
    }
    if (cursor < segEnd) scanGap(cursor, segEnd);
  }

  // 3. Merge kept + gap-new, sorted by position; dedup ids left-to-right (first wins, copy-mints-fresh).
  const items = [
    ...kept.map((k) => ({
      from: k.from,
      to: k.to,
      inner: k.inner,
      expr: k.expr as MathExpression | null,
    })),
    ...gaps.map((g) => ({
      from: g.from,
      to: g.to,
      inner: g.inner,
      expr: null as MathExpression | null,
    })),
  ].sort((a, b) => a.from - b.from);

  const desired: Desired[] = [];
  for (const item of items) {
    let expr: MathExpression;
    if (item.expr && !seen.has(item.expr.id)) {
      expr = item.expr; // kept span — already resynced; id still free (doc-wide)
    } else if (item.expr) {
      expr = freshExpr(item.inner, undefined); // duplicate id (within OR across blocks) → re-mint
    } else {
      const overlap = current.find((c) => c.from < item.to && item.from < c.to);
      const reuse = overlap && !seen.has(overlap.expr.id) ? overlap.expr : undefined;
      expr = freshExpr(item.inner, reuse); // gap-new — mint (inherit a released span's id if any)
    }
    seen.add(expr.id);
    desired.push({ from: item.from, to: item.to, expr });
  }
  return desired;
}

/** Do the desired (inline) marks already match what's on the doc (same spans, same expr id/surface/status)? */
function inSync(desired: Desired[], current: Marked[]): boolean {
  // A stale display mark left in a now-non-display block must always be re-marked (→ removed/inline).
  if (current.some((c) => c.display)) return false;
  if (desired.length !== current.length) return false;
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i]!;
    const c = current[i];
    if (!c || d.from !== c.from || d.to !== c.to) return false;
    if (d.expr.id !== c.expr.id) return false;
    if (d.expr.surface_text !== c.expr.surface_text) return false;
    if (d.expr.parse_status !== c.expr.parse_status) return false;
  }
  return true;
}

/** A block's source with `\n` for each hard_break (display math may be MULTI-LINE — newlines are hard_breaks,
 *  the same representation prose soft-lines use). Returns null if the block has a non-text/non-hard_break inline
 *  (a reference/atom) → not a clean display block. */
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

/** DISPLAY recognition (structured-math increment 1): if this prose block's entire content is `$$…$$` (one
 *  equation, possibly MULTI-LINE — the closing `$$` need only be the block's last two chars), it is a display
 *  equation — one `mathExpr{display:true}` region over the whole block (text + hard_breaks). Returns the desired
 *  span (id reused from an existing mark; keystone keeps an anchored expr verbatim), or null if the block isn't
 *  a clean `$$…$$` (then the inline scanner runs instead). */
function displaySpan(
  block: PMNode,
  contentStart: number,
  current: Marked[],
  seen: Set<string>,
): Desired | null {
  const src = blockSource(block);
  if (src == null) return null;
  const inner = wholeDisplaySource(src);
  if (inner == null) return null;
  const prior = current[0]?.expr;
  const canReuseId = !!prior && !seen.has(prior.id); // a paste-clone's id is already taken → copy-mints-fresh
  let expr: MathExpression;
  if (prior && isAnchored(prior) && canReuseId) {
    expr = prior; // keystone: a cited expr is never re-normalized (surface frozen; edited via rewrite_surface)
  } else if (prior && prior.surface_text === inner && canReuseId) {
    expr = prior; // unchanged → reuse verbatim (no parse_status churn)
  } else {
    expr = freshExpr(inner, canReuseId ? prior : undefined); // fresh/drifted/dup → re-fit (mint if id is taken)
  }
  seen.add(expr.id);
  return { from: contentStart, to: contentStart + block.content.size, expr };
}

/** Is the block already marked as the desired display equation — EVERY text node carrying `display:true` with
 *  the desired expr (id/surface/status)? A multi-line display block is several text runs split by hard_breaks,
 *  so we check each run (not "exactly one span"), which also prevents a re-mark loop. */
function displayInSync(block: PMNode, desired: Desired): boolean {
  let ok = true;
  let any = false;
  block.forEach((child) => {
    if (!child.isText) return;
    any = true;
    const m = child.marks.find((x) => x.type === MARK);
    const e = m?.attrs.expr as MathExpression | undefined;
    if (
      !m ||
      !(m.attrs.display as boolean) ||
      !e ||
      e.id !== desired.expr.id ||
      e.surface_text !== desired.expr.surface_text ||
      e.parse_status !== desired.expr.parse_status
    )
      ok = false;
  });
  return ok && any;
}

export const mathRecognize = new Plugin({
  appendTransaction(transactions, _old, newState) {
    // Pure caret moves change no text, so the marks are already settled — only the live-preview decoration
    // (props.decorations) reacts to them. Re-scan only on a doc edit.
    if (!transactions.some((t) => t.docChanged)) return null;
    let tr: ReturnType<typeof newState.tr.removeMark> | null = null;
    // Doc-wide set of expression ids already claimed this pass — drives copy-mints-fresh ACROSS blocks (a
    // pasted display/inline equation can't keep an id another unit already uses, §6.3a expr-id stability).
    const seen = new Set<string>();
    newState.doc.forEach((block, offset) => {
      if (block.type.name !== 'prose') return;
      const contentStart = offset + 1; // top-level block at `offset`; its content begins one position in
      const current = blockMarked(block, contentStart);

      // §B: a section HEADING is a title, never a standalone display equation — skip the whole-block `$$…$$`
      // display recognition for it (a `$$` in a title stays inline/literal). Inline `$x$` math in a title is
      // still recognized below (the projection + flush carry a heading title's inline math like prose's).
      const isHeading = block.attrs.heading as boolean;

      // DISPLAY first (line-only): a whole-block `$$…$$` is one display span; skip the inline scan for it.
      const disp = isHeading ? null : displaySpan(block, contentStart, current, seen);
      if (disp) {
        if (displayInSync(block, disp)) return;
        tr = tr ?? newState.tr;
        tr.removeMark(contentStart, contentStart + block.content.size, MARK);
        tr.addMark(disp.from, disp.to, MARK.create({ expr: disp.expr, display: true }));
        return;
      }

      const desired = reconcileBlock(block, contentStart, current, seen);
      if (inSync(desired, current)) return;
      tr = tr ?? newState.tr;
      // Mark steps are size-preserving, so positions computed from `newState.doc` stay valid as we apply.
      tr.removeMark(contentStart, contentStart + block.content.size, MARK);
      for (const d of desired)
        tr.addMark(d.from, d.to, MARK.create({ expr: d.expr, display: false }));
    });
    return tr;
  },
});
