// The MathContent ⇄ ProseMirror adapter (slice 2c-1) — PURE functions, the load-bearing boundary.
// `projectToDoc` renders the canonical content into an editable PM doc; `flushToContent` reads the
// doc back into a DELTA of canonical units. The crux (§6.0): inline `Math`/`Reference` are ZERO-WIDTH
// atoms — 1 ProseMirror position, but 0 chars in the prose `text`; their span is `[p,p]` at their
// char offset. ALL offset math is in CODE POINTS (CharSpan offsets are Unicode scalars, not UTF-16
// units), so non-BMP glyphs anchor correctly. 2c-1 is FLAT PROSE only; see `isFlatProse`.
import { v7 as uuidv7 } from 'uuid';
import { Node } from 'prosemirror-model';
import type { Inline, MathContent, MathExpression, Unit, UnitType } from '@mathmeander/schema';
import { editorSchema } from './schema';

// ── code-point helpers (NOT String.length, which counts UTF-16 units) ──
const cps = (s: string): string[] => Array.from(s);
const cpLen = (s: string): number => cps(s).length;
const cpSlice = (s: string, start: number, end: number): string =>
  cps(s).slice(start, end).join('');

/** 2c-1 handles a day whose content is entirely TOP-LEVEL PROSE (or empty) with only inline kinds the
 *  projection can represent losslessly (mark / math / reference). Anything else — display math,
 *  embeds, groups, nesting, or an unknown inline kind — fails CLOSED to the read-only view, so the
 *  editor never silently drops content it can't round-trip. */
export function isFlatProse(content: MathContent): boolean {
  return content.units.every((u) => {
    if (u.parent_unit_id !== undefined && u.parent_unit_id !== null) return false;
    if (u.content.kind !== 'prose') return false;
    return u.content.inline.every(
      (i) => i.kind === 'mark' || i.kind === 'math' || i.kind === 'reference',
    );
  });
}

/** The `$…$` text node for a canonical inline `Math` (slice 2d editable-syntax): the surface rides as LITERAL
 *  text wrapped in the `mathExpr` mark, so it is editable + copy/pasteable, and the expr identity (id etc.)
 *  rides the mark. Zero-width in the canonical prose `text` (the `$…$` chars are an editor-only
 *  representation, stripped at flush).
 *  TODO(.mathpack import): a surface containing a literal `$`/`\`, empty, or with a trailing space does NOT
 *  round-trip to a self-recognizing `$…$` (mathRecognize would release it on first edit). Add `\$` escaping
 *  here (+ unescape in blockToProse / the recognizer) when import lands; until then anchored exprs are
 *  protected by the recognizer's keystone keep. */
function mathText(expr: MathExpression): Node {
  return editorSchema.text(`$${expr.surface_text ?? ''}$`, [
    editorSchema.marks.mathExpr.create({ expr }),
  ]);
}

/** Canonical inline order so an unchanged unit round-trips byte-identically (sort by span, then kind). */
function canonicalInline(inline: Inline[]): Inline[] {
  const rank = (k: Inline['kind']): number => (k === 'mark' ? 0 : k === 'math' ? 1 : 2);
  return [...inline].sort(
    (a, b) => a.span.start - b.span.start || a.span.end - b.span.end || rank(a.kind) - rank(b.kind),
  );
}

// ── MathContent → PM doc ───────────────────────────────────────────────────────

function inlineToNodes(text: string, inline: Inline[]): Node[] {
  const atoms = inline.filter((i) => i.kind === 'math' || i.kind === 'reference');
  const marks = inline.filter((i) => i.kind === 'mark');
  const len = cpLen(text);
  const breaks = new Set<number>([0, len]);
  for (const a of atoms) breaks.add(a.span.start);
  for (const m of marks) {
    breaks.add(m.span.start);
    breaks.add(m.span.end);
  }
  const pts = [...breaks].filter((p) => p >= 0 && p <= len).sort((a, b) => a - b);
  const marksAt = (pos: number) =>
    marks
      .filter((m) => m.span.start <= pos && pos < m.span.end)
      .map((m) => editorSchema.marks.styled.create({ style: (m as { style: string }).style }));

  const out: Node[] = [];
  for (let i = 0; i < pts.length; i++) {
    const pos = pts[i]!;
    for (const a of atoms.filter((x) => x.span.start === pos)) {
      // Math → literal `$…$` text + the mathExpr mark (editable syntax); Reference → a zero-width atom.
      // Both are zero-width in the canonical prose `text`, so they share a breakpoint here.
      out.push(
        a.kind === 'math'
          ? mathText((a as { expr: MathExpression }).expr)
          : editorSchema.nodes.reference.create({
              text: (a as { text: string }).text,
              target: (a as { target?: unknown }).target ?? null,
            }),
      );
    }
    const next = pts[i + 1];
    if (next != null && next > pos) {
      const slice = cpSlice(text, pos, next);
      const marks = marksAt(pos);
      // A `\n` in prose text is a within-unit line break (2c-2 multi-line typed blocks) → a hard_break
      // node, NOT a rendered character; split the slice around it (marks apply to each text segment).
      const parts = slice.split('\n');
      parts.forEach((part, j) => {
        if (j > 0) out.push(editorSchema.nodes.hard_break.create());
        if (part.length > 0) out.push(editorSchema.text(part, marks));
      });
    }
  }
  return out;
}

