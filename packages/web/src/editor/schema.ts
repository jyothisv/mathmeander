// The ProseMirror schema for the journal editor (slice 2c-1) — a FRONTEND ADAPTER only (§6.0a: PM
// vocabulary never leaks into the core model). Node/mark names are editor terms; the projection
// (projection.ts) maps them to/from the canonical `MathContent`/`Inline`. Slice 2c-1 edits FLAT
// PROSE: a doc is prose blocks; a prose block's inline is text + zero-width atoms (inline math /
// reference) + `styled` marks. (Display math, embeds, groups, and type cues arrive in 2c-2/2c-3; a
// day containing them falls back to the read-only view — see DayEditor.)
import { Schema } from 'prosemirror-model';

export const editorSchema = new Schema({
  nodes: {
    doc: { content: 'prose+' },

    // One canonical prose unit. `unitId` is the identity carrier (null = a brand-new unit the
    // server-side flush mints); other unit fields are reconciled from prior content on flush. `unitType`
    // mirrors the unit's §6.0 `type` (null = plain): it round-trips for display + is the source for the
    // set_unit_type delta (2c-2) — it is NEVER sent via the prose `save_content` delta (§6.0a; the type
    // freeze lives in core ops.rs). A leading-cue inputRule sets it; Backspace-at-start clears it.
    prose: {
      group: 'block',
      content: 'inline*',
      attrs: { unitId: { default: null }, unitType: { default: null } },
      toDOM: (node) => [
        'p',
        {
          'data-unit-id': (node.attrs.unitId as string | null) ?? '',
          ...(node.attrs.unitType ? { 'data-unit-type': node.attrs.unitType as string } : {}),
        },
        0,
      ],
      // Paste keeps a copied block's TYPE (`data-unit-type`) but NOT its id — a pasted block must get a
      // fresh id (idStamper), never alias the source unit. unitId stays at its `null` default.
      parseDOM: [
        {
          tag: 'p',
          getAttrs: (dom) => ({
            unitType: (dom as HTMLElement).getAttribute('data-unit-type') || null,
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

    // Inline math (slice 2d): a ZERO-WIDTH atom in the PROSE-text offset space (§6.0) — it contributes 0
    // chars to the unit's prose `text`, so its `Inline::Math` span stays `[p, p]`. But it carries its
    // surface SOURCE as real editable TEXT CONTENT (`content: "text*"`, the proven prosemirror-math shape):
    // `atom: true` keeps the caret SKIPPING OVER rendered math (it enters the source only on a deliberate
    // open), while the inner text is the live editing buffer that `mathSync` mirrors into `attrs.expr`. The
    // whole MathExpression rides in `attrs.expr` (lossless round-trip; `exprStamper`/projection read it).
    // The NodeView (MathNodeView) renders KaTeX by default and reveals the source text when the caret is in.
    inlineMath: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      content: 'text*',
      attrs: { expr: {} },
      toDOM: () => ['span', { class: 'inline-math' }, 0],
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
                : 'span';
        return [tag, { 'data-style': style }, 0];
      },
    },
  },
});
