# Naming, citation & reference-creation — authoring UX

Status: design decisions (not yet implemented). This is the UX-and-model decision layer.
The model-level invariants it builds on are fixed in
[authoring-numbering-citations.md](authoring-numbering-citations.md) and are not restated
here. See also [structured-math.md](structured-math.md) (F1–F3 substrate),
[declarative-representation.md](declarative-representation.md) (the config/convention
family), and mvp_architecture.md §6 / §6.0a / §6.3a.

## 1. Type cues stay consumable

Decision: keep **consumable** type cues (`Thm.`, `Def:`) — the trigger is consumed and the
type drains via the canonical `set_unit_type` op (never the content delta; §6.0a).
_Rejected:_ non-consumable, heading-style cues (the `#`-like reveal-on-click model),
despite Obsidian/org-mode familiarity.

Rationale: a type is a **discrete, one-shot classification**, not a continuously-edited
parameter like a math surface (`$…$`) or heading depth (`#` count) — and only the latter
earn a persistent, editable delimiter. A non-consumable cue would add three costs the
consumable model avoids: (a) a _standing_ recognizer that misfires on word-cues
(`Note`/`Claim`/`Q`) used as ordinary leading prose; (b) a flush-seam span-shift on
statements that contain inline math; (c) a churn/keystone surface — garbling and
un-garbling the cue text. In-app copy/paste already preserves the type via `data-unit-type`;
the real gaps were _selecting_ a typed unit and _multi-paragraph reconstruction on paste_,
which are fixed directly rather than by changing the cue model.

Related, already decided: **copy = statement-only** (copy-mints-fresh, fresh id + number);
**embed/transclude = shared identity** (keeps the origin's number). A cited unit is a
**keystone**: garbling/editing its cue never tears down inbound links — its id stays stable,
a malformed declaration is surfaced (never destructively de-typed), and only an _unlinked_
typed unit may freely release on garble (mirrors the math `$…$` keystone, §6.3a).

## 2. Naming is three distinct concepts

"Name" conflates three things; keep them separate — they have different machinery and
different requiredness, and the split tracks the assertion-vs-definition role.

1. **Designator (the number)** — e.g. "Theorem 3.2.1". _Computed_, positional, **never
   stored** ("numbering is the absence of stored numbers"), hierarchical from section
   nesting. Auto-corrects on insert/reorder/move and on copy-into-a-new-section, for free.
   Counter-sharing across types (theorem/lemma share vs separate) is a configurable
   numbering policy.
2. **Epithet (an authored title)** — e.g. "Cauchy–Schwarz". _Optional_, _editable_,
   possibly **multiple** (aliases / synonyms), and **inline content** (text + math, like a
   heading title — "the $L^2$-boundedness theorem"). Declared inline via `Thm[name].`
   (mirrors amsthm `\begin{theorem}[name]`); the cue is consumed and the name is _extracted_
   into an editable name slot rendered in the unit's title line (it moves, it does not
   vanish). A citation handle layered over the primary designator.
3. **Definiendum (for definitions)** — the term defined, e.g. "closed set". This _is_ the
   definition's identity, it **feeds the notation / term-resolution system**, it is cited
   **by term, not number**, and it may be recognized from the **emphasized term in the
   body** ("a set is **closed** if…") with `Def[term].` as the explicit override (AI can
   later infer the definiendum where it is unemphasized). Multiple terms allowed (synonyms).
   Definitions need no positional default name.

One mechanism (authored named handles), **role-specific force**: for the assertion role the
name is an _optional epithet over a primary number_; for the definition role the name _is
the identity_ and resolves notation. The existing `DefinitionDetail.term` is the definition
specialization.

The **`X[name].` bracket gesture is uniform across types** — `Thm[Cauchy–Schwarz].`,
`Lem[name].`, `Def[closed set].` — capturing an _epithet_ for the assertion family and the
_definiendum_ for definitions; in both cases the cue is consumed and the bracketed text is
extracted into the editable name slot. The bracket is the _declaration shortcut_; the title
slot is the _durable editable home_. For definitions the bracket is optional, since the
definiendum may also be recognized from the emphasized body term (see point 3 above).

