# Structured authoring, numbering & citations — design note

Status: **design note** (future program; not scheduled) · Prereqs: display math (slice 2 math Phase C) +
the structured-authoring / flat→tree foundation. Verdict: **no insurmountable model challenges.** The honest
constraints are one UX tradeoff (§ "the one real limit") and one sizable-but-contained prerequisite
(flat→tree, § risk). Sequencing (decided): **slice 2 / display math comes next regardless; then annotations +
diagrams; citations come AFTER annotations** as a specialization (§ sequencing).

Companion to `mvp_architecture.md` (§6 data model, §6.3a keystone, §9.x InputEnvironment, §9.y authoring,
§9.z math input, §2.5/§3.9 propose-not-impose). This note records the design direction discovered while
scoping "low-effort intra-document citations."

## Goal

A user types `(1)`,`(2)` against equations or `(a)`,`(b)` to start hypotheses, and cites them by just typing
`(1)`/`(a)`. Not every equation is numbered. Adding/removing an item auto-renumbers the definition AND every
citation. Citations work within a unit or across closely-related units (a theorem + its proofs).

## Two invariants that make it tractable

- **Cite the IDENTITY; display the COMPUTED number.** A citation binds to a stable id, never to a number; the
  number is a pure projection of reading order (`crates/core/src/numbering.rs`, recomputed every write,
  nothing stored). Insert/remove then auto-renumbers definitions AND citations _for free_ — no stored numbers,
  no migration, no save-churn. **Auto-increment/decrement is not a feature to build; it is the absence of
  stored numbers.**
- **Presentation is computed.** Number from order; **indentation from depth**. Neither lives in the text —
  the same discipline already shipped for math (render computed; source is the truth, §6.0a).

## Editing paradigm: editable-syntax live-preview

Inline rendered markup — math (`$…$`), marks (`*…*`), citations — is **real editable source text** in the
prose, rendered live when the caret leaves the region and shown raw when it is inside (Obsidian/Typora-style).
It is NOT consumed into atoms or affordance glyphs. Decisive for three reasons: the delimiters are editable
text; it is uniform across math and marks; and **copy/paste just works** — math is text, not an atom (the
prior atom model could not be copied at all, a real daily issue). The canonical `MathContent` stays the truth
(inline math is still a zero-width `Inline::Math` atom, etc.); the editor's source text is bridged by the
**projection seam** (§6.0a — model canonical, editor adapter), so there is no model/schema change. Structural
cues (type / `Case:` / list markers) remain recognized gestures that transform structure. The **syntax is our
own** — Markdown elements borrowed selectively, never a spec to conform to.

## Syntax additions

Per the paradigm above: inline rendered markup is live-preview editable text; structural cues are recognized
gestures. Legend: ✅ shipped · ◻ planned (this program) · ⬚ later · ↻ reworking to the editable-syntax model.

### Modes (math, then diagrams)

- ↻ `$…$` — inline math. The `$` and the source are **literal editable text** (not an atom, not affordance
  glyphs): rendered live (KaTeX) when the caret leaves the `$…$`, shown raw when it is inside. **Copy/paste
  yields `$…$` text.** Expr identity rides an invisible mark so citations survive edits; the projection seam
  parses/serializes `$…$` ↔ the canonical zero-width `Inline::Math` atom (no model change). Reworked from the
  2d atom NodeView (§9.z).
- ◻ `$$ … $$` — display-math block (math Phase C), same editable-syntax model, centered block.
- ⬚ diagrams — a _second_ editing mode (declarative source → rendered diagram, a second WASM runtime); the
  multi-mode generalization of math mode.

### Type cues (line start + trailing `.`/`:` + space) — ✅ shipped (`cues.ts`)

`Thm.` `Lem.` `Prop.` `Cor.` `Def:` `Conj.` `Claim` `Q` `Pf.` `Ex.` `Rmk.` `Idea` `Note` → a typed unit of
that type (the cue text is stripped; the type is applied via the canonical `set_unit_type` op, never the prose
delta). New: ◻ `Case …:` → a `CaseSplit` case child unit.

### Paragraph model — ✅ shipped

Blank line = new plain unit; inside a typed unit a blank line is a paragraph break, and a 2nd consecutive
blank (or `⌘/Ctrl-Enter`) exits it. `Shift-Enter` = soft line break. `Backspace` at a typed-unit start peels
the type; at a plain-unit start soft-break-merges into the previous unit.

