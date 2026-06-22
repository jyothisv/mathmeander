# Design direction — a declarative representation family (config · notation · conventions · annotations · illustrations)

> **Status:** design-direction note (living draft), drafted 2026-06 from an extended design
> discussion. **Companion to — not a replacement for — the authoritative `docs/mvp_architecture.md`.**
> Most of this is forward-looking and not yet implemented; it is not itself authoritative. The
> **notation/convention machinery** section is the near-term, buildable part (slice 2c-2+); the rest
> (illustrations, the construction/layout engines) is §14 / later-slice territory.

## Context

The trigger: as MathMeander grows it will accumulate per-surface configuration (notation, snippets,
shortcuts), plus annotations and diagrams/illustrations. The opening question was whether to back all
of this with a **scripting language** (so users can view/edit "the real thing" and AI can produce it).
The conclusion was **no scripting language as the substrate**, but yes to the instinct behind it — a
single, transparent, declarative representation. This doc records that and the model that grew out of it.

Goal: one coherent way to represent config, notation, conventions, annotations, and (eventually)
illustrations — declarative, inspectable, AI-producible, exportable in `.mathpack`, and consistent with
the pure-core / model-driven architecture (no library's format becomes the truth, §2.2).

## Core principles (the decisions)

1. **Notation, not scripting.** Representations *denote* values (declarative terms), they don't
   *perform* effects. Heuristic: *does this text denote a value, or do something?* Stay on the denote
   side. The stored truth is a structured model; any text form is a faithful, round-tripping
   **projection** of it — exactly as the `mathmeander` surface language already is for math.

2. **One declarative family, shared substrate — not one grammar.** Everything shares: typed schemas,
   the **scope cascade**, **provenance**, **versioning**, and a **text projection that round-trips**.
   Each domain keeps its own small schema. **Config is the simplest tier**, and it *embeds* the richer
   languages where a value is itself content (a snippet expansion is math content; a notation's display
   is a small arrangement). Tiers are layered so the simple tier ships first and independently.

3. **Content × arrangement + overlays.** "Subsystems" (prose/math/diagram) are not peers; they are
   **(content) × (arrangement)**. Content = what a thing *is* (and where computation/generation lives);
   arrangement = how it's laid out. **Annotations are overlays** — anchored + secondary, with their own
   placement. "Diagram"/"math"/"prose" are *registers*, not primitives.

4. **Three arrangement paradigms + three interfaces.** Arrangements: **box/typographic**,
   **coordinate/Cartesian**, **constraint/relational**. Content exposes **structural interfaces** —
   *relational*, *metric*, *syntactic* — which the three paradigms consume generically (you write "lay
   out relational structure" once, not "draw a set"). A content object may expose several interfaces →
   it affords several arrangements. Boundary test: *if I changed this, would the math change, or only
   how it looks?* (math → content; looks → arrangement/style). Default the residue toward arrangement
   to keep content lean (pending confirmation).

5. **Scope cascade + tri-state; gesture → stored binding.** Scope levels: `global → space/notebook →
   document → region → environment`. Resolution is most-specific-wins over **structural containment**,
   never ordinal stream position. **Tri-state**: a level can add / override / *remove*; *unset ≠
   cleared*; never backfill. Intuitive positional gestures ("from now on…") compile to explicit,
   structural, stored bindings — never hidden stream markers.

6. **Conventions are lexical config the content reads.** A convention changes *interpretation*
   (ℕ-includes-0). It travels with content from its authoring site (lexical capture on embed); when it
   lands somewhere with a conflicting convention, the clash is **surfaced for review, never silently
   reinterpreted** (meaning stays canonical). Positional conventions = a structural **region** in the
   cascade.

7. **Annotations are anchored + secondary, with a placement axis.** Essence = (anchored to a target) +
   (about it, not part of it). Placement is a separate axis — **overlay** (no layout cost) / **gutter**
   / **embrace-a-span** (reserves layout space, e.g. a brace). "Occupies space" and "annotation-vs-
   content" are orthogonal; the latter is a provenance call.

8. **Illustrations/diagrams: separate, conceptual, controllable.** Diagrams are **separate first-class
   content**, usually illustrating a **special case**, loosely linked to symbolic content
   ("illustrates"/"example-of") or with no symbolic counterpart at all. Control = a **ladder of intent**
   (content/emphasis → declarative layout intent → direct-manipulation nudges → export for the last
   mile). Drags compile to **constraints** (preferred) or **anchored offsets** in a **non-destructive
   override layer** (annotation-like: anchored, secondary, orphan→review). **Penrose is inspiration, not
   an import** — coherence across diagram kinds comes from a **shared frame** (one content model, one
   visual language, one interaction/override model, one export/provenance discipline), with
   paradigm-specific layout engines underneath.

## How the language looks (illustrative shape — NOT final syntax)

Aesthetic: harmonize with the `mathmeander` surface (call-/operator-style, ASCII identifiers), so the
config language reads as a member of the same family — and so math fragments inside config stay
**first-class**, not stringified/escaped. Block form for config; an in-flow `use {…}` directive for
activation. **All tokens below are placeholders to convey shape.**

Notation entry (meaning + display + canonicalization):
```
notation Nat {
  triggers  "NN", "\N", "Nat"      // input shortcuts that resolve here
  display   ℕ                       // a math-surface fragment (config embeds content, first-class)
  latex     \mathbb{N}              // canonicalization / export
  means     def:natural-numbers     // optional link to a definition object
  kind      symbol
}
```

Snippet (pure input shortcut — the degenerate tier):
```
snippet ";ra"  →
snippet ";NN"  Nat                  // expands to the Nat notation (semantic), not a bare string
```

Convention (changes interpretation; lexical; clash-keyed by `about`):
```
convention nat-has-zero {
  about  Nat                        // what it governs → the clash-detection key (§6.3c applies_to)
  says   "ℕ includes 0"             // human-readable; structured form optional/reserved
}
```

Define vs use — **a block defines; `use {…}` activates** (availability ≠ activation):
- **Define** with a block, placeable anywhere: out-of-band in a config surface (global/notebook
  settings), or in-flow where its position sets the region. Defining makes a convention/notation
  *available*; a library or notebook may define several **mutually-exclusive** ones (ℕ-with-0 vs
  ℕ-without-0) — both available, neither forced.
- **Use/activate** with an in-flow `use {…}` directive — switch available conventions on at a point, and
  optionally define-and-use local notation inline (`:=`). It reads as a **local preamble**, mirroring
  how a math section opens ("Throughout, assume R commutative; let ε > 0"). Extent follows **structural
  containment**: a `use` at a region's start is active within that region and reverts at its end (no
  explicit un-use); a top-level `use` applies onward.
```
use {
  nat-has-zero,            // reference: activate an available convention
  eps := epsilon           // binding: define + use a local notation inline
}
```
(Keyword is taste: `use` covers both; `assume` reads more like mathematics for conventions.)

Tri-state removal (distinct from simply not mentioning it):
```
unset notation Nat                  // explicitly remove an inherited entry
```

Conventions for the surface:
- **Scope by location**: where a block lives sets its scope (global config / notebook config / document
  front-matter / inline region). Entries don't each carry a `scope:` tag.
- **Provenance/version are system-attached**, not written in the surface text — the projection
  round-trips *meaning*; the system records who/when/derived-from (like blame, not like a field).
- **Config embeds content**: `display ℕ`, snippet expansions, etc. are math-surface fragments — the
  concrete face of "the simple tier embeds the richer language."

## Notation & convention machinery (near-term — slice 2c-2+)

Three deliberately separate concepts (already reserved in the arch, §6.3a/§6.3c):
- **Snippet** — input shortcut only (`;NN` → …). No meaning.
- **NotationEntry** — meaning / display / canonicalization (+ optional link to a definition).
- **Convention** — a scoped *setting that changes interpretation* (not an alias).

Mechanics:
- **Resolution**: walk the scope cascade, most-specific-wins, over structural containment. Tri-state:
  add / override / `unset`; inherit when unmentioned.
- **Conventions travel (lexical capture).** An embed carries (or references) the conventions resolved at
  its *source* region, so meaning travels. Clash detection = per-`about`-key comparison of captured-
  source vs host. A clash becomes a **`review_items` entry** (reuse the §6.4 conflict model + review
  queue) showing both readings — no new conflict subsystem.
- **Authoring config vs interpretation config** (sets how deep the cascade goes). Config splits by
  *who reads it, and when*:
  - *Authoring config* — cues, snippets — read by the **editor at input time** (shapes how you type).
    Rides the cascade to **document** level, **stable** (not region-bound), does **not travel**.
    Region-scoping it would be confusing — one cue meaning different things within a single doc.
  - *Interpretation config* — conventions — read by **content at interpretation time** (shapes what the
    math means). Wants **region** scope and **travels** with content (lexical; clash-on-embed).
  - Notation is the **hybrid**: its *trigger* is authoring-time/stable; only its *meaning* link is
    interpretation-like.
- **Leading cues (in flight now)** are authoring config — a `cue → unit_type` table, scope-cascaded to
  document with provenance + tri-state, buildable now on this discipline:
  `cues { "Thm." theorem; "Def:" definition; "Lem." lemma; "Pf." proof }`

### Notation/convention vs annotations (the contrast)

Same family and substrate (declarative, provenance, scope/anchor selectors, text projection) — opposite
direction and role:

| | Notation / Convention (config) | Annotation |
|---|---|---|
| Role | a **rule the content reads** | a **mark about a target** |
| Direction | content *pulls* it (config → content) | annotation *points at* content |
| Cardinality | one rule → many occurrences (a class) | one mark → one target (or a predicate set) |
| Selected by | **scope** (cascade level / region) | **anchor** (this span / expr / element) |
| Effect | changes interpretation / display | adds commentary / emphasis |
| Layout footprint | none — it governs, it isn't "placed" | has placement (overlay / gutter / embrace) |
| Authoring | declared (config surface or inline directive) | attached on a target (gesture) |
| Lifecycle | lexical; travels; clash→review | anchored; orphan→review when target moves |

Essence: **config is *read by* content (general, by scope); an annotation is *attached to* content
(specific, by anchor).** Both are secondary and declarative; that's why they're siblings, but their
direction (pull-rule vs point-at), cardinality (class vs instance), and placement (none vs placed) are
what keep them distinct.

## Selector / anchor language (outline — not finalized)

One mechanism for "point at a piece of content," shared by annotations, notation/object references,
conventions' `about`, generated-element targeting, AI candidate targets, and layout overrides. Mirrors
the **W3C Web Annotation** multi-selector model (prior art).

- **Referents** (what a selector resolves to): object · unit · prose span (CharSpan, code points) ·
  sub-expression (path into the expr tree) · structured/generated element (e.g. a Pascal cell) ·
  notation/convention entry · source region (PDF, slice 3) · handle. Cross-cutting axis: the
  **object** (travels to all appearances) vs **this appearance** (one embed/surface), per §6.5.
- **Selector kinds** (by stability/intent): by **id** (stable, authored) · by **structural path**
  (deterministic generated/structured content; sub-expressions) · by **predicate** ("even cells in
  row 4", "all occurrences of ℕ" — set-valued, re-resolves) · by **span** (text/expression range) · by
  **fingerprint** (quote + context; survives edits).
- **Composition**: selectors chain — locate container → refine within → filter by predicate ("row 4"
  refinedBy "even"). (W3C `refinedBy`.)
- **Robustness = a bundle, not one selector.** Store several (id + path + fingerprint + offset); resolve
  best-to-worst; **orphan → review** on total failure (§6.2 graceful degradation; reuse the queue).
- **Resolution semantics**: **snapshot vs live** (per-anchor; default by kind — predicates/paths live,
  spans/ids snapshot) · **single vs set-valued** · **object vs appearance** scope · optional **version
  binding** (resolve as-of a revision, for AI candidates, §6.4).
- **Content-space, never render-space.** Anchors target conceptual addresses, not pixels; the renderer
  maps resolved referents to positions. A layout override = anchor (element identity) + delta.

Unifications: a **convention's `about` is a selector** ("all referents of notation Nat"); an **AI
target** is selector + revision binding; a **layout nudge** is selector + offset; a **reference** is a
by-id selector. One addressing substrate under the whole system.

Open: snapshot-vs-live defaults; exact path/predicate surface syntax (harmonize with mathmeander/config).

## Near-term vs far-future

- **Near (build on this discipline):** snippet / notation / convention machinery; leading-cue config;
  the **selector/anchor language** (load-bearing for annotations, references, generated-element
  targeting, AI, and override anchors — and relevant sooner than diagrams).
- **Far (§14 / later slices):** illustrations + the construction language; the three layout engines;
  the Penrose-inspired constraint engine; full diagram fine-tuning.
- **Not the immediate priority:** the editor (slice 2) remains the fundamental in-flight surface; this
  doc must not pull focus from it.

## Codebase anchors (for when this lands — not edits now)

- `crates/core/src/model.rs` — where notation/convention/snippet types would live (then `just codegen`
  → schema/zod). Reserved arms already exist (`OccurrenceTarget::notation`, `ReferenceTarget::notation`).
- `crates/surface/` — the **text-projection precedent** to mirror (parser + serializer + char-span
  round-trip); the config/notation surface should share this discipline and aesthetic.
- Reserved tables: `notation_entries`, `conventions`, `snippets` (designed in §6.3a/§6.3c, not yet
  created); `scope` enums (`global|space|source|trail|document|environment`).
- `review_items` + §6.4 conflict model — the seam for convention clashes.
- `crates/core/src/mathpack.rs` — export already carries config as *data*; round-trip is a proptest
  invariant.

## Open questions

- Exact surface syntax (the sketches above are shape only).
- The **selector/anchor language** (its own design; snapshot vs live resolution).
- The content/arrangement boundary tiebreaker (leaning "arrangement / keep content lean" — confirm).
- Whether `region` and `environment` are distinct cascade levels or one mechanism.

## Verification (how the principles get enforced when implemented)

- **Round-trip proptests**: `model → text → model` is identity (mirror surface-language + `mathpack`
  invariants) — the mechanical proof that text is a *projection*, not a separate truth.
- **Purity guards** stay green: no eval / I/O / clock / entropy introduced into the core (layout/eval
  are pure *adapters*, not core).
- **Provenance/AI**: system/AI-produced config or illustrations appear as `review_items` candidates and
  require explicit acceptance to materialize.

## Provenance of this note

Distilled from a design discussion (2026-06). It records *direction and rationale*, not committed
architecture; when a section is built, the decision graduates into `docs/mvp_architecture.md` (with the
arch doc remaining authoritative) and this note is updated to point at it.
