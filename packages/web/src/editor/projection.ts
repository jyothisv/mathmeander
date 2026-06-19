// The MathContent ⇄ ProseMirror adapter (slice 2c-1) — PURE functions, the load-bearing boundary.
// `projectToDoc` renders the canonical content into an editable PM doc; `flushToContent` reads the
// doc back into a DELTA of canonical units. The crux (§6.0): inline `Math`/`Reference` are ZERO-WIDTH
// atoms — 1 ProseMirror position, but 0 chars in the prose `text`; their span is `[p,p]` at their
// char offset. ALL offset math is in CODE POINTS (CharSpan offsets are Unicode scalars, not UTF-16
// units), so non-BMP glyphs anchor correctly. 2c-1 is FLAT PROSE only; see `isFlatProse`.
import { v7 as uuidv7 } from 'uuid';
import { Node } from 'prosemirror-model';
import type { Inline, MathContent, Unit } from '@mathmeander/schema';
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
      out.push(
        a.kind === 'math'
          ? editorSchema.nodes.inlineMath.create({ expr: (a as { expr: unknown }).expr })
          : editorSchema.nodes.reference.create({
              text: (a as { text: string }).text,
              target: (a as { target?: unknown }).target ?? null,
            }),
      );
    }
    const next = pts[i + 1];
    if (next != null && next > pos) {
      const slice = cpSlice(text, pos, next);
      if (slice.length > 0) out.push(editorSchema.text(slice, marksAt(pos)));
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
    return editorSchema.nodes.prose.create({ unitId: u.id }, inlineToNodes(c.text, c.inline));
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
      const active = new Set(
        node.marks.filter((m) => m.type.name === 'styled').map((m) => m.attrs.style as string),
      );
      closeExcept(active);
      for (const style of active) if (!open.has(style)) open.set(style, offset);
      const t = node.text ?? '';
      text += t;
      offset += cpLen(t);
    } else if (node.type.name === 'inlineMath') {
      // zero-width; transparent to marks (do not close/open) — offset unchanged
      inline.push({ kind: 'math', span: { start: offset, end: offset }, expr: node.attrs.expr });
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

function newProseUnit(objectId: string, position: number, text: string, inline: Inline[]): Unit {
  return {
    id: uuidv7(), // client-minted UUIDv7 (§6.3); the route stamps the op's provenance on new units
    object_id: objectId,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline },
    provenance_id: uuidv7(), // placeholder; overwritten server-side for new units
  };
}

function proseUnchanged(next: Unit, prev: Unit): boolean {
  return (
    next.position === prev.position &&
    JSON.stringify(next.content) ===
      JSON.stringify({
        ...prev.content,
        inline: canonicalInline((prev.content as { inline: Inline[] }).inline),
      })
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
      upserts.push(newProseUnit(prior.object_id, position, text, inline));
      position += 1;
    }
  });
  const deletes = prior.units.filter((u) => !seen.has(u.id)).map((u) => u.id);
  return { upserts, deletes };
}
