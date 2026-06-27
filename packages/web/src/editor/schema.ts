// The ProseMirror schema for the journal editor (slice 2c-1) — a FRONTEND ADAPTER only (§6.0a: PM
// vocabulary never leaks into the core model). Node/mark names are editor terms; the projection
// (projection.ts) maps them to/from the canonical `MathContent`/`Inline`. Slice 2c-1 edits FLAT
// PROSE: a doc is prose blocks; a prose block's inline is text + the zero-width `reference` atom +
// `styled` marks + the `mathExpr` mark (inline math as editable `$…$` source text — slice 2d). (Display
// math, embeds, groups, and type cues arrive in 2c-2/2c-3; a day containing them falls back to the
// read-only view — see DayEditor.)
import { Schema } from 'prosemirror-model';

export const editorSchema = new Schema({
  nodes: {
    // A day is a sequence of prose blocks. Display math (structured-math increment 1) is NOT a separate node:
    // a whole-line `$$…$$` is a prose block whose sole content is a `display:true` `mathExpr` span (see
    // mathRecognize / mathLivePreview), and the projection seam maps such a block ⇄ a canonical `Math` unit.
    doc: { content: 'prose+' },

    // One canonical prose unit. `unitId` is the identity carrier (null = a brand-new unit the
    // server-side flush mints); other unit fields are reconciled from prior content on flush. `unitType`
    // mirrors the unit's §6.0 `type` (null = plain): it round-trips for display + is the source for the
    // set_unit_type delta (2c-2) — it is NEVER sent via the prose `save_content` delta (§6.0a; the type
    // freeze lives in core ops.rs). A leading-cue inputRule sets it; Backspace-at-start clears it.
    prose: {
      group: 'block',
      content: 'inline*',
      // `rowIds` (structured-math 2-B): for a multi-line `$$…$$` SYSTEM block, the stable id of each
      // co-equal row unit, positionally aligned to the non-empty lines — so editing a row is a content-only
      // upsert, never a re-mint (the save-churn fix). `[]` for any non-system block. idStamper keeps it
      // synced to the row count + deduped (paste safety), exactly as it does for `unitId`.
      // §B sections, FLAT representation. A section is the §6.0 `UnitContent::Heading` kind; the doc stays
      // FLAT (a heading is a normal block, NOT a wrapper node), so every flat consumer (flush/idStamper/
      // merge) is unchanged for the no-section base case. Two attrs carry the structure:
      //   • `parentId` — the canonical `parent_unit_id` (the enclosing section heading's id); `null` =
      //     top-level. Drives the flush's per-parent positions + render-time depth/folding (decorations,
      //     never schema nesting — §B "no level field").
      //   • `heading` — true when this block is a section heading (its content projects to/from a `Heading`
      //     unit; rendered as a title). The kind itself is canonical; becoming/un-becoming a heading is the
      //     `toggle_heading` op (a kind change, never `save_content`), so the FLUSH only emits `heading`
      //     content when the prior unit is already a heading — a pending promotion settles via drainStructure.
      attrs: {
        unitId: { default: null },
        unitType: { default: null },
        rowIds: { default: [] },
        parentId: { default: null },
        heading: { default: false },
      },
      toDOM: (node) => [
        'p',
        {
          'data-unit-id': (node.attrs.unitId as string | null) ?? '',
          ...(node.attrs.unitType ? { 'data-unit-type': node.attrs.unitType as string } : {}),
          ...(node.attrs.parentId ? { 'data-parent-id': node.attrs.parentId as string } : {}),
          ...(node.attrs.heading ? { 'data-heading': 'true', class: 'mm-heading' } : {}),
        },
        0,
      ],
      // Paste keeps a copied block's TYPE + `heading` look (a pasted heading still READS as a heading) but
      // NOT its id OR `parentId` — a pasted block gets a fresh id (idStamper) and lands TOP-LEVEL, never
      // aliasing/escaping into the source's section (copy-mints-fresh). A pasted heading is created as prose
      // by the flush, then promoted by drainStructure once it has a persisted unit (new headings can't ride
      // `save_content`).
      parseDOM: [
        {
          tag: 'p',
          getAttrs: (dom) => ({
            unitType: (dom as HTMLElement).getAttribute('data-unit-type') || null,
            heading: (dom as HTMLElement).getAttribute('data-heading') === 'true',
            // parentId deliberately omitted → stays at its `null` default (paste lands top-level).
          }),
        },
      ],
    },

    text: { group: 'inline' },

    // A within-unit line break (2c-2): `Enter` inside a typed block, or `Shift-Enter` anywhere, inserts
    // one of these; the projection maps it to/from a single `\n` in the unit's prose `text` (so a typed
    // block is ONE multi-line unit, never split into two).
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },

    // Inline reference: a ZERO-WIDTH atom; its display `text` + optional `target` ride as attrs.
    reference: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { text: { default: '' }, target: { default: null } },
      toDOM: (node) => ['span', { class: 'reference' }, (node.attrs.text as string) ?? ''],
    },
  },

  // A single generic mark carrying the canonical `Inline::Mark.style` string verbatim, so any style
  // round-trips losslessly. Common styles render as their semantic tag; the rest as a styled span.
  marks: {
    styled: {
      attrs: { style: {} },
      toDOM: (mark) => {
        const style = mark.attrs.style as string;
        const tag =
          style === 'strong'
            ? 'strong'
            : style === 'code'
              ? 'code'
              : style === 'em' || style === 'emph'
                ? 'em'
                : style === 'strike' || style === 'strikethrough'
                  ? 's'
                  : 'span';
        return [tag, { 'data-style': style }, 0];
      },
    },

    // Math as EDITABLE SYNTAX (slice 2d / structured-math increment 1): the `$…$` (inline) or `$$…$$`
    // (display) source is LITERAL TEXT in the prose, carrying its MathExpression identity via this mark —
    // so copy/paste yields the source text and a cited expr keeps its id across in-place edits (§6.3a). A
    // live-preview decoration (mathLivePreview) renders the marked span; `display:true` marks a whole-line
    // `$$…$$` that renders as a CENTERED block (and projects to a standalone `Math` unit), vs the inline
    // `$…$` zero-width atom. `surface_text` is authoritative from the inner text (between the delimiters);
    // the mark carries the rest of the expr. `inclusive: false` so typing past the closing delimiter doesn't
    // extend the mark; the recognizer (mathRecognize) re-fits it anyway.
    mathExpr: {
      attrs: { expr: {}, display: { default: false } },
      inclusive: false,
      toDOM: (mark) => [
        'span',
        { class: mark.attrs.display ? 'math-src math-src-display' : 'math-src' },
        0,
      ],
    },
  },
});