### Inline marks — ◻ editable-syntax live-preview (lower to `styled` marks)

`**bold**` → strong · `*italic*` / `_italic_` → em · `` `code` `` → code. Same paradigm as math: the markup is
literal editable text, rendered live when the caret leaves the word and shown raw when inside; copy/paste
yields the markup. The canonical model stores a `styled` mark over the span (the markup chars are stripped at
the seam).

### Blocks (markdown subset) — ◻ need the tree (§ risk)

`- ` / `* ` → bullet item · `1. ` → ordered item · `> ` → quote/embed · `| … | … |` → table (⬚ later, 2-D).
`Tab` / `Shift-Tab` → indent / outdent (changes **depth**, not whitespace).

### Numbering & citation — ◻

- **Number an equation:** numbered-ness is a per-equation property (sequence membership), not surface text.
  The label is an **editable literal tag** in the block's margin/trailing slot — outside `$$…$$` (never in the
  surface; see equation-labels). Two policies, both supporting omission: _selective_ (opt-in — unnumbered by
  default; number the ones you'll cite) or _auto_ (opt-out — all display equations numbered; star one to omit).
- **Omit from numbering:** an omitted equation is a **non-member** of the sequence → no number AND **no
  counter slot consumed**, so the numbered ones stay contiguous (1, 2, 3 …) — exactly like LaTeX `equation*`.
  Because numbers are computed, toggling membership renumbers everything live. (An unnumbered equation is not
  citable _by number_; number it to cite it, and downstream renumbers.)
- **Define a numbered item:** `(1)` / `(a)` / `(i)` at an item/equation start → a numbered anchor. The token
  picks the **style** (digit→arabic, letter→alpha, roman→roman); the canonical number is computed. An explicit
  manual override (e.g. `(3.2)`) uses the numbering engine's existing `name` slot.
- **Free-prose label:** `(1)` / `(a)` mid-prose at a hypothesis point → an inline `Label` anchor (a _point_,
  not a span); propose-confirm.
- **Cite:** `(1)` / `(a)` recognized mid-prose → a citation candidate → propose-confirm → binds to the
  anchor's id → renders the live computed number thereafter.
- **Footnote:** ◻ our own gesture (not `[^1]`) → an inline marker anchor + a footnote unit (reuses the
  anchor+link+number substrate below).

## Resolving the ambiguities

**Equation labels — the `/(a)`÷`a` clash: keep labels OUT of the surface.** No in-math syntax can
disambiguate a label from math (`(a)`, `/(a)`, `/a` are all valid). So an equation's label is **metadata on
the display-math placement** — an editable literal tag in a right-margin slot (like LaTeX `\tag`), authored
_outside_ `$$…$$`. With editable syntax both the math and the tag are editable text; the `$$` delimiters
themselves separate them, so there is no escape syntax and no `÷a` clash. Inline `$…$` is never numbered
(promote to display).

- **Multiple equations in one block** → a `Derivation` (aligned chain) whose lines are **child math rows**;
  each row is its own unit → independently numberable/citable (per-line margin tags; some rows unnumbered).
  Reuses the tree + numbering — **no sub-expression anchoring**. Cross-line alignment is a render concern.

**Hypotheses — two anchor kinds + an extraction layer.**

- _Listed_ ("the following are equivalent: 1) … 2) …") → an ordered list whose **items are child units** (id +
  position → numbered + citable).
- _Free-flowing prose_ ("If S is countable (1) and … (2) then …") → an inline **`Label` anchor**: the literal
  `(1)` text carries an anchor-id mark in the editor (editable-syntax, like math — rendered as the live number
  when the caret leaves), canonically a zero-width anchor inline (sibling of `Reference`/`Math`), marking a
  **POINT** — the editor never has to find clause boundaries.
  That point-anchor is the **floor**. On top of it, the _actual hypothesis span_ can be captured: math prose is
  pattern-rich, and the model already reserves the seat — `extracted_structure` (a declared
  candidate-decomposition layer; example `hypothesis_conclusion_decomposition`) that is **never canonical until
  accepted**. So extraction is propose-not-impose: patterns/AI propose a span → user accepts/edits → it becomes
  a numbered/citable anchor (and a bound citation can then surface the hypothesis, not just the number).
  This is NOT the cut "equation-subexpression anchoring" (anchoring _into math internals_).
- _Binding ladder_ (each rung used only when the one above isn't confident, so it never blocks typing):
  (i) auto-bind when obvious; (ii) confirm a pre-filled candidate (one keystroke — the common case);
  (iii) manual select the span; (iv) point-anchor floor. All §2.5/§3.9 propose-not-impose.
- _Which `(1)`?_ (two lists in one theorem) → resolve within a **scoped sequence** (nearest-enclosing in the
  subtree); genuine ambiguity surfaces the candidates in the chip, never a silent guess.

**Lists vs hypotheses — no differentiation.** Same primitive (an ordered list of child units); citability is
universal; "hypothesis-ness" is just the enclosing context (optionally `slot:"hypothesis"`). The only
difference is numbering _policy_ — not a new node type.

**Footnotes = the citation substrate** (anchor + link + number) with our own marker gesture; cross-refs,
citations and footnotes are one mechanism. Tables are the one heavier model add (a `Table`/grid kind, ⬚).

## What already exists (reuse — confirmed in the core)

- **Numbering** — `numbering.rs` `project_display_labels(units, aliases, handles, policy)` (reading-order
  pre-order walk by `(position,id)`, recomputed every write, pure; `name: Option<String>` is a manual-override
  slot), wrapped by `api.rs::project_numbering`. Equation/expression-keyed numbering is explicitly reserved
  there as "a deliberate later extension."
- **Citations** — `Occurrence{selector,target?}` (in math), `Inline::Reference{span,text,target?}` (prose),
  `Link{ target_object_id, target_unit_id, unresolved_text, target_selector:ExpressionRef, status,
content_locator: ProseSpan|ExpressionSpan|WholeUnit, provenance_id }`. Resolved/**unresolved**/**stale** +
  provenance exist; `rewrite_surface` re-anchors-or-stales edges on edit; `resolve_occurrence` binds. Forward
  refs and "cited target deleted" are already representable.
- **Tree + scope** — `Unit{ parent_unit_id, position, slot, content }`; `UnitContent::{Prose, Math, List,
Derivation, CaseSplit, Group, Embed}`; `extracted_structure`. The numbering walk already reads the tree.
- **Keystone (§6.3a)** — being cited turns an expr anchored; the editor routes fresh exprs through
  `normalize_fresh` and anchored exprs through `rewrite_surface` (a fresh-vs-anchored gate at the editor's
  parse/serialize seam). Carried over from the 2d math layer through the editable-syntax rework.

## Risk: the flat→tree prerequisite — assessment & de-risking

The biggest risk in the program — but contained, and most of the citation value doesn't need it.

- **Decoupled from most of the feature.** Equation numbering (display equations are TOP-LEVEL blocks),
  free-prose `(1)` inline labels (zero-width inline atoms, like `Reference`), and citations all ride on
  _today's_ flat projection + the numbering engine — **no tree needed.** Only list-hypotheses, multi-line
  derivations, case-splits, and indentation need block nesting.
- **The persistence/merge spine is already nesting-tolerant.** `flushToContent` already emits a FLAT,
  id-keyed unit set; merge/draft/autosave diff by unit id; the core model already has `parent_unit_id`. A
  child unit is just a unit with that field; a re-parent is an upsert. So nesting touches **the adapter**
  (projection + PM schema + editor commands + idStamper) — NOT the merge engine, the wire, the draft store, or
  core ops.
- **The flat path stays untouched → no regression.** Plain-prose editing keeps the exact paragraph model;
  nesting engages only on a deliberate gesture. The 90% case is byte-identical to today.
- **Lower-risk _how_: flat editor + `indent` attr ↔ tree via a stack transform.** Keep the editor doc a flat
  sequence of blocks each with an `indent` attr; `Tab`/`Shift-Tab` change the attr (no node surgery — the
  bug-prone part avoided). `flushToContent` runs a stack pass (a block at indent _d_ is a child of the nearest
  preceding block at _d−1_) → `parent_unit_id` + sibling order; `projectToDoc` inverts it. Editing stays flat;
  the only new complexity is one **pure, property-testable transform**.
- **Incremental behind the existing fallback.** `isFlatProse` already drops unsupported shapes to read-only,
  so nesting lands structure-by-structure, each gated; unsupported shapes stay safely read-only. No big-bang
  cutover.
- **Mitigations:** reuse the proven id-stamper de-dup (the fix that killed the flat split-copies-id bug, at
  each level); hammer the round-trip property test (project∘flush = identity; random indent/split/merge/delete
  → reproject stable); reuse `prosemirror-schema-list` where real PM nesting is used.
- **Honest residuals:** the indent↔parent transform's edge cases (indent jumps, empty containers, list
  boundaries); nested-edit gestures; concurrent indent+edit merges (same-unit → existing conflict path;
  disjoint → both kept); tables (2-D) stay separate. All bounded, testable feature work — not an architecture
  threat.

## The one real limit (a UX tradeoff, not a model wall)

**"Zero-effort AND unambiguous" is impossible** — a bare `(a)` is intrinsically ambiguous (math / label / list
marker / citation). The sweet spot is **low-effort + light propose-confirm**: recognize by _position and mode_
(inside math → math; tag slot → label; line/item start → define; mid-prose → cite), then a ghost chip the user
accepts in one keystroke that thereafter renders the live number — never a silent rewrite or wrong guess
(§2.5/§3.9). That confirm step — not a model impossibility — is the price of the ambiguity.

## Sequencing (decided)

**Slice 2 / display math next, regardless.** For the breadth-first "face the product's complexities early"
phase, the chosen probes — **annotations + (maybe) diagrams** — are well-aimed, and **citations come AFTER
annotations:**

- **Citations ≈ a specialization of annotations.** Both are the same family: anchor a stable reference to
  content + provenance + render as an overlay/computed thing, without mutating canonical text. Annotations is
  the general case; a citation is an edge to a numberable target rendered as a number. So annotations
  establishes and de-risks the substrate citations reuse — doing citations first inverts general→specific.
  Annotations is also the substrate AI suggestions + the review queue need → high leverage.
- **Diagrams = a different axis** (a second editing mode + second WASM runtime + non-text render) that
  stress-tests whether the multi-mode foundation generalizes. Complementary; good to face early.
- **Citations is not a third axis** — it composes annotations (anchoring) + numbering (small) + nesting. The
  one axis annotations/diagrams don't exercise is **structured content / nesting** (flat→tree); probe that, if
  facing it early, with a thin structured-authoring slice (lists/indent) — NOT citations.
- **Cheap early sliver:** numbering + citing DISPLAY EQUATIONS needs only display math (coming) + the small
  numbering engine — no annotations, no nesting — so it could ride alongside slice 2 if an early taste of
  cross-refs is wanted.

**Recommended order:** slice 2 (display math) → annotations + diagrams (breadth-first) → [structured-authoring
probe, if facing nesting early] → general citations/footnotes on the annotations substrate. Pauses after
slice 2 as planned.

## Build surface & verification (when the citation program runs)

- **Editor:** flat→tree (the `indent`-attr + stack-transform hybrid in `projection.ts`; lift `isFlatProse`);
  indent/outdent + list/case/quote cues (extend `cues.ts`); a markdown input-cue subset; an inline `Label`
  atom + a footnote atom (siblings of `Reference`); the `(1)`/`(a)` define cue + recognize-and-propose CITE
  chip; live numbering via a WASM-compiled `numbering.rs` (a new wrapper over `project_numbering`, mirroring
  `crates/surface-wasm` — single source of truth).
- **Core (additive, schema-versioned):** `NumberingStyle` (arabic/alpha/roman) + named **sequences** (scope:
  document/object/subtree; reset); number display placements + inline `Label` anchors; the inline `Label`
  kind; a `Table` kind (later). Additive — but bumps the artifact hash → frozen fixtures + migration (§6.3).
- **Verification:** pure `numbering.rs` tests (sequences/styles/scopes; insert/delete renumbers; manual
  override wins); ops tests that citation edges re-anchor/stale across insert/delete/rewrite/re-parent; the
  **indent↔parent + project∘flush round-trip** property test (the highest-value safety net); editor e2e
  (`(1)` defines; `(1)` elsewhere proposes→binds; inserting an earlier item renumbers definition + citation
  live; deleting a cited target shows an unresolved/stale chip, never a wrong number; Tab/Shift-Tab indent
  round-trips; footnote round-trip). Hash changes intentionally → frozen fixtures + migration; full
  `just verify`.