/** Project canonical content into an editable PM doc (assumes `isFlatProse`). An empty day yields a
 *  single empty prose block (a cursor home) whose null `unitId` flush skips until the user types. */
export function projectToDoc(content: MathContent): Node {
  const prose = content.units
    .filter((u) => u.content.kind === 'prose')
    .slice()
    .sort((a, b) => a.position - b.position);
  const blocks = prose.map((u) => {
    const c = u.content as { kind: 'prose'; text: string; inline: Inline[] };
    // `unitType` mirrors the unit's §6.0 type for display + as the source for the set_unit_type delta
    // (typeNeeds); it never rides the prose `save_content` delta (flushToContent ignores it).
    return editorSchema.nodes.prose.create(
      { unitId: u.id, unitType: u.type ?? null },
      inlineToNodes(c.text, c.inline),
    );
  });
  if (blocks.length === 0) blocks.push(editorSchema.nodes.prose.create({ unitId: null }));
  return editorSchema.nodes.doc.create(null, blocks);
}

// ── PM doc → MathContent delta ──────────────────────────────────────────────────

/** Read one prose block's inline fragment back into (`text`, canonical `inline`). Atoms are
 *  transparent to marks (a Mark region continues across a zero-width atom). */
function blockToProse(block: Node): { text: string; inline: Inline[] } {
  let text = '';
  let offset = 0; // code-point offset
  const inline: Inline[] = [];
  const open = new Map<string, number>(); // style → start offset
  const closeExcept = (active: Set<string>) => {
    for (const [style, start] of [...open]) {
      if (!active.has(style)) {
        inline.push({ kind: 'mark', span: { start, end: offset }, style });
        open.delete(style);
      }
    }
  };
  block.forEach((node) => {
    if (node.isText) {
      const mathMark = node.marks.find((m) => m.type.name === 'mathExpr');
      if (mathMark) {
        // `$…$` math (editable syntax) → a ZERO-WIDTH canonical `Math` at `offset`: take the expr from the
        // mark; for a FRESH expr rebuild `surface_text` from the displayed text (strip the one leading + one
        // trailing `$` — mathRecognize guarantees a marked span is always a well-formed `$…$`). Transparent to
        // styled marks (no open/close) and offset unchanged — exactly like the prior zero-width atom.
        // KEYSTONE (§6.3a): an ANCHORED expr's `surface_text` is canonical (edited only via the core's
        // `rewrite_surface`), so it is NEVER overwritten from the displayed text here.
        const markExpr = mathMark.attrs.expr as MathExpression;
        const surface =
          (markExpr.occurrences?.length ?? 0) > 0
            ? markExpr.surface_text
            : (node.text ?? '').replace(/^\$/, '').replace(/\$$/, '');
        const expr = { ...markExpr, surface_text: surface };
        inline.push({ kind: 'math', span: { start: offset, end: offset }, expr });
        return;
      }
      const active = new Set(
        node.marks.filter((m) => m.type.name === 'styled').map((m) => m.attrs.style as string),
      );
      closeExcept(active);
      for (const style of active) if (!open.has(style)) open.set(style, offset);
      const t = node.text ?? '';
      text += t;
      offset += cpLen(t);
    } else if (node.type.name === 'hard_break') {
      // a within-unit line break → one `\n` code point in the prose text; transparent to marks (like an
      // atom), so a Mark region continues across it (offset advances by one).
      text += '\n';
      offset += 1;
    } else if (node.type.name === 'reference') {
      inline.push({
        kind: 'reference',
        span: { start: offset, end: offset },
        text: node.attrs.text as string,
        ...(node.attrs.target == null ? {} : { target: node.attrs.target }),
      });
    }
  });
  closeExcept(new Set());
  return { text, inline: canonicalInline(inline) };
}

function newProseUnit(
  id: string,
  objectId: string,
  position: number,
  text: string,
  inline: Inline[],
): Unit {
  return {
    id, // the block's idStamper-minted UUIDv7 (§6.3) — so the block stays ANCHORED to the persisted
    // unit after save (server keeps the client id; only provenance is stamped). Using a fresh id here
    // would orphan the block → every save would delete+recreate the unit and never settle to "saved".
    object_id: objectId,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline },
    provenance_id: uuidv7(), // placeholder; overwritten server-side for new units
  };
}

/** Key-order-independent JSON (recursively sorts object keys). Change-detection compares the
 *  locally-built content (`{kind,text,inline}` literal order) against the SERVER's zod-parsed content,
 *  whose key order differs — a plain `JSON.stringify` would then report every saved unit as "changed"
 *  and the editor would re-upsert it on every idle cycle (never settling). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** Canonical change-detection form: prose inline is sorted into canonical order, then key-order is
 *  normalized so wire-vs-local key ordering can't masquerade as a change. Exported so the merge
 *  (merge.ts) detects "did the same unit change?" with the SAME comparison the flush uses. */