The bracket is **forgiving**: once `[` opens, everything up to the closing `]` is the name —
`.`, commas, parens, spaces, and `$…$` are all allowed (`Def[C([0,1])]:`, `Thm[Cauchy–Schwarz
(1821).]:`), and the recognizer fires only on the closing `]`, never on punctuation _inside_.
**Multiple aliases are NOT parsed from punctuation** in the bracket — comma / slash / parens
collide with mathematical names (`ℤ/nℤ`, `C([0,1])`, `(X, τ)`) and with clarifiers
(`(in a topological space)`), so the bracket carries ONE name. A definition's synonyms come
from **bold phrases** in the statement ("a **Turing machine** (**TM**)" → two aliases),
collected propose-confirm (never silently — §2.5/§3.9); a theorem's extra aliases come from an
explicit add-alias affordance on the name slot.

## 3. Citing — gesture, target, display

**Resolution model** (extends authoring-numbering-citations.md): a citation is a zero-width
`Inline::Reference` atom that **stores a pointer** (target id + _which_ name was chosen,
`alias_id`/`handle_id`, + an optional `supplement` like "(ii)" / "p. 14") and **displays a
projection** of it (kind word + computed number + the chosen name's _current_ string). Store
the **identity of the chosen name, not its characters** — this beats Obsidian (whose stored
alias text rots on rename) and LaTeX (which needs a manual `\label`). There are **zero
manual labels**: typing `Thm.` or `$$` already minted the stable id; `\label`/`\ref` are
generated only at the LaTeX/Typst _export_ boundary.

**Invoke gesture:** one primary trigger **`@`** for the deliberate-search case
(cross-/intra-object citation). Single key, no closing token, clean-abandon on Escape (the
`@query` is a live decoration that collapses into the atom on confirm, mirroring how `Thm.`
drains into `set_unit_type`). `[[` may be a secondary input rule for muscle memory; `@` is
canonical. This is **not** "one trigger for everything" — it is **three surfaces over one
resolution spine**:

- `@` → deliberate-search citation (you don't know the id; you must find it).
- `(1)`/`(a)` recognizer → **local** refs (you type the number you'd write anyway); see §4.
- `$…$`-internal occurrence → symbols / sub-expressions.

**Target specification:** **fuzzy free-form by default** over a rich match surface (computed
number, epithet, definiendum, one-line context preview); typed **kind-filters**
(`thm:`/`def:`/`eq:`) are _progressive narrowing_, **generated from the `UnitType` union**,
offered not required. Honest caveat: in a mature notebook the same term recurs ("open",
"closed", "normal"), so invest in **rich candidate rows** (designator · name/term ·
preview) so disambiguation is visual before the filter is even reached.

**Display default:** **name-first** ("by Cauchy–Schwarz", "by the definition of an open
set"), with the number available but not shown — **configurable** (a document/notebook-scoped
convention in the declarative-config family; per-citation override via the supplement). The
projection returns _both_ number and name; presentation picks.

**Link-after-the-fact:** select existing prose → `@` (the selection seeds the picker query,
so the target is usually one keystroke away) → on commit, **strip the selected characters
from the prose stream and insert the zero-width Reference atom** (the same strip-and-reinsert
seam already proven for `$…$` and marks). The words move _out of_ the prose stream _into_
the atom's field (preserves `span=[p,p]`, single source of truth). Default to **keeping the
user's words** as the displayed name; the _number_ slot stays projection-owned. Implement as
one canonical op + one editor transaction, guarded by a `project∘flush` round-trip proptest.

## 4. Local references (equations, hypotheses)

Same `Reference` mechanism and same resolution spine; they differ only in (a) **scope** —
the nearest-enclosing subtree sequence rather than the document — and (b) **trigger** — the
in-context number-recognizer rather than `@`, because the math already supplies a stable
local name. Local numbers are computed positionally within the scope and **never stored**,
so inserting/reordering rows renumbers the definition _and_ every citation live. This is
strictly better than LaTeX `\label`/`\eqref` for the local case: no key to invent, the
number you type _is_ the binding, and the token picks the style (`(1)`→arabic, `(a)`→alpha).

Risk is asymmetric and bounded: the **define** side is contextually safe (an equation number
in the margin tag-slot, kept out of `$…$`; a hypothesis `(1)` at a list-item start); the
**cite** side mid-prose is ambiguous, so it is **propose-confirm** (a dismissible ghost
chip, never a silent bind). Because `@` is always the unambiguous escape hatch, the
`(1)`/`(a)` cite-recognizer is **droppable sugar** — keep it for hypotheses (safe, and how
maths is written), stay conservative for equations, and removing it loses no capability. A
free-prose hypothesis anchor is a zero-width `Label` point-anchor (the floor); the hypothesis
_span_ can be captured later via `extracted_structure` (propose-not-impose).

## 5. Creating a reference target on the fly

Citing something not yet in the graph is **three intents**, which the model already
distinguishes — so the gesture _defers_ rather than forcing a choice:

- **External known result** (e.g. the Pythagorean theorem, cited but never derived) → the
  reserved **`source` arm** of `ReferenceTarget`. A lightweight bibliography-style entry
  (name + optional metadata) living in a sources registry, **not** the math graph.
- **Forward reference** (you'll author it below) → an **unresolved Reference** (target
  absent + `unresolved_text`). Surfaced for review; resolves when a matching unit is
  authored.
- **Develop now** → a **stub object**. `@`-create is a _user declaration_ (`declared_by =
user`), which is exactly what the architecture says entitles materialization — so it goes
  through the sanctioned declaration→`materialize_object` path and is _not_ blocked by
  `is_directly_creatable` (that gate only stops raw typed POSTs).

Two UX paths (decided):

- **Enter (fast):** mint an **unplaced stub object**, bound to the citation immediately,
  parked in an "Unfiled" view. This gives **convergence** — a later `@`-mention of the same
  name finds and reuses the existing stub (natural dedup), which a deferred unresolved-ref
  phantom cannot. Default type is **untyped** unless a type-tag (`@thm:` / `@def:`) is given.
  Once cited it is keystone-protected (`dissolve_object` is blocked by inbound refs); an
  uncited orphan is trivially cleanable from Unfiled.
- **Modifier keystroke OR text selection:** open a **creation popup** — pick type, choose
  placement (inline here / a notebook section / leave unplaced), optionally start the
  statement, or route it to an **external source** instead. On a selection the popup
  pre-seeds the name (link-after-the-fact for a not-yet-existing target).

Formalization is **progressive enrichment, not a gating ceremony**: identity + name +
`declared_by = user` make a real object; statement, proof, and placement accrete afterward.
Linking is always opt-in — a plain-prose mention need never be a link.

## 6. What is buildable now vs foundation-gated (scoping)

**Free now** (rides slice 2, on shipped primitives — like how `$…$` was added with no model
change): the `@`-picker producing a **same-object** Reference, display from the existing
single-object `project_display_labels`; link-after-the-fact via the proven seam; `Thm[name].`
/ `Def[name].` name capture (epithet for assertions, definiendum for definitions) into an
editable title slot.

**Foundation-gated** (each earns its own hash bump / waits on a prerequisite):

- Cross-object citation → needs a cross-object/section-scoped label projection (today's
  `project_display_labels` is single-object, unit-keyed).
- Local-scoped numbering (`(1)`/`(a)`) → needs subtree-scoped sequences + a `NumberingStyle`,
  on top of the flat→tree prerequisite for derivations/lists.
- Sub-expression refs → need `StructuralPath` (F3).
- Widening `ReferenceTarget` (+`Unit`, +`Expression`, the `source`/`notation` arms) and
  adding `alias_id`/`supplement`/`name_policy` → an FFI-crossing core-type change: artifact-
  hash bump, frozen fixtures, registered migration, lockstep TS, full `just verify`.

**Sequencing:** general citations land **after annotations** (a citation is a specialization
of the annotation anchoring substrate, and an unresolved `@` needs the review queue
annotations provide). The placement / "Unfiled" model is also not yet built.

**Two correctness invariants to make tested before `@`-citation ships:**

1. **Keystone for cited prose units** — citing a theorem must freeze its unit id (today only
   the display-Math occurrence path sets keystone), or a delete-retype silently breaks the
   cite.
2. **Copy id-remap** — a Reference whose target is _inside_ a copied set must re-point to the
   copy's fresh id; one whose target is _outside_ keeps the original; a reference pasted
   where its target is unreachable goes **stale-and-surfaced**, never silently dropped
   (lossless-over-reject).
