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
import { splitSystemRows, wholeDisplaySource } from './mathSyntax';
import { isMathRuntimeReady, normalizeFresh } from './mathRuntime';

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

/** Prose representable as editor inline (mark / math / reference). */
function isRepresentableProse(content: Unit['content']): boolean {
  return (
    content.kind === 'prose' &&
    content.inline.every((i) => i.kind === 'mark' || i.kind === 'math' || i.kind === 'reference')
  );
}

/** The graded editability predicate (structured-math): a day is editable if every unit is either
 *  TOP-LEVEL prose / `math` display / an `equations` system CONTAINER, OR a Math/Prose ROW whose parent is a
 *  top-level `equations` container (ONE level of nesting — 2-B). Anything deeper or any other shape (other
 *  container kinds, a row under a non-equations parent, a nested container) fails CLOSED to the read-only
 *  `MathContentView`, so the editor never silently drops content it can't round-trip. */
export function isEditable(content: MathContent): boolean {
  const byId = new Map(content.units.map((u) => [u.id, u]));
  return content.units.every((u) => {
    const parent = u.parent_unit_id;
    if (parent === undefined || parent === null) {
      // Top level: prose, display math, or a system container.
      if (u.content.kind === 'equations' || u.content.kind === 'math') return true;
      return isRepresentableProse(u.content);
    }
    // Nested: a Math row WITHOUT a row_relation, directly under a TOP-LEVEL `equations` container (one level
    // only). Fail CLOSED for shapes the editor's flush can't round-trip — a Prose row or a `row_relation`
    // (both produced only by `insert_equations`/import, never the editor) would be re-emitted as a plain Math
    // row and 422 on flush — so such a system renders read-only (§6.0a never-admit-an-unround-trippable-shape).
    const p = byId.get(parent);
    if (!p || p.content.kind !== 'equations') return false;
    if (p.parent_unit_id !== undefined && p.parent_unit_id !== null) return false;
    return u.content.kind === 'math' && u.row_relation == null;
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

/** The PM nodes for a canonical display `Math` unit (structured-math increment 1): the `$$surface$$` source
 *  rides as LITERAL text wrapped in the `mathExpr` mark with `display:true`, so a display equation is authored
 *  exactly like inline math — editable source, live-preview render (centered), keystone-stable id. A MULTI-LINE
 *  surface (`\n` in `surface_text`) splits into text + `hard_break` nodes (like `inlineToNodes` does for prose
 *  `\n`); the projection seam maps a whole-block `$$…$$` ⇄ a standalone `Math` unit. */
function mathDisplayNodes(expr: MathExpression): Node[] {
  const mark = editorSchema.marks.mathExpr.create({ expr, display: true });
  const src = `$$${expr.surface_text ?? ''}$$`;
  const out: Node[] = [];
  src.split('\n').forEach((part, i) => {
    if (i > 0) out.push(editorSchema.nodes.hard_break.create(null, null, [mark]));
    if (part.length > 0) out.push(editorSchema.text(part, [mark]));
  });
  return out;
}

/** The PM nodes for a co-equal SYSTEM (2-B): an `Equations` container's rows render as ONE multi-line
 *  `$$…$$` block, one equation per line (joined by `\n` → hard_breaks). The block-level `mathExpr` mark is a
 *  transient DISPLAY marker (so the recognizer/preview treat the block as display + hide the source when
 *  blurred); it is NOT a canonical expression — the rows carry identity (via `rowIds` + the canonical row
 *  units). Its id reuses the container's id (deterministic; the recognizer reconciles it on first edit). */
function systemDisplayNodes(container: Unit, rows: Unit[]): Node[] {
  const inner = rows.map(rowSurface).join('\n');
  const blockExpr: MathExpression = {
    id: container.id,
    surface_text: inner,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: inner,
    parse_status: 'renderable',
    occurrences: [],
  };
  return mathDisplayNodes(blockExpr);
}

/** The block's display source with `\n` per hard_break (display math may be multi-line); null if the block has a
 *  non-text/non-hard_break inline. Mirrors `mathRecognize`'s `blockSource`. */
function displaySource(block: Node): string | null {
  let text = '';
  let ok = true;
  block.forEach((child) => {
    if (child.isText) text += child.text ?? '';
    else if (child.type.name === 'hard_break') text += '\n';
    else ok = false;
  });
  return ok ? text : null;
}

/** If `block` is a whole-block display equation — every text node carries a `display:true` `mathExpr` mark, and
 *  the only other children are hard_breaks (a multi-line `$$…$$`) — return its expression; else null. The seam's
 *  test for "this prose block IS a `Math` unit". */
function pureDisplayExpr(block: Node): MathExpression | null {
  let expr: MathExpression | null = null;
  let ok = true;
  let anyText = false;
  block.forEach((child) => {
    if (child.isText) {
      anyText = true;
      const m = child.marks.find((mk) => mk.type.name === 'mathExpr');
      if (!m || !(m.attrs.display as boolean)) ok = false;
      else if (!expr) expr = m.attrs.expr as MathExpression;
    } else if (child.type.name !== 'hard_break') {
      ok = false; // a reference/atom → not a clean display block
    }
  });
  return ok && anyText ? expr : null;
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

/** Project canonical content into an editable PM doc (assumes `isEditable`). Top-level prose + `math`
 *  units interleave by `position`. A `math` unit becomes a PROSE block holding its `$$surface$$` source as a
 *  `display:true` `mathExpr` span — so it is authored/edited exactly like inline math (live-preview renders it
 *  centered; the seam maps it back to a `Math` unit). An empty day yields a single empty prose block (a cursor
 *  home) whose null `unitId` flush skips. */
export function projectToDoc(content: MathContent): Node {
  const units = content.units
    .filter(
      (u) =>
        (u.parent_unit_id === undefined || u.parent_unit_id === null) &&
        (u.content.kind === 'prose' || u.content.kind === 'math' || u.content.kind === 'equations'),
    )
    .slice()
    .sort((a, b) => a.position - b.position);
  const blocks = units.map((u) => {
    if (u.content.kind === 'equations') {
      // A co-equal SYSTEM (2-B): the container's child rows render as ONE multi-line `$$…$$` block (one
      // equation per line). `rowIds` carries each row's stable id so an edit is a content-only upsert.
      const rows = content.units
        .filter((r) => r.parent_unit_id === u.id)
        .slice()
        .sort((a, b) => a.position - b.position);
      return editorSchema.nodes.prose.create(
        { unitId: u.id, unitType: null, rowIds: rows.map((r) => r.id) },
        systemDisplayNodes(u, rows),
      );
    }
    if (u.content.kind === 'math') {
      // Display math is a prose block whose content is the `$$…$$` display source (NOT a separate atom node):
      // editable text (multi-line → text + hard_breaks), live-preview renders it centered, the seam maps it back.
      return editorSchema.nodes.prose.create(
        { unitId: u.id, unitType: null, rowIds: [] },
        mathDisplayNodes((u.content as { kind: 'math'; expr: MathExpression }).expr),
      );
    }
    const c = u.content as { kind: 'prose'; text: string; inline: Inline[] };
    // `unitType` mirrors the unit's §6.0 type for display + as the source for the set_unit_type delta
    // (typeNeeds); it never rides the prose `save_content` delta (flushToContent ignores it).
    return editorSchema.nodes.prose.create(
      { unitId: u.id, unitType: u.type ?? null, rowIds: [] },
      inlineToNodes(c.text, c.inline),
    );
  });
  // Always leave a PLAIN prose block to home the caret: an empty day, OR a day ENDING in a display equation
  // (whose source is hidden when blurred — so without this there'd be no plain line to click/type below it).
  // The trailing placeholder has a null unitId, so the flush skips it until the user types.
  const last = blocks[blocks.length - 1];
  if (!last || pureDisplayExpr(last)) {
    blocks.push(editorSchema.nodes.prose.create({ unitId: null }));
  }
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

function newMathUnit(
  id: string,
  objectId: string,
  position: number,
  expr: MathExpression,
  parentUnitId?: string,
): Unit {
  return {
    id, // the block's idStamper-minted id (a brand-new equation) — keeps the block anchored after save
    object_id: objectId,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'math', expr },
    provenance_id: uuidv7(), // placeholder; overwritten server-side for new units
    // A system row carries its parent `equations` container; a top-level equation omits it (None).
    ...(parentUnitId ? { parent_unit_id: parentUnitId } : {}),
  };
}

/** A FRESH `MathExpression` for a system row's `surface` (mirrors mathRecognize's `freshExpr`): `parse_status`
 *  from the WASM when ready (else reuse/`renderable`), keeping `reuse`'s id so an in-place row edit follows. */
function freshRowExpr(surface: string, reuse: MathExpression | undefined): MathExpression {
  const parseStatus = isMathRuntimeReady()
    ? normalizeFresh(surface).parseStatus
    : (reuse?.parse_status ?? 'renderable');
  return {
    id: reuse?.id ?? uuidv7(),
    surface_text: surface,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: surface,
    parse_status: parseStatus,
    occurrences: [],
  };
}

/** A row unit's surface source: a `Math` row's expression surface, or a `Prose` row's text. */
function rowSurface(u: Unit): string {
  if (u.content.kind === 'math') return u.content.expr.surface_text ?? '';
  if (u.content.kind === 'prose') return u.content.text;
  return '';
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

  // Emit one block as a unit. When the prior unit's KIND matches → edit/reposition it; otherwise CREATE: a
  // brand-new block keeps its idStamper-stamped id, while a KIND-FLIP (the prior unit was a different kind)
  // mints a FRESH id and leaves the prior unit OUT of `seen` so it falls into `deletes` — i.e. the core does
  // a prose↔math flip as delete+create (it forbids changing an existing unit's kind in place).
  const emit = (block: Node, prev: Unit | undefined, content: Unit['content']) => {
    const unitId = block.attrs.unitId as string | null;
    if (prev && prev.content.kind === content.kind) {
      seen.add(prev.id);
      const next: Unit = { ...prev, position, content };
      if (
        next.position !== prev.position ||
        contentKeyOf(next.content) !== contentKeyOf(prev.content)
      )
        upserts.push(next);
    } else {
      const id = prev ? uuidv7() : (unitId ?? uuidv7());
      upserts.push(
        content.kind === 'math'
          ? newMathUnit(id, prior.object_id, position, (content as { expr: MathExpression }).expr)
          : newProseUnit(
              id,
              prior.object_id,
              position,
              (content as { text: string }).text,
              (content as { inline: Inline[] }).inline,
            ),
      );
    }
    position += 1;
  };

  // Emit a multi-line `$$…$$` SYSTEM block as an `Equations` container + one Math ROW per line (2-B). Each
  // row's id is `rowIds[i]` (idStamper-synced → stable, no save-churn); a row's expr is reused by id
  // (surface-updated if zero-anchor, frozen if anchored) or minted fresh. The whole system occupies ONE doc
  // block → one top-level `position`; rows are positioned 0..n UNDER the container.
  //
  // CONTAINER RESOLUTION (the no-wedge rule): prefer the block's `unitId` when it already names an Equations
  // container; ELSE resolve the container from the EXISTING rows' parent (`rowIds[0]`'s parent) — so after a
  // Math/prose→system kind-flip (which mints a fresh container id while the block keeps its stale `unitId`,
  // and a normal flush never reprojects) the next flush still finds the real container instead of re-minting
  // it and re-parenting the rows. Re-parenting would be a frozen-facet 422 on every flush — a hard autosave
  // WEDGE (rows' `parent_unit_id` can't change via `save_content`), not the benign one-shot churn a leaf flip
  // has. Only a genuinely new system (no prior rows) mints a fresh container id.
  const emitSystem = (block: Node, rowSurfaces: string[]) => {
    const blockUnitId = block.attrs.unitId as string | null;
    const rowIds = (block.attrs.rowIds as string[] | undefined) ?? [];
    const priorAtBlockId = blockUnitId ? priorById.get(blockUnitId) : undefined;

    const asContainer = (u: Unit | undefined): u is Unit => !!u && u.content.kind === 'equations';
    const rowsContainer = rowIds.length > 0 ? priorById.get(rowIds[0]!)?.parent_unit_id : undefined;
    const existing = asContainer(priorAtBlockId)
      ? priorAtBlockId
      : rowsContainer
        ? priorById.get(rowsContainer)
        : undefined;
    const containerExists = asContainer(existing);
    const containerId = containerExists
      ? existing.id
      : blockUnitId && !priorAtBlockId
        ? blockUnitId
        : uuidv7();
    const containerPos = position;

    if (containerExists) {
      seen.add(containerId);
      if (existing.position !== containerPos) upserts.push({ ...existing, position: containerPos });
    } else {
      // Brand-new container, or a kind-flip from a Math/prose unit (the old unit is left out of `seen` → it
      // falls into `deletes`, the delete-and-create the core requires for a kind change).
      upserts.push({
        id: containerId,
        object_id: prior.object_id,
        position: containerPos,
        status: 'rough',
        declared_by: 'user',
        content: { kind: 'equations' },
        provenance_id: uuidv7(),
      });
    }

    rowSurfaces.forEach((surface, i) => {
      const id = i < rowIds.length ? rowIds[i]! : uuidv7();
      const priorRow = priorById.get(id);
      seen.add(id); // stable row id → never falls into deletes
      if (priorRow && priorRow.content.kind === 'math') {
        // EXISTING row: keep EVERY frozen facet (provenance/status/declared_by) by spreading `priorRow` —
        // `save_content` rejects an existing unit whose provenance changed, so it must NOT be re-minted (the
        // single-equation/prose `emit` path keeps it the same way). Only position/parent/content may move.
        const pe = priorRow.content.expr;
        const anchored = (pe.occurrences?.length ?? 0) > 0;
        // Zero-anchor → re-fit surface from the line; anchored (cited) → frozen (edit via rewrite_surface).
        const expr = anchored || pe.surface_text === surface ? pe : freshRowExpr(surface, pe);
        const rowUnit: Unit = {
          ...priorRow,
          position: i,
          parent_unit_id: containerId,
          content: { kind: 'math', expr },
        };
        if (
          priorRow.position !== i ||
          priorRow.parent_unit_id !== containerId ||
          contentKeyOf(priorRow.content) !== contentKeyOf(rowUnit.content)
        )
          upserts.push(rowUnit);
      } else {
        // NEW row (or a prose→math row flip): a fresh unit under the container (fresh provenance, route-stamped).
        upserts.push(
          newMathUnit(id, prior.object_id, i, freshRowExpr(surface, undefined), containerId),
        );
      }
    });
    position += 1;
  };

  doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const unitId = block.attrs.unitId as string | null;
    const prev = unitId ? priorById.get(unitId) : undefined;

    // A whole-block `$$…$$` (display) → a `Math` unit. The surface is rebuilt from the displayed source —
    // text + `\n` per hard_break, then strip the two leading/trailing `$` (so a MULTI-LINE source round-trips
    // with its newlines) — for a FRESH expr; an ANCHORED expr's surface is frozen (keystone §6.3a).
    const dispExpr = pureDisplayExpr(block);
    if (dispExpr) {
      // Inner source via the single source-of-truth recognizer (tolerates trailing whitespace + multi-line).
      const inner = wholeDisplaySource(displaySource(block) ?? '');
      const rows = inner != null ? splitSystemRows(inner) : [];
      if (rows.length >= 2) {
        // ≥2 non-empty lines → a co-equal SYSTEM (an Equations container + Math rows). Blank lines are skipped.
        emitSystem(block, rows);
        return;
      }
      // A single (one-line) display equation — one Math unit. Surface = the raw inner for a FRESH expr; an
      // ANCHORED expr's surface is frozen (keystone §6.3a).
      const surface =
        (dispExpr.occurrences?.length ?? 0) > 0
          ? dispExpr.surface_text
          : (inner ?? dispExpr.surface_text);
      emit(block, prev, { kind: 'math', expr: { ...dispExpr, surface_text: surface } });
      return;
    }

    const { text, inline } = blockToProse(block);
    if (cpLen(text) === 0 && inline.length === 0) {
      // Empty block: a brand-new placeholder is dropped; an emptied EXISTING prose unit stays empty; an
      // emptied unit of another kind (a display equation cleared out) is removed (falls into `deletes`).
      if (prev && prev.content.kind === 'prose') {
        seen.add(prev.id);
        const next: Unit = { ...prev, position, content: { kind: 'prose', text, inline } };
        if (!proseUnchanged(next, prev)) upserts.push(next);
        position += 1;
      }
      return;
    }
    emit(block, prev, { kind: 'prose', text, inline });
  });

  // `save_content` deletes a zero-anchor PROSE / MATH unit, plus (2-B) an `Equations` container + its Math
  // ROWS — so a removed equation/system is dropped here like a removed paragraph. A whole-system delete (or a
  // system→single-equation kind-flip) drops the container + every row not re-emitted into `seen`. A CITED Math
  // unit can't be silently dropped (the core 422s — moot today, no citations); it would need a reviewable op.
  const deletes = prior.units
    .filter(
      (u) =>
        !seen.has(u.id) &&
        (u.content.kind === 'prose' || u.content.kind === 'math' || u.content.kind === 'equations'),
    )
    .map((u) => u.id);
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
