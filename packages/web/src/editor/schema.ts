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
      parseDOM: [{ tag: 'p' }],
    },

    text: { group: 'inline' },

    // Inline math: a ZERO-WIDTH atom (§6.0). Its `expr` (the whole MathExpression) rides as an attr
    // so the round-trip is lossless; it contributes 0 chars to the prose text. Read-only in 2c-1
    // (math INPUT is 2d) — rendered as a code chip.
    inlineMath: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { expr: {} },
      toDOM: (node) => [
        'code',
        { class: 'math', 'data-inline-math': '' },
        (node.attrs.expr as { surface_text?: string }).surface_text ?? '',
      ],
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
