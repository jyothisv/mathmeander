# Structured math substrate — display math → multi-row → sub-expression annotations

> Status: **design** (owner-approved direction; built incrementally). Companion to
> `docs/authoring-numbering-citations.md` (authoring/notation) and `docs/mvp_architecture.md` (§6 data model,
> §6.3a MathExpression keystone, §14 reserved capabilities). The editable-syntax inline-math surface is shipped;
> this note covers the block/structured math surface and the sub-expression-anchoring foundation underneath it.

## Why this exists

"Display math" (`$$…$$`) is the entry point to a larger substrate the product needs soon: **co-equal equation
systems, derivation chains, align/cases, and annotations that target small sub-expressions of large equations.**
Building display math narrowly (a flat `$$` block) and bolting the rest on later would force rework. So we
**design the whole substrate now and build it incrementally**, starting with the simplest instance (a single
display equation) on a model that already accommodates the rest.

Three findings shape everything:

1. **Display equations are op-managed, not free-text-autosaved.** `UnitContent::Math{expr}` is "a display/block
   PLACEMENT of one `MathExpression`." It is created/edited by canonical ops — `toggle_expression_placement`
   (promote an inline `$x$` into a `Math` block ↔ demote) and `rewrite_surface` (edit an anchored expr's surface
   while preserving its id — the §6.3a keystone) — **not** by the editor's prose `save_content` delta, which
   rejects new/kind-changed non-prose units. Both ops are fully plumbed core→FFI→server route; only the web
   client methods are missing. (`save_content` may reposition an existing `Math` unit, but not delete it.)
2. **`Derivation` is too loaded for co-equal equations.** `Derivation` means _sequential / derived-from_ (each
   row follows from the prior via a relation). A system `{2x+y=1; x−y=4}` or independent aligned lines are
   **co-equal**, not a chain. Forcing them into `Derivation` (or the neutral `Group`) loses the form — exactly
   the fuzzy-intent mistake that got the `mixed` kind removed.
3. **Sub-expression addressing is reserved but unbuilt.** The surface AST is sub-term-addressable
   (`StructuralPath`), and `TargetSelector::StructuralPath` is reserved (§14) — but render emitters tag nothing,
   there's no char-offset↔path bridge, and occurrences anchor by coarse `CharSpan`. Precise click and
   sub-expression annotations are the _same_ missing capability.

## The substrate: three foundations

### F1 — the tree in the editor (adapter-only, no core change)

The editor is flat-prose-only today; non-prose/nested days fall back to the read-only `MathContentView`. Add
**one level** of container→row nesting via the adapter, not a general tree:

- Keep the ProseMirror doc a flat block sequence; each block carries a parent/depth attr; `flushToContent` runs
  a stack pass → `parent_unit_id` + sibling `position`; `projectToDoc` inverts it. The merge/draft/wire spine is
  already nesting-tolerant (flat id-keyed units), and the core already has `parent_unit_id` — so F1 touches only
  the editor adapter (`projection.ts`, `schema.ts`, editor commands), never the merge engine, wire, or core ops.
- Lift `isFlatProse` into a **graded `isEditable`** that admits, in order: top-level prose (today) → top-level
  `Math` (increment 1) → one level of `{System|Derivation|CaseSplit}` whose children are `Math`/`Prose` rows
  (increment 2). Anything deeper or unhandled still falls to `MathContentView`. This is the doc's "incremental
  behind the existing fallback."
- **A single display equation is a flat top-level `Math` unit with no children → needs no F1.**

### F2 — the math-row model (additive core change; increment 2)

Keep the content kinds **precise** (the project deletes fuzzy kinds rather than overload them):

| Shape                   | Kind               | Notes                                               |
| ----------------------- | ------------------ | --------------------------------------------------- |
| single equation         | `Math { expr }`    | existing; flat top-level placement                  |
| co-equal aligned system | **`System`** (new) | rows are co-equal, jointly asserted, column-aligned |
| derivation chain        | `Derivation`       | existing; rows are derived-from steps               |
| cases                   | `CaseSplit`        | existing; `slot` marks assumption vs body           |

- **`System` names the mathematics, not the presentation** (alignment is a render concern). It is chosen over
  reusing the neutral `Group` (which would re-import the deleted-`mixed` fuzzy-intent problem) and over
  presentation names like `EquationArray`/`AlignedMath` (the core must not be driven by presentation).
- **Per-row connective: a new optional `Unit.row_relation: Option<RowRelation>`** — a small typed enum kept ⊆
  the grammar's `RELATIONS` (enforced by a mechanical sync test). It is **not** `slot` (which names a child's
  _role_, an open vocabulary) and **not** inside `Math` content (the expr's identity is
  presentation-independent and moves by value across inline↔display). **Alignment is not stored** — derived at
  render time (KaTeX `aligned`).
- A **structured-insert op** mints a container + its `Math` rows in one op (since `save_content` cannot create
  non-prose units), mirroring `displayize`.