export function contentKeyOf(c: Unit['content']): string {
  return stableStringify(
    c.kind === 'prose' ? { ...c, inline: canonicalInline((c as { inline: Inline[] }).inline) } : c,
  );
}

function proseUnchanged(next: Unit, prev: Unit): boolean {
  return (
    next.position === prev.position && contentKeyOf(next.content) === contentKeyOf(prev.content)
  );
}

/** Read the edited doc back into a DELTA against `prior`: the units that changed/were added
 *  (`upserts`) and the prior unit ids no longer present (`deletes`). Positions are gap-free in doc
 *  order; an empty brand-new block (no text, no atoms) is a cursor placeholder and is dropped. */
// 2c-4 (flush hardening / net-diff): three known non-minimal-flush cases, deferred — all are
// write/version *noise*, never content loss: (a) a zero-width `Mark` over an empty span is dropped;
// (b) adjacent identical marks are not coalesced; (c) a sparse-position re-projection can emit
// spurious upserts for untouched siblings. Fold the net-diff that suppresses these into 2c-4.
export function flushToContent(
  doc: Node,
  prior: MathContent,
): { upserts: Unit[]; deletes: string[] } {
  const priorById = new Map(prior.units.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const upserts: Unit[] = [];
  let position = 0;
  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const { text, inline } = blockToProse(block);
    const unitId = block.attrs.unitId as string | null;
    const prev = unitId ? priorById.get(unitId) : undefined;
    if (prev) {
      seen.add(prev.id);
      const next: Unit = { ...prev, position, content: { kind: 'prose', text, inline } };
      if (!proseUnchanged(next, prev)) upserts.push(next);
      position += 1;
    } else {
      if (cpLen(text) === 0 && inline.length === 0) return; // empty placeholder — not persisted
      upserts.push(newProseUnit(unitId ?? uuidv7(), prior.object_id, position, text, inline));
      position += 1;
    }
  });
  const deletes = prior.units.filter((u) => !seen.has(u.id)).map((u) => u.id);
  return { upserts, deletes };
}

/** A single pending type change (2c-2). `type: null` = clear to plain. */
export type TypeNeed = { unitId: string; type: UnitType | null };

/** The SENDABLE type delta — the type-axis analog of `flushToContent`. For each prose block whose unit
 *  EXISTS on `server` and whose node `unitType` attr differs from the server unit's `type`, emit a
 *  `set_unit_type` need. The operative skip is **server-absence**: a not-yet-persisted unit (no id, or
 *  not on the server) is skipped because `set_unit_type` needs a persisted unit — its type applies on a
 *  later drain once the prose flush has created it. (For "do I still have a pending type INTENT, incl.
 *  unpersisted?", use `typeIntents` against the baseline.) Type NEVER rides the prose `save_content`
 *  delta (§6.0a: the core freezes every semantic facet there); it flows only through `set_unit_type`. */
export function typeNeeds(doc: Node, server: MathContent): TypeNeed[] {
  const serverById = new Map(server.units.map((u) => [u.id, u]));
  const needs: TypeNeed[] = [];
  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const unitId = block.attrs.unitId as string | null;
    if (!unitId) return; // brand-new block, not yet persisted
    const srv = serverById.get(unitId);
    if (!srv) return; // not on the server yet — applies on a later drain
    const want = (block.attrs.unitType as UnitType | null) ?? null;
    const have = srv.type ?? null;
    if (want !== have) needs.push({ unitId, type: want });
  });
  return needs;
}

/** My pending type INTENTS vs `baseline` (what the server had when I last synced) — the type-axis analog
 *  of `mine = flushToContent(doc, baseline)`. Unlike `typeNeeds` it does NOT skip not-in-baseline units:
 *  a brand-new cued block (absent from baseline → `had=null`) IS a pending intent, so it is preserved
 *  across a reproject (the §2c-2 keepTypes overlay) and re-applied after the prose flush creates it. An
 *  untouched unit whose doc type equals baseline emits nothing — so a concurrent FOREIGN retype carried
 *  in merged content is preserved, NOT clobbered. (This is why keepTypes is intents-vs-baseline, not a
 *  snapshot-of-all-type-attrs.) `null` = a pending clear. */
export function typeIntents(doc: Node, baseline: MathContent): TypeNeed[] {
  const baseById = new Map(baseline.units.map((u) => [u.id, u]));
  const out: TypeNeed[] = [];
  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const unitId = block.attrs.unitId as string | null;
    if (!unitId) return; // unstamped placeholder — no identity yet
    const want = (block.attrs.unitType as UnitType | null) ?? null;
    const base = baseById.get(unitId);
    const had = base ? (base.type ?? null) : null; // not in baseline → treat as null (a pending set)
    if (want !== had) out.push({ unitId, type: want });
  });
  return out;
}
