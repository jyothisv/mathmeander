// The ProseMirror schema for the journal editor (slice 2c-1) — a FRONTEND ADAPTER only (§6.0a: PM
// vocabulary never leaks into the core model). Node/mark names are editor terms; the projection
// (projection.ts) maps them to/from the canonical `MathContent`/`Inline`. Slice 2c-1 edits FLAT
// PROSE: a doc is prose blocks; a prose block's inline is text + the zero-width `reference` atom +
// `styled` marks + the `mathExpr` mark (inline math as editable `$…$` source text — slice 2d). (Display
// math, embeds, groups, and type cues arrive in 2c-2/2c-3; a day containing them falls back to the
// read-only view — see DayEditor.)
import { Node, Schema } from 'prosemirror-model';

/** THE contract for the prose-editing affordances — the math/heading/mark recognizers, their live-previews,
 *  the type/heading/paragraph cues, the editing keymaps, and the formatting commands. They operate on, and
 *  ONLY on, prose blocks: plain prose AND §B heading titles (a heading is a prose node with `heading: true`).
 *  EVERY other block kind — the `config` notation home today, diagram/annotation blocks later — is ISOLATED
 *  by this predicate: its source/spec is never mis-recognized as math/markdown, and the markup commands no-op
 *  inside it. A new block kind is isolated by DEFAULT; it must opt IN to a prose affordance deliberately,
 *  never leak in. Routing guards through this ONE predicate (rather than ad-hoc `type.name`/`inlineContent`
 *  checks scattered per plugin) is what stops a weak guard from silently admitting a new text-bearing block —
 *  the `inlineContent` hole that let formatting write into a `config` node was exactly that failure. */
export const isProseBlock = (node: Node): boolean => node.type.name === 'prose';

export const editorSchema = new Schema({
  nodes: {
    // A day is a sequence of prose blocks. Display math (structured-math increment 1) is NOT a separate node:
    // a whole-line `$$…$$` is a prose block whose sole content is a `display:true` `mathExpr` span (see
    // mathRecognize / mathLivePreview), and the projection seam maps such a block ⇄ a canonical `Math` unit.
    doc: { content: '(prose | config)+' },

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
        // §6.3b authored names: this typed block's epithet(s)/definiend(a) as `{ id, name }[]` — `id` IS
        // the `Handle.id` (client-minted, stable across edits, re-minted on paste like `rowIds`); `names[0]`
        // (min-by-id) is the primary, the rest are aliases. CHROME, never body content: rendered in the
        // title widget (typeTitle), flushed via the set_handle axis (nameNeeds), never the prose delta. Off
        // the DOM (like `rowIds`).
        names: { default: [] },
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
            // `names` deliberately omitted → `[]` default (paste mints fresh handle ids; copy-mints-fresh).
            // parentId deliberately omitted → stays at its `null` default (paste lands top-level).
          }),
        },
      ],
    },

    // The notation home (config-family block, §Design-model): a plain-text source region holding the
    // declarative `source` (e.g. `TRIGGER := EXPANSION` lines). A DEDICATED node (NOT prose) so every prose
    // plugin — math/heading/mark recognizers, live-previews, cues, keymaps, idStamper, paste — skips it via
    // its `type.name === 'prose'` guard: the source is never mis-recognized as math/heading/markdown, and
    // editing falls through to baseKeymap (Enter → newline, since `code: true`). The projection maps it ⇄ a
    // canonical `Config` unit; mathLivePreview reads it to build the notation scope. `configFamily` mirrors
    // the canonical `family` (`notation` today). Top-level only for now (section-level config is deferred).
    config: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: {
        unitId: { default: null },
        configFamily: { default: 'notation' },
        parentId: { default: null },
      },
      toDOM: (node) => [
        'div',
        {
          class: 'mm-config',
          'data-unit-id': (node.attrs.unitId as string | null) ?? '',
          'data-config-family': (node.attrs.configFamily as string | null) ?? 'notation',
        },
        ['pre', 0],
      ],
      // Paste keeps the config LOOK (family) but not id/parentId — a pasted notation block gets a fresh id
      // (flush mints it) and lands top-level, never aliasing the source's unit.
      parseDOM: [
        {
          tag: 'div.mm-config',
          preserveWhitespace: 'full',
          getAttrs: (dom) => ({
            configFamily: (dom as HTMLElement).getAttribute('data-config-family') || 'notation',
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
      // `linkId` is the CLIENT-minted identity of the `from_content` Link this mention derives (§6.1b);
      // it rides the atom so the core reconciles the edge by id, never minting one. Internal — not in
      // toDOM (a pasted reference is re-stamped fresh by idStamper → copy-mints-fresh for the edge).
      // `targetHandleId` (§6.3b) = which authored NAME this citation chose; its CURRENT string is
      // displayed (referenceLivePreview), so a rename updates the cite. `null` = cite by number/primary.
      // Internal (like linkId) — not in toDOM; copy-mints-fresh re-derives it.
      attrs: {
        text: { default: '' },
        target: { default: null },
        linkId: { default: null },
        targetHandleId: { default: null },
      },
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