- **Cost: additive → artifact hash + codegen regenerate, but NO migration / NO `CURRENT_SCHEMA_VERSION` bump.**
  Content aggregates (`Unit`/`UnitContent`) carry no `schema_version` and drop unknown fields; a new enum
  variant + an `Option` field are strictly additive (migration is envelope-only and must never backfill).
  **This holds only while changes stay additive** — a required field or a removed/renamed variant would need a
  content-migration path that does not exist. Keep it additive.

### F3 — sub-expression addressing (increment 3)

The capability behind **precise click AND sub-expression annotations** — built once, reserved for in §6.3a/§14:

- **Render-tagging:** extend the surface emitter (it already walks the AST node-by-node) to wrap each node in
  KaTeX `\htmlData{path}{…}`, so the rendered DOM carries a `data-path` per sub-term. Requires `katex.render`
  `{ trust: true, strict: false }` (safe: we emit the LaTeX and already escape atom text). Gate to display mode
  to keep inline cheap.
- **Char-offset ↔ StructuralPath bridge:** add `serialize_with_paths` (every node's `StructuralPath` + its
  `CharSpan`, reusing the serializer's existing char-span tracking) and expose a WASM `surface_paths(surface)`.
  The editor maps a click offset → deepest enclosing path, and a `data-path` → char span for highlight/caret.
- **Anchoring:** declare the reserved `TargetSelector::StructuralPath { expression_id, term_path }` (the **one
  frozen-conformance flip**: a corpus case currently asserted _invalid_ becomes _valid_ — must land atomically
  with `just codegen`). A `StructuralPath` anchor is **more robust** than a char-span: unchanged under a
  structure-preserving rename, and it **stales** (never points wrong) under a reshaping edit (`path::resolve`
  returns `None`). Extend `rewrite_surface` to carry + remap/stale path anchors — the keystone, exactly.
- **Precise double-click falls out for free** once nodes carry `data-path` + the path↔span bridge exists. (Until
  F3, a rendered equation's double-click lands at the source start; that's a deliberate stopgap, not a hack to
  unwind — F3 supersedes it.)

## Incremental build order

- **Increment 1 — single display math (NO core change).** Editor + the two missing web-client op methods; render
  centered; create via `toggle_expression_placement`, edit via `rewrite_surface`, reposition via `save_content`,
  delete via demote-then-delete; lift `isFlatProse` for top-level `Math`; the ~17 hardcoded `'prose'` guards
  routed through one `isEditableBlock` helper. Forward-compatible with F1/F2/F3 (verified zero-rework): the
  single `Math` unit, the centered renderer, and the op methods are all reused by later increments.
- **Increment 2 — F1 + F2 (tree + rows).** The additive core change (`System`, `RowRelation`,
  `Unit.row_relation`) + structured-insert op + conformance; the editor stack-transform + container/row nodes +
  aligned render; `MathContentView` rendering of derivation/system/case_split.
- **Increment 3 — F3 (sub-expression annotations + precise click).** `TargetSelector::StructuralPath` (+ the
  conformance flip), `serialize_with_paths`/`surface_paths`, `\htmlData` tagging + `renderMath` trust,
  `rewrite_surface` path-anchor remap/stale, double-click→span, the annotation-attach UI/op.

### Increment-1a known limitations + 1b prerequisites (from adversarial review)

The 1a hardening closes every wedge/data-loss path (verified: no critical/major reachable bug). Two MINORs
remain (neither loses data nor wedges autosave), plus one latent hazard 1b MUST handle:

- **MINOR — select-all then immediately type/paste/delete is swallowed** on a math day: the destructive edit
  spans the atom, so `mathBlockGuard` vetoes the whole transaction (the math survives; the keystroke is lost
  until the selection is collapsed). A contiguous selection can't exclude the atom, so the real fix is
  atom-preserving range editing — deferred to the editing-polish phase.
- **MINOR — copy-out fidelity:** addressed (the `math_display` `toDOM` now emits `$$source$$`).
- **1b PREREQUISITE — `mathBlockGuard` must exempt server reprojections** (done: `reproject` tags its tx) so a
  **demote** (which removes the Math unit) isn't vetoed. And **`planMerge`'s `resurrected` must exclude
  non-prose** (or conflict): once client-side math deletion ships, a force/keep-mine resurrect of a
  server-deleted Math unit would emit a `save_content` upsert the core rejects (new unit must be prose) → 422.

## Invariants & risks

- **Keep F2/F3 strictly additive** (new variant · `Option` field · new union arm) — no content migration exists.
- **Respect the `save_content` boundary:** structured inserts / placement changes / `row_relation` go through
  ops; only prose edits + repositions ride `save_content` (else the core 422s).
- **Alignment stays render-time;** `RowRelation ⊆ grammar RELATIONS` (sync test).
- **The F3 conformance flip is the one frozen-expectation change** — land it atomically with codegen, both sides
  agreeing.
- The canonical model stays the source of truth; the editor is an adapter (§6.0a). Display/edit are projections;
  the expr's stable id + the keystone carry citations/annotations across edits.
