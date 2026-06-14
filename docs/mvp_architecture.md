# Higher Mathematics Knowledge Platform — MVP Architecture

**Status:** Reference architecture for the implementation spike. The canonical model is mathematics-first and transparent; the authoring input flow — an owned, names-canonical math surface, frictionless cross-reference, and a rough→LLM-proposes→multimodal-edit review loop — is specified in §6.3a/§9.x/§9.y. Ownership prototype first; heavy AI/PDF work waits behind that gate (§13a).
**Scope basis:** the MVP direction document (§4–§7) plus architecture decisions reached in design discussion
**How to read this:** Sections 1–4 set scope and the one governing principle. Sections 5–11 are the architecture proper. Section 12 onward covers posture (sync, ops, testing), build sequencing, the decided language split, and the assumptions this draft rests on. If an assumption in §18 is wrong, the affected section will say which.

---

## 1. What this MVP is (and is not)

**MVP goal (§4):** prove the input loop — a serious learner inputs rough mathematical material and turns it into high-quality, interconnected, source-linked objects, with raw input preserved and everything exportable and migratable.

**In scope (§5):** rough math editor with LaTeX-compatible math and object blocks; the core object types (note, definition, the **formal family** — theorem, lemma, proposition, corollary, conjecture, claim —, proof, example, question, source_excerpt, trail, annotation); PDF selection-to-object with source provenance; trails and breadcrumbs with light refinement; Inbox and Review Queue; notation snippets + registry; linking, aliases, backlinks, typed relationships; a small set of built-in AI workflows; and export/import + migration *foundations*.

**Reserved, not built (schema must accommodate, no UI):** the entire **computational exploration pillar** (§3.16, §4 explicit) — object types and relationship types reserved in the model; no generator runtime, no GPU, no client experiment engine. **Structured diagrams** are likewise reserved (diagram object type + structured diagram model reserved, no renderer/editor/codegen) — cut from MVP scope to shrink the build (§14). Also reserved: equation-subexpression anchoring, multi-device sync, native apps, BYOK, and richer export targets (Typst/LaTeX/PDF).

**Explicit non-goals (§6):** full graph/map UI, workflow editor, **mobile app, full desktop app**, collaboration, social publishing, handwritten import, spaced review, proof-pattern library, convention ontology, reference-manager replacement, broad diagram illustration, proof-assistant integration, theorem discovery, general CAS, arbitrary code execution, full computational UI.

The discipline throughout is §2.1: **narrow but structurally honest** — the surface is small, the model anticipates the whole direction.

---

## 2. The one governing principle

Everything below serves a single decision (§3.18): there is **one canonical model** — mathematical objects + a typed object graph + a mathematics-first content model (`MathContent`, §6.0) + provenance — and **every syntax, library, and renderer is an adapter around it**. Markdown, LaTeX, Typst, HTML, PDF.js, ProseMirror, KaTeX, and the LLM are all importers, exporters, or views. None of them is ever the source of truth. The content model in particular is derived from *how we preserve the user's mathematics*, not from any editor's document shape.

The single test applied to every choice in this document: *does it keep the canonical model canonical, or does it tempt some library's internal format to become the truth?* The latter is the precise debt the source document warns against ("a diagram should not be stored only as a generated image"; "AI output should not silently become user-authored knowledge").

This is enforced architecturally by isolating the canonical model and all operations on it into one module — **the integrity core** — with a hard boundary, and treating it as the part of the system that stabilizes first and is guarded by property tests.

---

## 3. Architectural shape in one picture

```
                          ┌─────────────────────────────────────────────┐
   TypeScript frontend    │  React + Vite + TanStack (Router/Query)      │
   (web only for MVP)     │  ProseMirror/TipTap · KaTeX · PDF.js         │
                          │  SVG annotation overlays                     │
                          └───────────────┬─────────────────────────────┘
                                          │  typed RPC / REST
                                          │  (types generated FROM the core)
                          ┌───────────────▼─────────────────────────────┐
   Glue + AI tier         │  HTTP · auth/sessions · jobs · persistence   │
   TypeScript (Node)      │  asset storage · request validation         │
   §17 — decided          │                                             │
                          │  provider interface · context assembler ·    │
   fast-changing          │  workflow triples → Review Queue · streaming │
                          └───────────────┬─────────────────────────────┘
                                          │  calls into (in-process napi-rs FFI;
                                          │   core types generated to TS)
                          ┌───────────────▼─────────────────────────────┐
   INTEGRITY CORE (Rust)  │  canonical types · MathContent · validation  │
   slow-changing,         │  migration · serialization · export manifest │
   property-tested,       │  provenance · canonical operations           │
   the architectural bet  │  (pure, I/O-free; compiles to WASM later)    │
                          └───────────────┬─────────────────────────────┘
                                          │  TS query layer + Rust core for pure transforms
                          ┌───────────────▼─────────────────────────────┐
   Data layer             │  PostgreSQL (explicit schema: objects/edges/ │
                          │  detail/provenance/…; pg_trgm, tsvector;     │
                          │  pgvector reserved) · R2 object storage      │
                          └─────────────────────────────────────────────┘
```

The horizontal lines are **seams**, and each is a real separation of concerns, not just a layer label:

- **core ↔ glue** separates *pure, slow-changing, integrity-critical* logic (Rust) from *impure, fast-changing* I/O (TypeScript). The seam is an **in-process FFI boundary via napi-rs** — accepted (§17) in exchange for the TS AI ecosystem and one language across glue + frontend. Either way the core never does I/O.
- **AI ↔ core** separates *non-deterministic, network-bound, fast-churning* orchestration from the deterministic core. The AI tier calls into the core; it never becomes part of it. (The larger the AI surface, the more this seam earns its keep — §8.)
- **frontend ↔ backend** is the network boundary; the frontend's canonical types are *generated from* the core so drift surfaces at build time.

---

## 4. Stack at a glance

| Concern | Choice | Rationale (ties to the brief) |
|---|---|---|
| Integrity core | **Rust** (pure crate) | Canonical model integrity is the product thesis (§2.2). Enums + exhaustive matching make "handle every variant," versioned serialization, and non-destructive migration compiler-enforced, not test-hoped. |
| Glue + AI tier | **TypeScript (Node)** + Rust core via **napi-rs** (§17 — decided) | AI is heavy in *behavior* (§8); the TS LLM/streaming ecosystem + one language across glue and frontend outweigh the FFI seam. Core stays Rust. |
| Object content | **`MathContent`** — a mathematics-first content model (§6.0), *not* an editor doc | First-class units (prose/expression/…) with one user-facing `type`; per-unit crystallization; ProseMirror/KaTeX are frontend adapters only. |
| Data model | **Explicit, transparent schema** — JSONB only for documented-variant structures + snapshots (§6) | The schema documents the model by being it; references become edges (§6.1b); provenance/trail/detail are typed tables. |
| Notation | **Notation registry** (entries + conventions) distinct from **snippets** | Snippet = input shortcut; NotationEntry = meaning/canonicalization; Reference = inserted semantic atom (§6, §6.3a, §3.12). |
| Concurrency | **Optimistic** — `revision` + `expected_revision`, version-bound AI candidates (§6.4) | Single-session removes *merge*, not *concurrency* (tabs, stale state, async jobs). |
| DB access | **TS query layer** + Rust core for pure transforms | SQL-first against an explicit schema; the Rust core (via napi-rs) does validation/migration/serialization. |
| Database | **PostgreSQL** | One datastore: explicit relational schema + `pg_trgm` fuzzy refs + `tsvector` search + reserved `pgvector`. No graph DB (traversals are 1–2 hops). |
| IDs | **UUIDv7 (ULID-style)** | Sortable, **client-mintable**, collision-free — stable and portable for `.mathpack`; reserves offline-create and multi-device. |
| Jobs | **pg-boss / BullMQ** (Node) | Extraction, export rendering, (reserved) embeddings. |
| Frontend shell | **React + Vite + TanStack Router/Query + Zustand** | Client-side workspace, not an SEO site; SSR would fight the editor/PDF. |
| Editor | **ProseMirror via TipTap** + **InputEnvironment** system (§9.x) | Edits a *projection* of `MathContent`; environments drive context-sensitivity (theorem vs proof vs source-note); position-mapping underpins anchors (§3.14). Yjs-ready. |
| Math | **Owned `mathmeander` surface** (names-canonical); **KaTeX/MathML** render it; meaning via refs (§6.3a) | We own the surface grammar; LaTeX/Typst are import/export adapters, KaTeX a render adapter. MathML/parsed-tree upgrade reserved for subexpression anchoring (§7). |
| PDF | **PDF.js as substrate** (react-pdf only if it doesn't obstruct) + multi-selector anchors | Source as an addressable place (§3.6); anchors degrade gracefully (§3.10). Prototype wrapper vs. direct PDF.js early. |
| Diagrams | **Reserved, not in MVP** (§14) — diagram object type + structured model reserved | Cut from MVP scope to shrink the build; "structured data, not pixels" (§3.13) preserved for when it lands. |
| AI | TS; serde-schema'd structured outputs → **Review Queue**; **3 workflows first** | Version-bound typed candidates with provenance; no AI pollution (§2.5, §3.9). No heavy orchestration framework. |
| Type sharing | **Versioned schema artifact emitted by the core** → ts-rs/specta + zod | Frontend + glue types generated from the Rust core; drift caught at build (§7). |
| Export/import | **`.mathpack`** (core: manifest+serialization; glue: zip+asset I/O — §10); **Markdown/HTML** | Lossless by construction (§3.17, §5.10); purity scoped to the core's projections. Typst/LaTeX/PDF + Pandoc reserved. |
| Auth | **Hosted IdP** (e.g. Clerk/WorkOS/Auth.js), JWT verified server-side | Don't roll auth. Single-session enforced server-side as a policy. |
| Storage | **Cloudflare R2** (S3-compatible), content-hashed | Zero egress for repeatedly served PDFs/assets. |
| Hosting | **Container** (Fly.io / Railway) | Long-running server (Node + the Rust addon); container needed when export later shells to Typst/Pandoc. |
| Observability | **structured logs + Sentry** | Logs + error tracking. |
| Testing | **Rust core proptest** + integration tests + **Playwright** | Plus mandatory migration and export/import round-trip suites (§5.10). |

---

## 5. The integrity core (Rust)

This is the architectural bet. It is a **pure, I/O-free, framework-free crate** — no database calls, no HTTP, no clock except what's passed in. Its job is to define the canonical model and the total functions over it.

**Contents:**
- the canonical **type definitions** — objects, the `MathContent` content model (§6.0), edges/references, aliases, annotations, the provenance type, object states, anchor selectors;
- **validation** — turning untrusted input into a valid canonical value or a typed error;
- **schema migration** — total functions `v_n → v_{n+1}`, non-destructive;
- **serialization** — `serde`, the exact wire/storage shape, versioned;
- **canonical operations** — the meaning-changing edit operations (§6.0a);
- **export/import** — the `.mathpack` manifest/serialization and readable-format projections, as pure functions over the model.
- *(The diagram model and its TikZ codegen are **reserved**, not in the MVP core — §14.)*

**Why Rust here, specifically.** The product's entire promise is that user-authored and user-accepted material is never silently lost or corrupted across change (§2.2). Rust's sum types with exhaustive matching make it a *compile error* to add an object variant or split one and forget a site that handles it; `serde` makes every shape change an explicit, versionable serialization decision; migration functions can be checked total. For this domain these are not friction — they are the product invariants enforced by the compiler rather than hoped for in tests. (Gradual crystallization, §2.4, is preserved by keeping not-yet-formalized fields deliberately loose in the types and tightening as they settle; that is crystallizing the *model* gradually while refusing to crystallize *correctness* gradually.)

**The one Rust cost, and how this design neutralizes it.** Ownership/borrowing friction — the one genuinely domain-irrelevant Rust tax — bites hardest on long-lived, shared, mutable, cross-referential in-memory object graphs. This core is deliberately **not** that. It is *transformations over owned, tree-shaped canonical values*: take a value, validate/migrate/serialize/transform, return a value. The object graph's cross-references live as **IDs referencing IDs in the store**, loaded as data when needed — not as in-memory pointers between mutable Rust objects. Structured this way, the borrow checker barely engages in the layer where Rust is used. The discipline to hold: never model the live graph as an in-memory web of interlinked mutable objects.

**Compiles to WASM (reserved).** Because the core is pure and I/O-free, compiling it to WASM later is essentially free. For the MVP it runs **server-side only**; the frontend gets *type definitions* via codegen, not the runtime. When offline/native arrives (§7), the same crate compiled to WASM gives every client identical validation/migration — one integrity implementation across server and every shell. This is reserved, not built now.

---

## 6. Data model (concrete first cut)

Illustrative, not final. Two principles govern this model, both following directly from "preserve the user's mathematical world transparently":

1. **The model is derived from mathematics, not from the editor.** Its vocabulary is what a mathematician would use to describe their own work — objects, statements, hypotheses, conclusions, expressions, references, justifications, conventions. It is *not* the vocabulary of a rich-text editor (nodes, marks, blocks, spans) or a renderer (KaTeX). ProseMirror and KaTeX are **adapters in the frontend only**; the core model does not know they exist. Rule of thumb: *if an editor or rendering term appears in a core type name, that's a bug.*

2. **The schema is transparent: explicit structure is the default, JSONB is the rare, justified exception.** Everything relational and queried — the object graph, references and occurrences, **the content units and their types**, provenance, trail structure, the key fields of anchors — is **explicit schema** (the schema documents the model by *being* the model). JSONB is reserved for two narrow cases: (a) a genuinely variant, **documented** structure (a per-workflow AI candidate; an `extracted_structure` candidate), and (b) snapshots/logs/derived data (AI context snapshots, the search projection). It is never a dumping ground for structure that should be visible. A unit's authored `content` is stored in a **specified, versioned, domain-derived format** (`unit_content` — transparent because the core owns its spec), *not* as opaque editor state; and nesting is **rows**, never embedded trees (§6.0).

### 6.0 The content model — `MathContent`, a flowing sequence of `Unit`s

The content *inside* an object (a theorem and its surrounding thinking, a note's body, a proof's steps) is the part most at risk of being modeled as "editor state" — or, just as bad, as a rigid form. It is neither. It is a representation of **mathematical writing and thinking**: narrative, exploratory, recursive, crystallizing **per part** from rough to precise (§2.4). The model is built on three principles earned over the design discussion:

- **Structure is progressive, local, and reversible.** Rough prose can become typed structure gradually (*progressive*); one sentence can be classified without classifying the rest (*local*); a label can be removed without losing content (*reversible*). At any moment an object can be 100% rough flowing prose and be completely valid — richness is captured *when present* precisely because it is *never forced*.
- **The user performs one classifying act per unit; everything else is inferred or optional.** A person types `Thm.` or `Idea:` — one gesture, one concept. They never choose a "carrier shape" or fill fields. A keyword may expand to several internal facets, but the user only ever performs one act.
- **Types carry the user's chosen meaning; shape is inferred; deeper structure is never required for editing.**

So a `Unit` has **one user-facing axis** (`type`); its authored material is `content`, whose form is internal:

```
MathContent { units: Unit[] }          // ordered; per-unit state — no global rough/structured flip

Unit {
  id            // UUID — what annotations anchor to, AI candidates target, edges point at
  type?         // THE one user-facing label (the unit's function in the math flow). Optional:
                //   absent = plain content. Curated, UI-grouped vocabulary (below).
  content       // UnitContent — the AUTHORED MATERIAL, a tagged union whose tag
                //   (content.kind: prose | math | list | derivation | case_split | embed
                //   | group) is its AUTHORITATIVE discriminator — INTERNAL, inferred or
                //   structurally entered, never a classification the user makes. It is
                //   not a second semantic axis: it only tells consumers how to read
                //   `content`. Any SQL content_kind column is a DERIVED projection
                //   (one fact, one home — §6.0b).
  extracted_structure?  // OPTIONAL candidate decomposition (hypotheses / conclusion /
                        //   dependencies) — proposed by the LLM or confirmed by the user,
                        //   NEVER required for ordinary editing (§6.0b)
  status        // per-unit crystallization: rough | parsed | user_verified | stale (§2.4)
  declared_by   // user | deterministic | imported — who declared this unit's STRUCTURE
                //   (type/kind), a separate fact from content provenance. `ai` is deliberately
                //   absent: AI proposals are review_items, never canonical units; acceptance
                //   enters as `user`, with provenance recording AI origin + derivation (§3.9)
  provenance_id
}
```

The `type` vocabulary is **the user-facing role/category of a unit in the mathematical flow** — the things a user would naturally "mark this as." Some values are flow-roles (motivation, intuition, proof_idea); some are artifact-categories (theorem, proof, example) — and notably, the artifact-like ones are the **candidates for object identity**: most auto-materialize on declaration, while some — a local `claim` — materialize when explicitly tracked or when an edge requires identity (§9.y). The vocabulary's two flavours still track the materialization split, just not as a strict equality. It spans the *whole* flow of mathematical thought, not just finished artifacts, so the platform never biases users toward polished exposition (the central tension of §2.2/§2.4):

```
Formal / claim-like:  theorem · lemma · proposition · corollary · definition
                      · conjecture · claim · question
Reasoning:            proof · proof_step
Thinking (the "living-math" layer): motivation · intuition · idea · proof_idea
                      · remark · observation · warning · analogy · application
                      · open_issue · return_later · note
Examples:             example   (example_kind: illustrative | worked | non_example)
(absent)              plain content
```

Note what is **not** in this list: `list`, `group`, `embed`, `derivation`, `case_split` are *forms*, not math-flow functions — "mark as Idea" is a sensible user act, "mark as group" is not — so they live in `content.kind`, never in `type`. A derivation or case-split is *entered* via a structured-insert gesture (start an aligned chain, add cases); that gesture sets the **content kind**, while the unit's `type` stays whatever it is (often `proof_step`, or none). Examples of the separation:

```
type = intuition      content.kind = prose        "Compactness prevents escape."
type = proof_idea     content.kind = list         three bullet steps
type = question       content.kind = math         a displayed proposition, asked
type = theorem        content.kind = group        prose + display math, as child rows
type = (none)         content.kind = derivation   an aligned =/≤ chain inside a proof
```

Why one axis and not two. An earlier draft split this into `kind` (shape) × `role` (force), which then needed an admissibility table to forbid nonsense like `assertion + question` — because "assertion" smuggled *force* into a *shape*. That collision is gone: **`type` carries force and meaning; `content.kind` carries form only**, and the two are independent because form is purely representational — an `intuition` may be prose *or* math; a `question` may be prose *or* a displayed proposition. The user picks `type`; the deterministic layer infers `content.kind` from syntax + type (§9.y). There is no cross-product of two semantic axes to police, so the admissibility table is deleted.

`UnitContent` variants (mathematical or durable authored structure — never a rendering affordance). **One nesting mechanism, rows only:** a container's children are **rows** (`parent_unit_id` + `position` + `slot`); a unit's `content` holds only its *own* material/attributes, never an embedded unit tree. This is the units-are-rows decision (§6.0b) applied consistently — an embedded tree would have no row identity for anchors, edges, or AI targets.

```
prose       { text, inline: [ mark | math(MathExpression) | Reference ] }
            // prose + inline formatting + INLINE math + mentions. Inline $…$ math is an
            // ELEMENT of prose, NOT its own unit — else one sentence explodes into units.
math        { expr: MathExpression }       // a PLACEMENT of one display/block MathExpression —
                                           //   NOT a separate math model (§6.3a)
list        { ordered: bool }              // items are child rows
derivation  { }                            // steps are child rows; each step child carries its
                                           //   relation (=, ≤, ⇒); justification = slot child
case_split  { }                            // each case = a child group; `slot` marks the
                                           //   assumption child vs body children
group       { }                            // THE generic container — a typed unit's multi-part
                                           //   body, or a neutral user grouping; children are rows.
                                           //   (`mixed` was removed: it was group's structural twin
                                           //   with only a fuzzy intent gloss — an escape hatch.
                                           //   Most "mixed" bodies are simply `prose`, since prose
                                           //   already carries inline math/references/marks.)
embed       { target: ObjectRef | SourceExcerptRef }   // quotes & object embeds

MathExpression { id, surface_text, surface_format, original_input,
                 parse_status, occurrences: Occurrence[] }
                 // identity INDEPENDENT of presentation; display mode is
                 //   DERIVED from placement, not stored — §6.3a
// proof_step is a TYPE, not a content kind: its content is prose/math/derivation/group;
//   justification = an optional child unit (slot='justification'); depends_on = `links` rows
//   (source_unit_id = the step; target an object, or a unit via target_unit_id).
//   Dependencies are NEVER hidden inside content.
// theorem/definition/intuition/etc. carry prose/math/group content; their *force* is the type,
//   their *decomposition* (hypotheses/conclusion) is optional extracted_structure, not units.

Reference  { id, target: Object | Notation | Source }            // a semantic mention IN PROSE
Occurrence { selector, target: Object | Notation }   // a semantic ref INSIDE a MathExpression
                                                      //   (`Symbol` RESERVED with BoundVar — no binder model in MVP)
RESERVED:  BoundVar (+ binder / scope / constraints / quantifier structure) — see below
```

What makes this domain-derived, not editor-derived (and not form-derived):

- **The living-math layer is first-class.** Motivation, intuition, idea, proof-idea, question, open-issue are *types a user can apply to ordinary content*, anywhere in the flow — so "Question. / Motivation. / Theorem. / Idea. / Proof. / Example." is representable as a flowing sequence of typed units, not forced into objects or lost. This is what keeps the model honest about *thinking*, not just *exposition*.
- **Typed units are not unique per object, and need not be contiguous.** One unit has exactly **one** `type` — but an object may contain *many* units of the same type, scattered: a theorem object may carry several `intuition` units, each illustrating a different aspect. Because content is an ordered list and `type` is per-unit, "many intuitions, interleaved" is the default behaviour of a sequence, not a feature. (Consequence for rendering/query in §6.0b.)
- **`Reference` (in prose) vs. `Occurrence` (in math) stay distinct.** "As in [[Bolzano–Weierstrass]]" in prose is a `Reference`; the `f`, `X`, `Y` *inside* `f : X → Y` are `Occurrence`s. Both **extract into graph edges** (§6.1b); neither is "a span styled as a link."
- **Decomposition is deferred, not demanded — and a type fixes the *role*, never the form.** Declaring `type = theorem` fixes the unit's math-flow role; `content.kind` is inferred from the **authored material or structural-insert gesture**, never from the type (a theorem may be one prose paragraph, a single display expression, or a group of parts). The form is still known immediately (*shape-now*) — because the material is — while the hypotheses/conclusion breakdown is optional `extracted_structure`, typically LLM-proposed and user-confirmed later (*decomposition-later*). So a theorem can be one rough sentence forever.

**`extracted_structure` is never canonical knowledge.** It is a candidate/working layer, and every payload carries a **mandatory envelope**: `{ kind, schema_version, generated_by, base_object_revision, accepted_into? }` — the same version-binding discipline as review candidates (§6.4), at unit scale (units carry no revision of their own; the object's concurrency token is the binding), so a decomposition proposed against revision 4 cannot be silently confirmed at revision 9, and acceptance is auditable via `accepted_into`. On acceptance it **materializes into the real model** — into units, into `links`, or into confirmed, specified typed metadata for sub-unit spans — rather than accreting as a parallel truth. The kinds form a **small named registry, each with a schema and a defined acceptance operation**: `hypothesis_conclusion_decomposition` (accept → confirmed typed metadata with selectors, or a split into units) and `proof_dependency_suggestion` (accept → `links` rows); the registry grows deliberately. Note that *unit-type suggestions are review_items, not extracted_structure* — this field holds analysis of a unit's *content*, never proposals about the unit itself. The enforcement rule: **if a structure affects graph, search, rendering, or trust, it must live in units, links, typed metadata, or review items — never only in `extracted_structure`.** Guardrail: this field must not become the new black-box `structured jsonb` this model eliminated (§6).

**Bound variables are reserved, deliberately.** A `BoundVar` without binder, scope, and constraints implies a binding structure the model doesn't capture and would mislead AI context — and modelling quantifier scope properly drifts toward formal-logic semantics, a §6 proof-assistant non-goal. In MVP, `ε` in "for every `ε > 0`" is just expression surface; binder/scope is reserved.

**The guardrail: semantic, not formal.** `MathContent` captures the structure and references the user has *expressed*; it is **not** a machine-checkable formal representation. Expressive enough to hold structure when the user provides it; humble enough to hold rough units when they don't.

**Adapters (frontend only).** The editor edits a *projection* of these units; the renderer renders the *surfaces* of expressions. These are the adapters the governing principle demands, living entirely in the frontend:

```
MathContent ↔ ProseMirror document   (the editing surface — a projection, not the model)
Expression.surface_text (mathmeander) → KaTeX / MathML   (rendering adapter — a projection of one field)
LaTeX ↔ Expression.surface_text      (import + copy-out adapter, §6.3a)
MathContent → HTML / Markdown        (readable export, MVP)
MathContent → Typst / LaTeX          (full-document export reserved)
MathContent → AI context (§8) · search projection (§6.3b)
```

Each unit's `content` is serialized in a **specified, versioned core format** (transparent — meanings fixed by the core's spec, not an editor; "payload" jargon avoided deliberately — this is the user's authored material); unit identity, order, `type`, `content.kind`, `status`, `declared_by`, and nesting are **explicit schema** (§6.0b). No serialized content is load-bearing for interconnection — references and occurrences are lifted into edges.

### 6.0a Canonical operations (the core owns *edits*, not just shapes) — a two-tier model

Defining `MathContent`'s *shape* isn't enough. If the editor mutates a projection freely and POSTs the whole thing back, the core degrades into an after-the-fact validator and the editor's transactions silently become the real semantic operation log — reintroducing, through the back door, the editor-as-truth problem §6.0 just closed. So the core also defines **canonical operations** over *units*, two-tier (a full op-per-keystroke API would fight the editor):

- **Meaning-changing operations → named core operations**, mostly *unit*-level: `set_unit_type` (apply/clear a type — a single act, even when it implies a shape and opens a relation), `split_unit` / `merge_units` (with defined, non-destructive propagation of type, annotations, provenance, **tags**; expression ids are **preserved** by move/split/merge, **minted fresh** by copy, **referenced** by transclude — part of the canonical operation tests, §6.3a), `toggle_expression_placement` (inline ↔ display; preserves `MathExpression.id`, §6.3a), `resolve_occurrence` (a symbol in an expression → a notation/object target), `insert_reference`, `attach_annotation_anchor` / `reanchor_annotation`, `accept_extracted_structure` (confirm an LLM decomposition), `accept_ai_candidate`, `materialize_object` (a span of units → a new object + edge — fired silently when an object-worthy type is declared, §9.y, or explicitly via extract/reuse actions). The frontend issues these as commands (carrying `expected_revision`, §6.4); the core validates and applies; the glue persists the result + a version.
- **Prose-level edits → coarse validated content sync.** Editing the `text` of a unit can use the editor locally and sync a coarse update the core *validates* on save. No per-keystroke op log.

For MVP the line can sit generously toward coarse sync, but the direction is named: **semantic edits are unit operations the core owns; prose edits are validated content.** Because each operation maps an edit back to the *same* unit id, a unit keeps its type, provenance, and anchored annotations across inline editing; `split`/`merge` are the explicit places where that propagation is decided (their semantics — what happens to type, annotations, occurrences — are specified and prototyped early, §9.y/§13a).

**Surface and candidate operations (for §6.3a / §9.w).** Three more named operations extend the list, each preserving the same discipline (the core owns meaning; the editor stays an adapter):

- `rewrite_surface` (a variable rename / symbol swap) — rewrites a `MathExpression.surface_text`, **preserving `expression_id` and `original_input`** and **re-anchoring every inbound `ExpressionRef` and occurrence span** (rebuilding the search projection §6.3b). It is distinct from `resolve_occurrence`, which *binds* a symbol to a target and moves no spans; any span that cannot re-anchor goes stale/to-review, never silently (§6.1b). Default scope is whole-object (rename the bound symbol across statement and proof), not per-expression.
- `edit_candidate(review_item_id, expected_revision, part_id, Patch<part>)` — a **pure** operation mutating an addressable sub-part of a `review_items.candidate` (schema below), **never canonical state**. This is what makes the `[Edit]` arm of an AI proposal first-class and core-owned rather than an editor-as-truth backdoor (§9.w).
- `revise_candidate_part(review_item_id, anchor_target, intent_or_text, expected_part_base, expected_candidate_rev)` — a **glue-tier** workflow (the LLM call lives in glue, §8); the core only **validates the returned sub-part** into the candidate union, re-anchors its `ExpressionRef`s, and checks the version tokens. The returned part may not touch siblings.

And `accept_ai_candidate` carries an explicit contract: it materializes the *surviving* sub-parts as **one** `object_version` with **one** AI-origin `provenance` row (deriving the mixed user+AI lineage from the candidate's `edit_log`), and it **refuses** while any sub-part is pending-confirm (§9.w).

### 6.0b Object content is flowing units; structure is per-unit, not typed fields

A math object's content is **one flowing `MathContent`** (an ordered unit sequence) — *not* a fixed layout of typed content fields. This is the Q1 decision: a proof is a freeform mixture of prose, claims, proof-steps, derivations, partial conclusions, *and* the questions/ideas/intuitions sprinkled through it, and forcing that into `statement`/`hypotheses`/`conclusion` columns would be too rigid and would fight gradual crystallization (§2.4).

**`object.type` ≠ `unit.type` — stated once, plainly.** `object.type` is **durable workspace identity** (this row is a theorem object: findable, linkable, exportable on its own); `unit.type` is a **local math-flow label inside authored content**. The two coexist by design: a theorem *object* typically contains a `theorem`-typed unit (its statement) plus motivation/intuition/proof-idea/example units; a *note* object may contain theorem-*like* content that is not yet declared (or is only an AI candidate) — the moment the user *declares* `Thm.`, a draft theorem object materializes behind the scenes (§9.y greedy capture): **declaration, not later reuse, is the graph-entry event.** A `theorem`-typed unit may thus materialize an object with `object.type = theorem` — same word, **different layers**; neither implies the other's lifecycle. This holds across the whole formal family by one rule: **every materializable unit type has an identical object type — materialization maps `type` by identity** (`lemma → lemma`, `conjecture → conjecture`, edge-materialized `claim → claim`). No family object type carries a detail table, so the object-type extension is enum-only — and the unit-type and object-type vocabularies can never drift apart again for this family.

- **Types, not fields, carry "what a theorem says."** "The statement of this theorem" = its `theorem`/`claim`/`conjecture`-typed unit(s); rendering and export present them set-apart by *reading types*, computed on demand. The finer hypotheses/conclusion breakdown is optional `extracted_structure` (§6.0), not stored fields. So you keep a structured *view* without structural *rigidity*, and an untyped theorem is still just flowing units.
- **Typed units are not unique per object and need not be contiguous — and renderers must respect that.** A theorem may carry several `intuition` units (and several `example`, `remark`, `proof_idea` units) scattered through its flow, each on a different aspect. "Show the intuitions for this theorem" is therefore `units WHERE type = intuition ORDER BY position` — a renderer or exporter must **gather scattered same-type units**, never assume one-per-object. (Attachment is by co-location: these intuitions are about the object they sit in. An intuition about *one specific distant thing* is instead an **edge**, §6.1b — the usual intrinsic-vs-relational split.)
- **Only genuine non-content metadata stays a typed field.** A definition's **definiendum (`term`)** is object identity, so it's a small column (§6.1c); `proves`, `depends_on`, `uses` are **edges**. There are no `statement`/`hypotheses`/`conclusion` content columns.
- **Units are rows (`content_units`), not a blob.** This gives units the stable identity the rest of the model needs (anchors, AI targets, edge sources) and keeps the model transparent. Nesting (group/list/case_split children) is via `parent_unit_id` + `position`.

**Variants, alternatives, and reformulations are objects + edges — never fields, never new object types.** This is the general answer to "multiple proofs," "informal vs. formal definitions," etc.:
- *Multiple proofs of one theorem* = multiple **proof objects**, each with its own `proves` edge to the theorem (many-to-one); "the theorem's proofs" is the backlink query. A proof's **flavour** ("elementary", "slick", "by contradiction") is the proof object's own `type`-label or a **user tag** — not a field on the theorem.
- *Informal and formal definitions of one notion* = two **definition objects** joined by an `equivalent_to` edge (MVP uses `equivalent_to`; `reformulates`/`refines` reserved). The informal-vs-formal distinction is just each object's content/typed units; no per-type "intuition slot" is added to definitions.
- The rule: the graph already expresses "many things related to one thing"; that *is* the representation. A field-based design would force `proofs[]`/`definitions[]`/`flavour` enums; the object-graph-plus-labels model absorbs all of it with no new primitives.

**References and occurrences extract into graph edges — never load-bearing only inside a unit's content.** When a proof references theorem X, or an `Occurrence` inside math denotes the naturals, that relationship is a row in `links` (§6.1b) carrying its source `unit_id` — queryable, in backlinks, visible to the graph. The unit keeps only a *local* marker (a `Reference` in prose, an `Occurrence` selector in math) for rendering position. This is the concrete payoff of transparency: interconnection (§3.1, §3.10) works because it's in the schema.

Two downstream consequences: the **search projection** (§6.3b) flattens text across an object's units; and **annotation anchors** (§6.2) gain a precise `UnitRef { unit_id }` selector — "this hypothesis" anchors to a unit id, cleaner than a path into a field.

```sql
-- One row per first-class object (note, definition, theorem/lemma/proposition/
-- corollary/conjecture/claim (the formal family — enum-only, no detail tables), proof, example,
-- question, source_excerpt, trail, annotation). COMMON fields only; content is in
-- content_units; type-specific metadata in detail tables (§6.1c).
-- (diagram + computational: reserved, §14.)
objects (
  id              uuid PRIMARY KEY,         -- UUIDv7, client-mintable
  type            text NOT NULL,            -- validated by core enum (§ enum-vs-text)
  title           text,                     -- nullable: see tri-state
  raw_source      text,                     -- the rough input, preserved verbatim (§2.2)
  status          text NOT NULL,            -- OBJECT lifecycle: raw/draft/ai_drafted/
                                            --   user_verified/trusted/needs_review/deprecated
                                            --   (distinct from per-unit status, §6.0)
  schema_version  int NOT NULL,             -- model/schema version (for migration)
  revision        int NOT NULL,             -- OPTIMISTIC-CONCURRENCY token (§6.4)
  provenance_id   uuid NOT NULL REFERENCES provenance(id),  -- typed table, not a blob (§6.1)
  space_id        uuid NOT NULL,            -- one space/user for MVP; reserved multi-space
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
)
-- NOTE: no `body jsonb` / `structured jsonb`. Content lives as typed MathContent in detail
-- tables; provenance is its own table (§6.1); references are edges (§6.1b).
-- indexes: GIN on tsvector(title, raw_source) for search;
--          pg_trgm on title/aliases for fuzzy [[ ]] resolution

-- `unit_content` below = serialized UnitContent in the ONE specified, versioned core format
-- (§6.0): a SINGLE unit's own authored material — never an embedded unit tree (children are rows,
-- parent_unit_id + position + slot). Transparent (spec owned by the core), not opaque editor
-- state; shown as a distinct domain type to make clear it is NOT generic jsonb.
-- Practically: stored as jsonb (optionally behind a PG DOMAIN). "Not generic JSONB" is a
-- DISCIPLINE claim — the shape is the core-owned, versioned UnitContent schema, carried in the
-- §7 artifact — not a storage-type claim. It is validated and migrated ONLY through the core;
-- Postgres does not (and cannot) enforce the recursive content schema itself. The GENERATED
-- content_kind column relies on this jsonb representation.

-- PROVENANCE as a typed table (not a per-row blob), so it is queryable/auditable. One row per
-- provenanced fact; entities carry provenance_id. Origin-specific fields are nullable by origin
-- (validated by the core, §6.1a).
provenance (
  id              uuid PRIMARY KEY,
  origin          text NOT NULL,            -- user | ai | imported | system
  created_by      text,                     -- user/agent id
  occurred_at     timestamptz NOT NULL,
  model           text,                     -- ai: OPEN-ENDED model identifier (BYOK-ready)
  prompt_template text,                     -- ai: template id + version
  context_snapshot_id uuid REFERENCES ai_context_snapshots(id),  -- ai: what it saw (§3.15)
  review_item_id  uuid REFERENCES review_items(id), -- ai: WHICH accepted suggestion produced this
                                            --   canonical state — closes the audit loop. On an
                                            --   acceptance row: origin = ai (content origin),
                                            --   created_by = the accepting USER (authority),
                                            --   review_item_id = the suggestion. Origin and
                                            --   acceptance are both explicit, not inferred from
                                            --   the derivation chain.
  source_id       uuid REFERENCES sources(id),  -- imported: origin source
  source_locator  jsonb                     -- imported: SourceLocator tagged union (§6.1d)
)

-- Derivation chain as a typed, FK-checked join table (uuid[] cannot be FK-checked, and
-- provenance is the trust spine — "references are edges" applies to provenance itself).
provenance_derivations (
  provenance_id              uuid NOT NULL REFERENCES provenance(id),
  derived_from_provenance_id uuid NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (provenance_id, derived_from_provenance_id)
)

-- CONTENT as flowing UNITS (§6.0b). Every object's content is an ordered sequence of units.
-- Unit identity/order/type/content-kind/status/declared_by/nesting are EXPLICIT; the authored
-- content is serialized `unit_content` (the one specified format, §6.0). Units are what anchors/AI/edges target.
content_units (
  id             uuid PRIMARY KEY,
  object_id      uuid NOT NULL REFERENCES objects(id),
  parent_unit_id uuid REFERENCES content_units(id),  -- THE nesting mechanism: children are rows
  position       int NOT NULL,                        -- order among siblings
  slot           text,                  -- container-internal part where needed, e.g. 'assumption'
                                        --   (case child) | 'justification' (proof_step child); NULL else
  type           text,                  -- THE one user-facing MATH-FLOW label (NULL = plain).
                                        --   Core-validated; matches §6.0 EXACTLY:
                                        --   theorem/lemma/proposition/corollary/definition/
                                        --   conjecture/claim/question · proof/proof_step ·
                                        --   motivation/intuition/idea/proof_idea/remark/observation/
                                        --   warning/analogy/application/open_issue/return_later/note ·
                                        --   example
                                        --   (forms — list/derivation/case_split/embed/group —
                                        --    are content.kind values, NEVER types)
  content_kind   text GENERATED ALWAYS AS (content->>'kind') STORED,
                                        -- DERIVED index projection of UnitContent.kind — the tag
                                        --   inside `content` is AUTHORITATIVE; this column is never
                                        --   independently written (one fact, one home). If the
                                        --   domain blocks a generated column, the core maintains it
                                        --   and validates equality. Kinds: prose|math|list|
                                        --   derivation|case_split|embed|group. `math` = a display
                                        --   PLACEMENT of a MathExpression, not a separate math
                                        --   model (§6.3a); `group` = the generic container.
  example_kind   text,                  -- for type=example: illustrative|worked|non_example.
                                        --   OPTIONAL refinement, never a second classifying act:
                                        --   cues like "Non-example:" expand to type + kind in ONE
                                        --   gesture (§9.y), or it is set later — one-axis holds.
                                        --   Future *_kind analogues (question_kind, proof_kind…)
                                        --   are deliberately NOT added until a cue as common as
                                        --   "Non-example:" demands one
  status         text NOT NULL,         -- PER-UNIT crystallization: rough|parsed|user_verified|stale
  declared_by    text NOT NULL,         -- user|deterministic|imported — who declared the unit's
                                        --   STRUCTURE (≠ content provenance). `ai` deliberately
                                        --   absent: AI proposals live in review_items; acceptance
                                        --   enters as user + AI provenance/derivation (§3.9)
  extracted_structure jsonb,            -- CANDIDATE only — never canonical. Mandatory envelope
                                        --   {kind, schema_version, generated_by, base_object_revision,
                                        --   accepted_into?}; acceptance MATERIALIZES into units/links/
                                        --   typed metadata (§6.0). Never the sole home of anything
                                        --   affecting graph/search/rendering/trust. Never required.
  content        unit_content NOT NULL, -- serialized UnitContent (§6.0): ONE unit's OWN authored
                                        --   material — never an embedded unit tree (children = rows)
  provenance_id  uuid NOT NULL REFERENCES provenance(id)
)
-- INTEGRITY INVARIANTS (DB-enforced where possible, core-enforced otherwise, §6.1a):
--   UNIQUE (id, object_id)                        — enables the composite FK below
--   (parent_unit_id, object_id) → content_units (id, object_id)
--                                                 — a parent must belong to the SAME object
--   UNIQUE (object_id, parent_unit_id, position)  — sibling order is total; needs NULLS NOT
--                                                 DISTINCT (PG15+) or an expression index, since
--                                                 root-level siblings have parent_unit_id = NULL
--   `slot` valid for the parent's content.kind; container kinds take children as rows — core (§6.1a)
--   NO type↔kind admissibility: a type NEVER constrains content.kind (theorem may be prose/math/
--   group; intuition may be prose/list/math). The core rejects impossible STRUCTURAL states only,
--   never unusual expressive pairings — soft UI nudges at most (§6.0).
-- "Statement of a theorem" = its units WHERE type IN (theorem,lemma,proposition,corollary,conjecture,
-- claim) — a view, not a stored field (§6.0b). Hypotheses/conclusion may be PROPOSED in
-- extracted_structure until accepted; accepted decomposition MATERIALIZES into units/links/typed
-- metadata (§6.0) — extracted_structure is never their permanent home.
-- Occurrences live in the unit's `content` (inline math in prose, or a `math` unit) AND extract to
-- `links` edges (§6.1b). embed content targets a source-excerpt/object via an edge. UnitContent.kind
-- is INFERRED by the deterministic layer (§9.y), never chosen by the user; the content_kind column is
-- only its derived projection. No kind↔role admissibility table: one axis (type).

-- TYPED OBJECT DETAIL (§6.1c) is now only NON-CONTENT metadata — content is in content_units.
definition_detail (
  object_id   uuid PRIMARY KEY REFERENCES objects(id),
  term        text NOT NULL          -- the definiendum (object identity); body is flowing units
)
-- the formal family (theorem/lemma/proposition/corollary/conjecture/claim) / proof / example /
-- question / note carry NO content columns and NO detail tables: content is flowing units;
-- a proof's `proves` and a theorem's `depends_on`/`uses` are EDGES (links), not fields.

-- The EDGE table: typed relationships AND references/occurrences extracted from content (§6.0b/§6.1b).
-- Each carries its source unit_id, so it is queryable, shows up in backlinks, and the graph sees it.
links (
  id              uuid PRIMARY KEY,
  source_object_id uuid NOT NULL REFERENCES objects(id), -- the EDGE's source end. Renamed from
                                                  --   source_id: `sources(id)` exists in this schema,
                                                  --   and one name for both is a trap.
  -- POLYMORPHIC TARGET — exactly one set, or none (= unresolved/fuzzy); CHECK-enforced.
  -- FK columns rather than target_kind+uuid because a bare polymorphic uuid cannot be FK-checked.
  target_object_id   uuid REFERENCES objects(id),
  target_notation_id uuid REFERENCES notation_entries(id), -- an occurrence/`;` ref may resolve to the
                                                           --   registry BEFORE any definition object exists
  target_source_id   uuid REFERENCES sources(id),          -- whole-work refs ("see [Rudin]") only;
                                                           --   PASSAGE refs target source_excerpt OBJECTS
  target_unit_id     uuid,                                 -- optional refinement: a unit WITHIN
                                                           --   target_object_id. DB-enforced via the
                                                           --   composite-FK pattern: (target_unit_id,
                                                           --   target_object_id) → content_units(id,
                                                           --   object_id). Expression refinement stays
                                                           --   in target_selector
  unresolved_text    text,                                 -- the literal reference text ([[…]] or an
                                                           --   occurrence surface) while UNRESOLVED —
                                                           --   the resolution queue reads this, never
                                                           --   parses content; cleared on resolution
                                                           --   (the raw form persists in the marker)
  target_selector jsonb,                          -- TargetSelector tagged union (§6.1d)
  type            text NOT NULL,                  -- core-validated: related/uses/source_for/
                                                  --   example_of/counterexample_to/application_of/
                                                  --   motivated_by/answers/generalizes/
                                                  --   special_case_of/equivalent_to/questions
                                                  --   (computational types RESERVED)
  status          text NOT NULL DEFAULT 'active', -- core-validated: active | stale | deprecated.
                                                  --   The schema home for the §6.1b lifecycle —
                                                  --   CANONICAL edges only: a deliberate/deterministic
                                                  --   edge whose structural basis vanished goes stale
                                                  --   (review routing via review_items). Marker-derived
                                                  --   edges NEVER go stale: they sync with their markers
                                                  --   or die with them (a stale derived edge is a
                                                  --   contradiction in terms).
  from_content    boolean NOT NULL,               -- true = extracted from content (Reference/Occurrence)
  source_unit_id  uuid,                           -- which unit the reference/occurrence sits in;
                                                  --   composite FK (source_unit_id, source_object_id) →
                                                  --   content_units(id, object_id) — must belong
                                                  --   to the source object
  in_expression   boolean GENERATED ALWAYS AS
                    (content_locator->>'kind' = 'expression_span') STORED,
                                                  -- DERIVED from the locator kind — never written
                                                  --   independently (one fact, one home)
  content_locator jsonb,                          -- ContentLocator tagged union (§6.1d):
                                                  --   prose_span | expression_span | whole_unit
  provenance_id   uuid NOT NULL REFERENCES provenance(id),
  created_at      timestamptz NOT NULL
)
-- THE KNOWLEDGE GRAPH STAYS OBJECT-ONLY: typed graph edges (proves/uses/equivalent_to/…) REQUIRE
-- target_object_id (core-validated per link type). notation/source targets occur only on
-- content-derived rows (from_content = true) — resolution targets, not graph edges.
-- HARD INVARIANTS (§6.1a; core + CHECKs):
--   from_content = false              ⇒ target_object_id IS NOT NULL   (no off-graph deliberate edges)
--   target_notation_id IS NOT NULL    ⇒ from_content = true
--   target_source_id   IS NOT NULL    ⇒ from_content = true
--   target_unit_id     IS NOT NULL    ⇒ target_object_id IS NOT NULL (+ composite FK above)
--   all targets NULL                  ⇒ unresolved_text IS NOT NULL  (a queue item must name itself)
--   any target set                    ⇒ unresolved_text IS NULL
--   ⟹ EXACTLY ONE of {target_object_id, target_notation_id, target_source_id, unresolved_text}
--     is present. target_unit_id / target_selector are REFINEMENTS of target_object_id —
--     never target alternatives.
-- backlinks = SELECT ... WHERE target_object_id = $1  (single indexed query)

aliases (
  id          uuid PRIMARY KEY,
  object_id   uuid NOT NULL REFERENCES objects(id),  -- an alias always names an EXISTING object.
                                              --   (The old "NULL = awaiting resolution" is removed:
                                              --   unresolved REFERENCES are links rows carrying
                                              --   unresolved_text — one mechanism, not two)
  name        text NOT NULL,
  kind        alias_kind NOT NULL,           -- user/source/context/standard
  scope       alias_scope NOT NULL,          -- global/space/source/trail/local
  scope_ref   uuid                           -- the scoping entity (source, trail, note…)
)

-- USER HANDLES (§6.3b) — optional human names for INTRA-object referenceable elements: a
-- displayed equation or a hypothesis (a whole unit/expression), NOT an object (objects use
-- `aliases` — "an alias names an existing object"). Whole-unit/whole-expression targets only:
-- coarse sub-spans drift and have no export target. Bind to id, not span (presentation- and
-- dialect-independent); exportable. A reference still BINDS to the id; the handle is only what
-- the user reads (see §6.3b numbering). NOT required — the computed number is the default label.
handles (
  id            uuid PRIMARY KEY,
  space_id      uuid NOT NULL,
  name          text NOT NULL,                 -- "(★)", "the energy identity", "BW"
  -- FK-checked target: the owning object (always) refined by exactly one of unit / expression
  target_object_id     uuid NOT NULL REFERENCES objects(id),
  target_unit_id       uuid,                    -- composite FK (target_unit_id, target_object_id) -> content_units(id, object_id)
  target_expression_id uuid,                    -- a MathExpression id (resolved via the expression->unit index, §6.3a)
                                                --   CHECK: exactly one of {target_unit_id, target_expression_id}
  status        text NOT NULL DEFAULT 'active', -- active | stale (target gone -> to-review, never silent, §6.1b)
  scope         text NOT NULL,                  -- object | space (uniqueness/conflict scope, §6.3b)
  provenance_id uuid NOT NULL REFERENCES provenance(id)
)

-- USER TAGS (§6.0b; decided v6, schema lands here — a decision isn't done until it's in the SQL).
-- Free-form personal organization ("beautiful", "exam", "central") — a facet apart from `type`
-- and from edges; no mathematical semantics; thin UI (tag + filter); feeds ranking ("central").
tags (
  id        uuid PRIMARY KEY,
  space_id  uuid NOT NULL,
  name      text NOT NULL,
  UNIQUE (space_id, name)
)
taggings (
  id                uuid PRIMARY KEY,
  tag_id            uuid NOT NULL REFERENCES tags(id),
  -- FK-checked polymorphic target (the §6.1b pattern — never target_kind + bare uuid):
  tagged_object_id  uuid REFERENCES objects(id),       -- exactly one set, CHECK-enforced
  tagged_unit_id    uuid REFERENCES content_units(id),
  created_at        timestamptz NOT NULL
)
-- duplicate-tagging prevented via partial unique indexes per target column.

-- Annotations are objects (type='annotation'). They carry TWO distinct things:
--   anchor    = WHAT the annotation is about (derived geometry, never device pixels)
--   placement = WHERE each mark appears relative to the anchor (user-movable)
annotation_detail (
  object_id     uuid PRIMARY KEY REFERENCES objects(id),
  backing_link_id uuid REFERENCES links(id),  -- nullable. A SEMANTIC arrow IS a link rendered
                                 --   with placement: the annotation points at the link; it never
                                 --   carries its own relation field (one fact, one home — the
                                 --   old relation_type duplicated links.type). Callout/decorative
                                 --   marks have no backing link. (If one annotation ever needs to
                                 --   visualize several links, an annotation_links join table is a
                                 --   compatible extension — implementations must not hard-code a
                                 --   one-link-per-annotation assumption.)
  primitives    jsonb NOT NULL,  -- specified list of marks {kind, style, placement} (§6.2).
                                 --   HOW IT IS DRAWN, never what it is about: a primitive's
                                 --   endpoints reference annotation_targets row ids (arrow:
                                 --   from/to row ids; ellipse: one; brace: several) — geometry
                                 --   never embeds its own targets
  -- note body: an annotation IS an object, so its note content is its OWN content_units rows
  --   (units-are-rows applied consistently; no embedded content column)
  provenance_id uuid NOT NULL REFERENCES provenance(id)
)

-- WHAT THE ANNOTATION IS ABOUT: one row per semantic target — NOT primary/secondary/tertiary
-- columns (positional columns break at the brace-grouping-three-assumptions case, which the
-- reserved CellSet selector has anticipated since v3). One target row = its FK-checked refs
-- + its OWN multi-selector anchor payload — unifying what was previously split between an
-- anchor blob and shadowing FK columns. MVP annotations (highlight, margin note, one-anchor
-- arrows) have exactly one row; slice-4 semantic arrows and braces add rows, not schema.
annotation_targets (
  id               uuid PRIMARY KEY,
  annotation_id    uuid NOT NULL REFERENCES objects(id),
  role             text NOT NULL,   -- STRUCTURAL only: main | from | to | member.
                                    --   Never relational (no compared/supports/contrasts):
                                    --   relation SEMANTICS have exactly one home — `links`
                                    --   (the annotation's backing_link_id points at it, §6.2)
  position         int NOT NULL,    -- order among same-role targets (brace members, etc.)
  -- polymorphic FK-checked target (same pattern + invariants as links, §6.1b):
  target_object_id uuid REFERENCES objects(id),   -- an object, or…
  target_source_id uuid REFERENCES sources(id),   -- …a source directly (raw PDF marks);
                                                  --   knowledge-grounding flows through
                                                  --   source_excerpt OBJECTS instead
  target_unit_id   uuid,            -- refinement: composite FK (target_unit_id, target_object_id)
                                    --   → content_units(id, object_id)
  anchor           jsonb NOT NULL   -- THIS target's selectors (§6.2 multi-selector; §6.1d union)
)
-- Invariants: exactly one of target_object_id/target_source_id set (CHECK); target_unit_id ⇒
-- target_object_id; UNIQUE (annotation_id, role, position); every target-row id a PRIMITIVE
-- references must belong to the same annotation_id (core, §6.1a); an anchor's UnitRef selector,
-- when present, must EQUAL the row's target_unit_id (authority in the FK column; the selector
-- chain stays whole for export/re-resolution). Per-target rows also make PARTIAL orphaning
-- representable — "one of this brace's three targets broke" goes to orphan review with the
-- others intact (§9).

object_versions (                -- lightweight history (§2.2), append-only
  id          uuid PRIMARY KEY,
  object_id   uuid NOT NULL REFERENCES objects(id),
  version_no  int NOT NULL,
  snapshot    jsonb NOT NULL,    -- serialized canonical object in the specified format (a snapshot/log)
  provenance_id uuid NOT NULL REFERENCES provenance(id),
  created_at  timestamptz NOT NULL
)

sources (                        -- PDFs and other source material
  id               uuid PRIMARY KEY,
  kind             source_kind NOT NULL,   -- pdf (others reserved)
  asset_key        text NOT NULL,          -- R2 key, content-hashed
  metadata         jsonb,                  -- title, authors, etc. (BibTeX/RIS reserved)
  reading_position jsonb,                  -- §3.6 reading-position memory
  space_id         uuid NOT NULL
)

-- A source excerpt is BOTH a knowledge object (type='source_excerpt' in `objects`) AND a
-- source anchor — so it gets a typed companion table rather than living untyped in a blob.
source_excerpt_detail (
  object_id         uuid PRIMARY KEY REFERENCES objects(id),
  source_id         uuid NOT NULL REFERENCES sources(id),
  anchor_kind       text NOT NULL,         -- DERIVED: the kind of the anchor's PRIMARY (first)
                                           --   selector — core-maintained, never independently
                                           --   written (one fact, one home — the content_kind rule)
  anchor            jsonb NOT NULL,        -- specified multi-selector into the source (§6.2)
  quoted_text       text,                  -- as captured
  normalized_text   text,                  -- cleaned, for search/dedup
  crop_asset_key    text,                  -- optional snapshot/crop in R2 (math figures)
  page_label        text,                  -- printed page label
  page_index        int,                   -- 0-based page index
  extraction_method text,                  -- e.g. text-layer / region-OCR / manual
  confidence        numeric                -- extraction confidence where applicable
)

-- A trail is an object; its breadcrumbs are an ORDERED, TYPED sequence — explicit rows, not a blob.
trail_steps (
  id          uuid PRIMARY KEY,
  trail_id    uuid NOT NULL REFERENCES objects(id),
  position    int NOT NULL,                -- order within the trail
  kind        text NOT NULL,               -- object_ref | source_passage | return_later
                                           --   | external_placeholder | side_quest | gap (§3.7)
  target_id   uuid REFERENCES objects(id), -- the referenced OBJECT, where applicable.
                                           --   source_passage steps target source_excerpt
                                           --   OBJECTS (the §6.1b passage rule) — no raw-source
                                           --   polymorphism needed here
  detail      jsonb,                       -- per-kind SPECIFIED tagged payload (§6.1d) —
                                           --   placeholder/side_quest/gap; never arbitrary
  created_at  timestamptz NOT NULL
)

activity_events (                -- raw, mostly-hidden activity history (§3.7)
  id         uuid PRIMARY KEY,
  space_id   uuid NOT NULL,
  kind       text NOT NULL,
  ref        jsonb,
  created_at timestamptz NOT NULL
)

inbox_items (                    -- user-captured, not yet placed (§3.9)
  id         uuid PRIMARY KEY,
  space_id   uuid NOT NULL,
  payload    jsonb NOT NULL,     -- highlight, question, snippet, breadcrumb, fragment…
  created_at timestamptz NOT NULL
)

review_items (                   -- system/AI-generated pending decisions (§3.9)
  id                  uuid PRIMARY KEY,
  space_id            uuid NOT NULL,
  kind                text NOT NULL,        -- core-validated: extracted_candidate / duplicate_match /
                                            --   notation_conflict / orphaned_annotation /
                                            --   ai_draft / proposed_outline / inferred_link
  candidate           jsonb NOT NULL,       -- specified, per-kind candidate payload (documented variant);
                                            --   sub-parts are candidate_part_id-tagged typed sub-objects
                                            --   (type_proposal/decomposition_part/alias_proposal/
                                            --   variable_binding/edge_proposal), each carrying a per-part
                                            --   base_object_revision_at_edit + correspondence_key and an
                                            --   append-only edit_log — the home of pre-accept user edits (§9.w)
  context_snapshot_id uuid REFERENCES ai_context_snapshots(id),  -- what the AI saw (§8)
  base_refs           jsonb NOT NULL,       -- specified VERSION BINDING (§6.4): the state this was
                                            --   generated against, e.g.
                                            --   { objects:[{id,revision}], sources:[{id,extraction_version}] }
                                            --   so approval can detect "generated vs thm rev 4, now rev 7"
  working_revision    int NOT NULL DEFAULT 0,-- candidate-local concurrency token (§9.w): guards async
                                            --   scoped revisions against in-flight mechanical edits;
                                            --   distinct from object.revision and from base_refs
  provenance_id       uuid NOT NULL REFERENCES provenance(id),
  status              review_status NOT NULL,-- pending/approved/rejected/corrected
  created_at          timestamptz NOT NULL
)

-- INPUT SHORTCUT ONLY — a snippet says "when the user types `trigger`, insert
-- `expansion`." It carries no mathematical meaning. Meaning lives in notation_entries.
snippets (
  id          uuid PRIMARY KEY,
  space_id    uuid NOT NULL,
  trigger     text NOT NULL,     -- e.g. ';NN'
  expansion   text NOT NULL,     -- e.g. '\mathbb N'  (or a notation_entry ref)
  scope       snippet_scope NOT NULL  -- global/space/source/local
)

-- NOTATION REGISTRY — the mathematical MEANING/display/canonicalization of a notation,
-- scoped and environment-aware. This is what a text expansion cannot capture (does `NN`
-- mean the naturals? a local notation? does it conflict with "nearest neighbour"? does it
-- link to a definition object?). Provenance/versioned because it's user-owned (§2.2, §3.12).
notation_entries (
  id                 uuid PRIMARY KEY,
  space_id           uuid NOT NULL,
  trigger            text NOT NULL,        -- NN, \N, Nat …
  display            text NOT NULL,        -- ℕ
  canonical_latex    text,                 -- \mathbb{N}
  semantic_target_id uuid REFERENCES objects(id),  -- optional link to a definition object
  kind               text NOT NULL,        -- core-validated: symbol/abbreviation/operator
                                           --   (`convention` removed: conventions are a first-class
                                           --   table now — no duplicated concept)
  scope              notation_scope NOT NULL,      -- global/space/source/trail/document/environment
  scope_ref          uuid,
  environment_mask   jsonb,                -- specified: which InputEnvironments it applies in (§9.x)
  ambiguity_policy   text,                 -- auto / suggest / require-confirmation
  schema_version     int NOT NULL,
  revision           int NOT NULL,
  provenance_id      uuid NOT NULL REFERENCES provenance(id),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
)

-- CONVENTIONS — scoped mathematical settings that change interpretation, not just naming
-- (§3.12). E.g. "ℕ includes 0 in this space", "compact means quasi-compact in this source",
-- "ring = commutative-with-identity in this trail". Not aliases: these influence autocomplete,
-- AI context, conflict detection, and interpretation. First-class + provenance/versioned;
-- UI stays lightweight for MVP (context notes, not an ontology engine).
conventions (
  id          uuid PRIMARY KEY,
  space_id    uuid NOT NULL,
  kind        text NOT NULL,            -- core-validated: notation_convention / terminology_convention /
                                        --   domain_assumption / source_interpretation /
                                        --   ambient_structure / definition_policy
                                        --   (so conventions aren't just "notes with a label")
  statement   text NOT NULL,            -- human-readable convention
  applies_to  jsonb,                    -- optional specified: symbols/terms/domains it governs
  structured  jsonb,                    -- optional specified machine-usable form (reserved depth)
  scope       notation_scope NOT NULL,  -- global/space/source/trail/document
  scope_ref   uuid,
  schema_version int NOT NULL,
  revision    int NOT NULL,
  provenance_id uuid NOT NULL REFERENCES provenance(id),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
)

-- SEARCH PROJECTION — a denormalized, derived index rebuilt on write (not a source of truth).
-- Drives [[ ]] fuzzy resolution and object autocomplete (§3.11, §5.8). Built from canonical
-- objects: flattens plain text from every object's MathContent field(s) (§6.3b).
search_documents (
  object_id   uuid PRIMARY KEY REFERENCES objects(id),
  plain_text  text NOT NULL,        -- title + raw_source + flattened MathContent prose
  math_text   text,                 -- renderable LaTeX strings + notation display/canonical_latex
  aliases     text[],               -- alias names for this object
  rel_labels  text[],               -- relationship labels touching it
  tsv         tsvector,             -- full-text (GIN)
  updated_at  timestamptz NOT NULL
)
-- indexes: GIN(tsv); pg_trgm on plain_text/aliases for typo-tolerant matching

-- AI CONTEXT SNAPSHOTS — exactly what each AI call saw. Makes §3.15 ("inspect the context")
-- real, and supports debugging, evals, reproducibility, cost analysis, and version-bound review.
ai_context_snapshots (
  id               uuid PRIMARY KEY,
  space_id         uuid NOT NULL,
  workflow_id      text NOT NULL,         -- which §8 workflow
  prompt_template  text NOT NULL,         -- template id + version
  input_refs       jsonb NOT NULL,        -- the objects/sources/selection that fed it (+ revisions)
  rendered_context jsonb NOT NULL,        -- the assembled context actually sent
  token_count      int,
  created_at       timestamptz NOT NULL
)

users, sessions                  -- sessions enforce single-active-session (§12)
```

**Three distinct concepts, deliberately separated:** a **Snippet** is an *input shortcut*; a **NotationEntry** is the *meaning/display/canonicalization* (and optional link to a definition object); a **SymbolRef/NotationRef** is the *semantic atom actually inserted into the document* (§6.3a). So `;NN` is one way to *input* a reference to the notation entry for the naturals — and what lands in the document can be `{type: notation_ref, notation_id, surface: "NN"}` rather than a bare `\mathbb N` string, where the user has accepted semantic resolution. (Plain display math with no accepted resolution still stores bare LaTeX — see §6.3a.)

**Future-reserved object families (§5.2).** The computational families — `computational_exploration`, `computational_output`, `saved_observation`, `parameter_setting`, `comparison_experiment` — and the relationship types `visualizes / generated_by / observation_from / parameter_variant_of / compares_with` are **reserved as a namespace**, but I'd *not* commit fully-named Rust/Postgres enum variants for the computational **object** types yet. Reasoning (a refinement of the earlier draft): Rust's exhaustiveness already makes *adding* a variant later a safe, compiler-guided change — it shows you every match site to update — so pre-declaring named variants buys little, while committing a name into a Postgres enum (where rename/remove is painful) risks lock-in to a shape that is, by the whole computational discussion, still genuinely uncertain. The cheap reservation is therefore: keep the **relationship-type** names (more stable, and Postgres enum *additions* are easy), document the object-family namespace, and add the object-type variants when their minimal schema is known. **Postgres enums vs. `text` + core validation.** Native PG enums are convenient but painful to rename/remove. Since this platform will *evolve* object families, the recommendation is: store the **evolving** kinds — `object_type`, `relationship_type`, `notation_kind`, `review_kind`, `convention_kind` — as **`text` validated by the Rust core** (which holds the authoritative enum, optionally enforced by a migration-generated `CHECK`), so adding/renaming a value is a core change + cheap migration rather than a fraught `ALTER TYPE`. Reserve native PG enums for the genuinely stable, rarely-changing sets (e.g. `object_status`). Type safety still lives in the core either way; this is only about how the DB column is typed.

### 6.1 Provenance (a typed table, §6 schema)

Provenance is a **typed table** (not a per-row JSONB blob), so it is queryable and auditable; every provenanced entity carries a `provenance_id`. Its fields are explicit (see the `provenance` table above): `origin`, `created_by`, `occurred_at`; for AI origin, `model` + `prompt_template` + `context_snapshot_id`; for imported, `source_id` + `source_locator`; plus a derivation chain in **`provenance_derivations`** (a typed, FK-checked join table rather than a `uuid[]` — provenance is trust-central). The `model` field is deliberately **open-ended** text, not a closed enum of the two default models — the cheap reservation that lets a future BYOK/BYO-endpoint feature record "generated by the user's local model" without a migration. Origin-specific fields are nullable-by-origin and enforced by the core (§6.1a).

### 6.1a Core validation invariants (polymorphic refs SQL can't enforce)

Several fields are **polymorphic references** that a relational schema can't FK-check, so the **core owns these invariants** as part of validation — they are exactly the integrity rules the Rust core exists to guarantee:

- **Type-qualified object references** (SQL cannot cheaply express these; the core enforces them): every `*_detail.object_id` must reference an object of the matching type; `trail_steps.trail_id` must reference a `trail`; `annotation_targets.annotation_id` an `annotation`.
- **Link-target discipline** (§6.1b): a non-content row (`from_content = false`) must carry `target_object_id`; notation/source targets imply `from_content = true`; `target_unit_id` implies `target_object_id` and same-object membership (composite FK). This is what keeps the typed knowledge graph object-only as a *validated invariant*, not a convention.
- **`*.scope` ↔ `*.scope_ref` consistency** (for `notation_entries`, `conventions`, `aliases`): `global` → `scope_ref` IS NULL; `space` → NULL or equals `space_id`; `source` → references `sources(id)`; `trail`/`document` → references `objects(id)` of the expected type; `environment` → a known InputEnvironment id. A `source` scope pointing at a trail id is a validation error.
- **`links.target_selector` / `annotation_targets.anchor`** must reference an existing object (or source) and, where a sub-target is given, a selector shape valid for that target type.
- **`provenance` origin-fields**: AI fields present iff `origin='ai'`, import fields iff `origin='imported'`, etc.
- **`base_refs` (review_items)** must reference objects/sources that exist; stale revisions are *allowed* (that's the point — they trigger rebase, §6.4) but malformed refs are rejected.

These are property-tested alongside serialization and migration (§16).

### 6.1b References and occurrences are edges (not buried in content)

The `links` table is the single home of relationships — deliberate typed links *and* both flavours of content reference (§6.0b): a `Reference` in prose and an `Occurrence` inside an expression. Each content-derived edge carries `from_content = true`, its **`source_unit_id`** (which unit it sits in), `in_expression` (true for occurrences), and a `content_locator` — for occurrences, **`{expression_id, char_span}`** (§6.3a), which is stable across inline/display toggles and surrounding prose edits; for prose references, a span within the unit. The canonical relationship lives in the edge, so backlinks and graph queries see it; the unit keeps only a local marker for rendering. **Targets are polymorphic but constrained** (the table FK-checks each kind): the typed knowledge graph is **object-only** — every graph edge type requires an object target — while content-derived rows may instead resolve to a `notation_entries` row (an occurrence resolved before any definition object exists) or, for whole-work references, a `sources` row; *passage* references always flow through `source_excerpt` **objects**, keeping source grounding inside the graph.

**Edge lifecycle vs. content (generalizing the §9.y proves rule):** marker-derived edges (`from_content = true`) are *derived state*, synchronized with their markers — deleting the unit or the `Reference`/`Occurrence` marker deletes the edge. Deliberate edges anchored to units (`from_content = false` with a `source_unit_id`, e.g. a proof step's `depends_on`) are *canonical state*: deleting the anchoring unit never silently deletes them — they go **stale / to review**, removed only by the user.

### 6.1c Typed object detail is non-content metadata only

With content as flowing units (§6.0b), the typed detail tables hold **only non-content metadata**: `definition_detail.term` (the definiendum, which is object identity). Theorems, proofs, examples, questions, and notes have **no content columns** — their content is `content_units`, the mathematical force of each unit is its **`type`** (theorem/claim/conjecture/…), any hypotheses/conclusion breakdown is optional `extracted_structure`, and relationships (`proves`, `depends_on`, `uses`) are **edges**. "A theorem is a typed object, not styled prose" is expressed by *unit types + extracted structure + edges*, not by statement/hypotheses/conclusion columns — which keeps it from being rigid (§2.4).

### 6.1d Specified tagged unions — locators and selectors are never open blobs

The remaining small JSONB fields — `links.target_selector`, `links.content_locator`, `annotation_targets.anchor`, `annotation_detail.primitives` (an `AnnotationPrimitive` list), `provenance.source_locator`, `trail_steps.detail` (per-kind), the `review_items.candidate` sub-parts (`candidate_part_id`-tagged: `type_proposal` / `decomposition_part` / `alias_proposal` / `variable_binding` / `edge_proposal`), and the §9.w `RevisionIntent` / `AnchorTarget` — are each a **named, versioned tagged union defined in the core** and carried in the §7 schema artifact (ts-rs/specta + zod), so an implementer treating one as an open blob gets a **build error**, not a code-review comment:

```
ContentLocator  = prose_span { start, end }                       // within source_unit_id
                | expression_span { expression_id, start, end }   // stable across toggles (§6.3a)
                | whole_unit
TargetSelector  = ExpressionRef                     // FINER-than-unit refinement only; unit-level
                | StructuralPath (reserved)         //   refinement is the FK column target_unit_id —
                                                    //   never duplicated as a selector (one home)
AnchorPayload   = { selectors: [AnchorSelector] }   // §6.2 — per annotation_targets ROW; the
                                                     //   target itself lives in the row's FK columns
SourceLocator   = pdf_text   { page_index, quote/position … }
                | pdf_region { page_index, normalized_bbox }       // mirrors source-excerpt anchors
RevisionIntent  = Weaken | Strengthen | StateMoreGenerally | StateMoreSpecifically   // §9.w Lane-2 verbs
                | SplitStep | ExpandStep | JustifyStep | UseDifferentKindOfVariable
                | ReclassifyAs { object_type } | FreeForm { text }
AnchorTarget    = { candidate_part_id, sub?: ExpressionRef | prose_span | whole_part }   // §9.w deixis
```

**Context rule — implicit vs explicit ids:** in `links`, a `ContentLocator` is paired with the `source_unit_id` column (the unit is context-supplied) and a `TargetSelector` with `target_id` (the object is context-supplied); used *outside* those pairings (e.g. inside `extracted_structure` or an anchor payload), a locator/selector must carry its `unit_id`/object id explicitly — context-dependent locators are fine, but the schema must say when context supplies the id. Every serialized value carries its variant tag plus the artifact's schema version; the core validates shape per tag (§6.1a). Flexibility is preserved — adding a variant is a core change plus an artifact bump — but "JSONB" never means "anything."

### 6.2 Anchor and placement model

An annotation carries **two distinct things**, and conflating them is a modeling error:

- **Anchor** — *what the annotation is about* (the unit, the equation, the phrase, the region). This determines correctness and never moves on its own.
- **Placement** — *where each mark appears relative to that anchor* (left margin, below the equation, a callout off to the side). This is presentation, and it is **user-movable**.

Both store **intent, not raw device pixels** (§2.1) — but with one practical nuance: *raw device pixels* are never truth, yet **normalized page/document geometry is legitimate truth for region anchors** when no better semantic selector exists. For math-heavy PDFs many anchors will start as `Region { page, normalized_bbox }`, and that is the *correct* fallback, not a failure — the team should not over-engineer semantic anchoring before shipping. Geometry that *can* be derived from a unit/text/structural selector is derived; region geometry that *is* the anchor is stored normalized (resolution-independent), and survives zoom because it's normalized rather than pixel-absolute.

**Anchor (what it's about).** Multiple selectors resolved in priority order, so it survives edits and degrades gracefully:

```
Anchor {
  target: ObjectRef                      // which object / PDF / source
  selectors: [                           // resolved in priority order
    UnitRef { unit_id }                  // a content unit ("this hypothesis") — precise, stable id
    ExpressionRef { expression_id, span? } // a math expression — stable across inline/display (§6.3a)
    TextQuote { quote, prefix, suffix }  // a phrase (editor span or PDF text layer)
    TextPosition { start, end }          // offset within the resolved target
    Region { page, normalized_bbox }     // PDF math / image region
    // RESERVED for §7 subexpression anchoring:
    StructuralPath { expression_id, term_path }  // a sub-TERM inside an expression; not used in MVP
    CellSet / ElementSet                         // composite targets, reserved
  ]
}
```

**Placement (where it appears).** Stored per mark as *relative* placement so dragging is persisted but pixels are not:

```
Placement {
  reference: AnchorRelative      // tracks the anchor box: offset (dx, dy) from it
           | MarginRelative      // pinned to a margin: side (left|right),
                                 //   vertical tied to the anchored line/row,
                                 //   horizontal offset into the margin
           | PageRelative        // rare; normalized to the page (still not raw px)
  offset:    layout-relative offset (not absolute pixels)
  // arrows / leader lines carry two endpoints, each AnchorRelative or a relative point,
  // so an arrow from a margin note to the equation re-routes as either end moves.
}
```

Each primitive kind uses placement differently: **highlight/underline** have no free placement (they sit *on* the anchored span — zero degrees of freedom); **margin note/callout** float and are freely repositionable; **ellipse/curly brace** mostly derive from the anchor with optional padding/size; **arrow** connects two endpoints — and arrows need a sharper model.

**Arrows are three different things; model them explicitly.** An arrow can be (1) a **callout** — `note → target`, one meaningful anchor plus a margin endpoint; (2) **decorative** — visual only, attached to one region; or (3) a **semantic relation** — `target A → target B`, e.g. "proof step 3 → hypothesis 2," which has *two* meaningful anchors. So an annotation carries **one or more semantic target rows** (`annotation_targets`: a structural `role` — main | from | to | member — order, the FK-checked polymorphic target, and that target's own selector payload), never fixed primary/secondary/tertiary columns — an arrow has a `from` and a `to` row, a highlight has one `main` row, a brace has several ordered `member` rows (the reserved CellSet case), and each visual primitive references the target *rows* it draws between, with per-endpoint placement. **Targets say what it is about; primitives say how it is drawn.** The important independent point: **a semantic arrow (one expressing a relation between two real targets) IS a typed link (§6 `links`) rendered with placement — the annotation carries `backing_link_id`, never its own relation field.** Relations belong in the knowledge graph — that's the single source of typed relationships, what backlinks and future dependency views read from — so a semantic arrow is rendered *from* a link (with visual placement attached), rather than duplicating relation semantics inside annotations. Callout and decorative arrows stay pure annotation primitives. *(MVP scope: ship one-anchor callout/decorative arrows; two-anchor semantic arrows and their link-backing are reserved alongside the broader anchor work, §13a slice 4.)*

**Marks are cheap; excerpts are knowledge (UX rule).** A casual PDF highlight targets the source directly (`target_source_id`: page/region) — local, free, no knowledge object minted. It **graduates** to a `source_excerpt` object the moment it grounds knowledge: when it is referenced, extracted from, linked, or annotated with substance. This keeps the graph from swallowing every underline while keeping every underline one gesture away from becoming knowledge.

**Movability — and the distinction that matters.** Two different user gestures:

- **Reposition** (drag the mark to a new spot) → updates `placement` only. The anchor — what it's about — is unchanged. This is the common case: nudge a margin note down, move it below the equation, switch margins.
- **Re-anchor** (re-attach to a different target) → updates `anchor`. A deliberate, distinct action (e.g. drag-onto-target with a modifier, or an explicit "re-attach"), so casual dragging never silently changes meaning.

On create, a mark gets a sensible **default placement** (margin notes → margin, callouts → near the anchor with a leader) that the user then adjusts. If an anchor orphans (target changed/deleted, §9), the last-known placement travels with the annotation into the Review Queue so it can be shown for reattachment.

**MVP uses `UnitRef` + `ExpressionRef` + `TextQuote` + `TextPosition` + `Region`** for anchors and `AnchorRelative` + `MarginRelative` for placement. The `StructuralPath`/composite anchor variants and `PageRelative` exist in the enums but are unused — reserving subexpression/diagram-element anchoring (§3.14, §7) as additive. *(Scope note: the MVP can ship constrained placement — margin notes that drag vertically and switch sides — and add fuller free-canvas placement later; the stored model is the same either way, so this is a UI-degrees-of-freedom choice, not a schema change.)*

### 6.3 Tri-state fields, IDs, versioning

- **Tri-state field semantics.** A field is *unset* (never given), *explicitly empty*, or *has a value*, and migrations/edits/exports must never collapse the first two into a default. This is modeled in the **core types** (e.g. an explicit presence wrapper / `Option<Option<T>>` where it matters), with nullable columns plus the convention that **migrations never backfill a default for a previously-unset field**. This is the precise meaning of "preservation of unknown fields" (§2.2) — a typing discipline, not a JSONB feature.
- **IDs.** UUIDv7, client-mintable, stable across export/import — reserving offline-create and multi-device.
- **Schema versioning & migration (§5.10).** Two levels: a SQL-structure migration tool (e.g. node-pg-migrate) for DB structure, and an **application-level `schema_version` per object** with total, non-destructive migration functions in the core. Migration tests run against **old fixtures** from day one; a previously-unset field stays unset after migration.

### 6.3a `MathExpression`: stable identity, independent of presentation

We **own the math surface**: it is a clean, names-canonical linear grammar (`mathmeander`, see below), not LaTeX or Typst — those become import/export adapters and KaTeX/MathML a render adapter. A surface is canonical only as *renderable text*, never as *meaning*. And one expression often denotes *several* things — `f : X → Y` references `f`, `X`, and `Y` — so a single optional `meaning` is too small. A **`MathExpression`** — the one structure for all math, wherever it sits — holds:

```
MathExpression {
  id:             uuid            // STABLE IDENTITY — minted in content, presentation-independent
  surface_text:   string          // the CANONICAL surface in OUR grammar (names-canonical mathmeander) — see below
  surface_format: mathmeander      // our owned grammar (default/canonical); `latex` retained for raw-imported/unnormalized; typst | asciimath RESERVED
  input_syntax:   mathmeander | latex | typst | asciimath | unicode | mixed | unknown   // how it was entered/imported (tri-state: absent ≠ unknown; migrations never backfill)
  original_input: string          // raw keystrokes, preserved verbatim — NEVER overwritten by normalization (§2.2)
  parse_status:   unresolved | renderable | partially_resolved | invalid   // per OUR parser — is the surface usable?
  occurrences:    Occurrence[]     // 0..n semantic refs inside the surface (each → an edge, §6.1b)
}
// Display mode is DERIVED from placement — inline element of prose ⇒ inline; math unit ⇒ display.
// It is NOT an independently mutable stored field (no impossible states like a "display" expression
// sitting inline). Projections may emit it for self-description; the core normalizes any incoming
// value to match placement (§6.1a).
Occurrence { selector, target: Notation | Object }   // `Symbol` RESERVED with BoundVar; MVP selector = coarse char span (Q3)
```

**Expression identity ≠ unit identity — two layers, doing different jobs.** Inline `$…$` math is a `MathExpression` *as an element of prose*; display `$$…$$` math is the same structure *wrapped by a unit* (`content.kind = math`) for block-level behavior. A display equation on its own line therefore carries **both** identities: the expression id (the mathematics) and the wrapping unit id (the block). Block-level affordances — future equation numbering, "(∗)"-style labels, "by (3.2)" references, equation-as-target annotation — attach to the **placement** (the wrapping unit); the mathematics itself is identified by the **expression**. This is why display math keeps a unit rather than being pure typography, *without* letting typography own identity.

**The toggle contract.** Toggling inline ↔ display **preserves `MathExpression.id`**; there is no mode field to flip — *the mode is the placement* — so what changes is *placement* only — pulling an expression out to display (or folding it back in) splits/merges the surrounding prose unit through the **already-specified split/merge machinery** (§6.0a), so unit ids change only via that ordinary path. In the UI this is one gesture; canonically it **composes two separate operations** — `toggle_expression_placement` (identity-preserving by this contract) and, when the surroundings require it, `split_unit`/`merge_units` (which may change unit ids, under their propagation rules) — kept separate so each guarantee is independently testable. A typography flip never mints or destroys mathematical identity. This avoids both bad extremes: every-inline-expression-a-unit (prose confetti) and presentation-determines-identity (the flaw in the earlier inline/display split).

**Binding to expressions, not positions.** Because expressions carry ids, occurrence edges and math-targeting anchors bind to **`expression_id` + a span within its surface** (§6.1b, §6.2 `ExpressionRef`) — strictly more stable than unit-relative character spans, since the binding survives both display toggles and edits to surrounding prose. Expression ids are minted in content (UUIDv7, like all ids) and are **unique workspace-wide, core-enforced on write** — which forces the copy rule: **copying content mints fresh expression ids** (otherwise one id has two homes and every `ExpressionRef`/locator turns ambiguous); *paste-as-reference* is the transclusion path — the same copy-vs-transclude choice the ownership prototype must make deliberate (§9.y). The canonical *relationships* still live in `links` rows — edges-not-blobs holds — and the **expression → unit index is an MVP derived projection**, not a someday: `ExpressionRef` anchors and occurrence locators resolve through it.

Two axes are kept distinct (the model previously conflated them): `parse_status` is about the *surface* (can it render / is it resolved), while the **unit's** `status` (§6.0) is about *authoring crystallization* (rough → user_verified). An expression can be `renderable` yet sit in a `rough` unit.

**The owned surface (`mathmeander`).** The canonical `surface_text` is our grammar, **names-canonical**: atoms are spelled as ASCII names (`cal(F)`, `alpha`, `sum`, `<=`) and 2D structure is linear operators (`a/b`, `x^2`, `x_(i+1)`, `lr((..))`, `mat(..)`, `cases(..)`, `sqrt(..)`, `sum_(..)^(..)`). It is greppable, diffable, and fully keyboard-typeable — you never need to type or store raw Unicode (glyphs are render-time output and an optional input convenience). **Rendering is an adapter:** `mathmeander → KaTeX/MathML`; we do not hand-write a 2D layout engine for MVP. **LaTeX/Typst are import/export adapters** — pasted LaTeX is imported and normalized to the surface; copy-out is a dual clipboard (a plain LaTeX flavor — the universal lingua franca for Overleaf/arXiv/email — plus an app-native flavor carrying `original_input` + `input_syntax` for paste-back fidelity / transclude). `parse_status` is defined by **our** parser, and un-parseable input is never punished: it persists as `invalid` with `original_input` intact (§2.2). **Keystone invariant:** occurrence and `ExpressionRef` anchors index character-spans into `surface_text`, so **normalization may run only while an expression has zero occurrences and zero inbound anchors** — i.e. at input/paste time, before any anchor exists — or else through an explicit, property-tested span-remapping operation; otherwise it would silently invalidate every span pointing into it. Occurrences stay **coarse character-spans** (Q3) — so `f : X → Y` records edges to all three targets at modest cost; the expensive part — hit-testing *sub-terms* for annotation/reference (a parsed tree / MathML `StructuralPath`) — stays reserved (§6.2, §7). Names-canonical also keeps spans simple: ASCII tokens avoid the multi-code-unit glyph hazards that grapheme-cluster handling would otherwise force.

### 6.3b Search projection (derived, not canonical)

Search is a **denormalized projection** (`search_documents`) rebuilt on write, never a source of truth — so fuzzy `[[ ]]` resolution and object autocomplete (§3.11, §5.8) work without a second datastore. Per object it flattens: `title`; `aliases`; `raw_source`; **plain text across all of the object's `content_units`** (prose text + claim/proof-step/derivation content — §6.0b); math **surfaces** plus notation `display`/`canonical_latex`; **source quote text** (`normalized_text` from `source_excerpt_detail`); and relationship labels. Lexical only for MVP (`tsvector` + `pg_trgm`); semantic `pgvector` search is reserved.

**Default ranking (explicit, product-tunable — the other half of "maturity controls noise," §9.y):** `trusted`/`user_verified` above `draft`; title/alias matches above body matches; objects above notation/source resolution rows; `deprecated` hidden **unless explicitly searched**; a mild recency boost, with the **active trail's context boosted** over global results. Greedy capture feels magical rather than noisy only if ranking does this work from day one. *(Later refinement: type-aware boosts — a query like `[[compactness theorem]]` should favour theorem-typed objects.)*

**Numbering and display labels — a second derived projection.** A reference's *binding* is a stable id (a unit / expression / object `UUIDv7`), **never shown to the user**; what the user reads is a **display label** computed on demand by a pure **numbering projection** over an object's units — a sibling of `search_documents`, rebuilt on write. The numbering *policy* (per-object vs per-document/trail; eager vs lazy; all display-math vs only marked) is **passed in as presentation config**, so the math/presentation split (§6) holds and the pure core stays policy-free. Reordering recomputes the display; edges keep pointing at the same ids. A user may **optionally name** any referenceable element — an object via `aliases`, a unit/expression via `handles` — and where a name exists it is what chips and `[[ ]]`/Cmd-K candidates show; otherwise the computed number shows. So there is **no `\label`/`\ref` bookkeeping**: writing `Thm.`/`$$` already minted the id, the number is computed, the optional name is one keystroke. Candidates surfaced to the user are always **human-readable, never UUIDs**; on LaTeX/Typst export the hidden bookkeeping is *generated at the boundary* (names/numbers become `\label`/`\ref`). *(Open: the display default when an element has both a name and a number — name, number, or `name (number)` — and the name-uniqueness scope.)*

### 6.4 Optimistic concurrency (single-session is not single-concurrency)

Single active session removes *multi-device divergence*; it does **not** remove ordinary concurrency. Even one user has concurrent writers: two browser tabs, stale client state, slow requests racing, and — most importantly — **asynchronous jobs that finish after the user has moved on** (AI extraction, background dedup, export/import, review approvals computed against an older context). So every mutable entity carries `revision`, and:

- **Writes require `expected_revision`.** Mismatch → **409 Conflict**; the client rebases if safe, asks the user if not, or files a review item if it was AI-generated.
- **AI candidates are bound to the version they were generated from.** A candidate records `basedOn: {object_id, revision, context_snapshot_id}`. Approving a candidate that was generated against revision 7 does **not** blind-apply if the object is now revision 10 — it routes back through review against the current state. This is the concurrency-aware half of the §2.5/§3.9 trust model, and it matters *more* the larger the AI surface becomes (see §8).

**Three distinct version concepts, with explicit policies** (so a text editor doesn't snapshot on every keystroke):

- **`revision`** = the **concurrency token**. Increments on **every persisted write**; used only for optimistic-concurrency conflict detection.
- **`object_versions`** = **user-facing history checkpoints**. A snapshot is created on **meaningful save boundaries** — explicit/auto-save points and **status transitions** (e.g. draft → user-verified) — *not* on every write. (Debounced editor saves snapshot periodically, not per keystroke.)
- **`activity_events`** = **fine-grained activity** (§3.7), mostly hidden, for reconstructing recent paths.

So: `revision` gates writes, `object_versions` is the history the user can browse/restore, `activity_events` is the breadcrumb trail.

---

## 7. Backend / glue tier (TypeScript / Node — §17)

Fast-changing I/O around the core, in **TypeScript** (§17 decided). Responsibilities: HTTP, auth & sessions, background jobs, persistence, asset storage (R2), and request validation (which calls the core). It owns nothing canonical — it loads data, hands it to the Rust core (via napi-rs) for validation/migration/serialization, persists what comes back.

- **Framework:** a Node HTTP framework with good SSE support for AI streaming.
- **Core access:** the **Rust core as a napi-rs native addon** — TS calls in for validate/migrate/serialize/apply-operation; the FFI is a serialization boundary on those (non-hot-path) calls. Accepted per §17.
- **Persistence:** a TS query layer over the explicit schema; the Rust core does the pure transforms. (No heavy ORM; the schema is explicit and the queries are mostly direct.)
- **Migrations:** SQL-structure migrations + core migration functions (object content/payloads).
- **Jobs:** **pg-boss** (Postgres-backed) or BullMQ for extraction, export rendering, and (reserved) embeddings.
- **Auth & sessions:** a hosted IdP (Clerk/WorkOS/Auth.js) issuing JWTs verified in middleware. **Single active session per user** is enforced here as a server-side policy (issue session, invalidate prior on new login). Critically, *single-session is a policy in this tier, not an assumption in the data model* — the model stays multi-client-capable so multi-device is an additive future, not a rewrite. Residual concurrency is handled by §6.4.
- **API & type sharing — define the *artifact*.** The **Rust core emits a versioned schema package** describing `MathContent`, object detail shapes, anchors, notation entries, and review candidates; the TS glue and frontend consume it via **ts-rs/specta + generated zod validators**. Frontend/glue types are generated from the Rust core, so drift is a build error.

---

## 8. AI tier

Central to the product (§5.9) and likely **thin in infrastructure but not thin in behavior** — the model call is a single shot, but the surrounding behavior is where the real work concentrates: context assembly, object-aware retrieval, prompt versioning, candidate schemas, model-specific quirks, source-grounded extraction, ambiguity handling, streaming partial candidates, evals/regression, and cost control. That behavioral weight is the reason this tier deserves its own iteration story and a deliberate language choice (§17), and the reason a heavy orchestration framework is still the wrong tool: the hard part is context assembly — bespoke domain logic over the object graph that a framework would fight, not chain-of-LLM-calls plumbing.

It lives *in* the glue tier — so its language **is TypeScript (§17, decided)**, with the integrity core staying Rust (reached via napi-rs). It is *not* a separate service and *not* Python on the request path; it calls *into* the core to read/validate canonical data, and is never part of the core (opposite stability and purity profiles). It stays unified with the glue precisely because context assembly is coupled to the object graph and must not be severed from the model call. (Python remains available *offline* for eval harnesses; it is not on the request path.)

**A larger AI surface strengthens, not weakens, two existing decisions.** The bigger and more experimental the AI tier becomes, (a) the more valuable the hard **core ↔ AI seam** is — you want a large, churning, non-deterministic surface kept firmly out of trusted canonical storage (§2.5), which is exactly what the seam guarantees; and (b) the more the **version-bound candidate** rule (§6.4) matters — more candidates generated against state that may have moved before approval.

- **Provider interface.** A `LlmProvider` trait abstracts the model vendor. This is the single seam that reserves **BYOK and BYO-endpoint** (§17 reservation) — adding "use the user's key/endpoint" later is implementing behind this trait, touching no workflow code. API keys are server-side only; user-supplied keys (future) are treated as an **encrypted-secret category**, never logged, never echoed to the client, never written into context snapshots.
- **Context assembler.** Plain domain logic that gathers the relevant context — current selection, current object, current trail, linked definitions, source excerpts, user notes — into a snapshot. This snapshot is **stored** so §3.15 "inspect what context the AI used" is just rendering it. (Retrieval here is *graph-aware* — follow links, pull the linked definition, walk the trail — not generic top-k vector similarity, which is another reason off-the-shelf RAG plumbing is a poor fit.)
- **Workflow = (context recipe, prompt template + version, output schema).** Each workflow is one such triple over shared machinery.
- **MVP workflow set — start with a few, not eleven.** Although §5.9 lists eleven as the MVP *target*, eleven multiplies prompt/version/eval/review/concurrency complexity before the machinery is proven. Build first: **(1) extract object candidate from a source/editor selection, (2) polish a rough object, (3) suggest links/duplicates, (4) suggest structure** — propose `type`s for untyped units ("this paragraph reads like *motivation*; this sentence like a *theorem*") and decompositions (`extracted_structure`: hypotheses/conclusion) — the semantic half of the authoring workflow (§9.y). All **propose into the Review Queue / as inline suggestions; never silently impose** (the user's own labels are authoritative, §9.y). Then expand toward the full set.
- **Structured outputs, not prose.** Every workflow returns a serde/JSON-schema-validated **typed candidate** — e.g. a structure suggestion as `{ unit_id, suggested_type, extracted_structure?, confidence }`, or an extracted object as a typed-unit set — bound to its source version (§6.4), flowing into the **Review Queue** stamped with model id, prompt-template id+version, and context snapshot. On acceptance a suggestion **materializes** — a `type` on the unit; units/`links` where the structure corresponds to real elements; or confirmed `extracted_structure` (documented schema) for sub-unit spans — never an accreting parallel truth (§6.0). the unit enters or updates with `declared_by = user` and **AI provenance + derivation** (authority ≠ origin, §6.0). This operationalizes the §3.9 rule: *if the system generated it, it goes to Review* — never silently into user-authored knowledge.
- **Editable candidates (the `[Edit]` arm).** A candidate is not take-it-or-leave-it. Its sub-parts are addressable (`candidate_part_id`); the user edits them directly via `edit_candidate`, and a scoped `revise_candidate_part` re-runs the model on a *single anchored sub-part* (§6.0a) — so the user can change a variable, a label, or disagree with a hypothesis marking by interacting with the proposal, not only by prompting. The interaction surface (in-place overlay + Verb Lens), the trust spine, and the **global context-aware assistant** for open-ended/cross-cutting asks are specified in **§9.w**. Build the minimal accept/reject + mechanical edits first; the scoped-revision channel follows behind slice 2's gate (§13a).
- **Streaming.** Responses stream to the client via SSE; the Review Queue handles partial/streamed candidates gracefully.
- **Rate, cost, abuse.** Per-user rate limiting and quotas and provider-key protection are built early (cheap now, expensive to retrofit), since AI is server-mediated.

---

## 9. Frontend (TypeScript, web only)

A client-side workspace. Shell: **React + Vite + TanStack Router + TanStack Query** (server cache) + **Zustand** (local UI/editor state). Canonical types are generated from the core (§7).

**Editor (the heart) — ProseMirror via TipTap, editing a *projection* of `MathContent`.** The editor and its node types are an adapter (§6.0); on save, the projection maps back to `MathContent` and meaning-changing edits go through canonical operations (§6.0a).
- Editor node types (the editor's vocabulary, not the core's): theorem / definition / proof / example regions, inline/display math (whose *surface* is LaTeX, rendered by KaTeX — the *meaning* lives in the `Expression`, §6.3a), object/notation/source references, and annotation-anchor marks.
- `;` **snippets** via input rules are the *input shortcut*; what they insert resolves against the **notation registry** (§6) so accepted notations become semantic references, not bare LaTeX (§6.3a). A user-editable, scope-aware snippet dictionary backs this (§5.6).
- `[[ ]]` **object search** and `/` **commands** via TipTap's Suggestion utility; candidate sources, snippet scope, and notation scope are all driven by the current **input environment** (§9.x) — completion inside a theorem differs from inside a note or a source-note.
- **Type cues / slash menu** issue canonical operations (§6.0a): a leading word (`Thm.`, `Idea:`), `/command`, or select-then-mark sets a unit's `type` — the central authoring workflow (§9.y). Routine in the editor, meaning-changing in the core.
- Rough input is never punished (§5.1): malformed LaTeX and informal references are preserved as `rough` units (§6.0); clean-up is offered, not forced.
- *(Note: the "different input modality per environment" / CodeMirror-NodeView pattern is for computational cells, which are out of MVP scope — reserved. The environment **abstraction** itself, §9.x, is needed now.)*

### 9.x Input environments (a platform-level system, not just frontend behavior)

The editor's context-sensitivity is modeled explicitly as **InputEnvironment**, not left as a pile of ad-hoc TipTap plugins. An environment is a named bundle of rules that a block (a theorem, a proof, a source-note) instantiates, and it spans layers: defined once in a shared **environment registry** (config in the core/shared layer), enforced by the editor during input, and consumed by the backend for projection and AI-context.

```
InputEnvironment {
  id
  allowed_blocks / allowed_inline_nodes
  autocomplete_providers      // which candidate sources fire here
  notation_scope              // which notation entries / conventions apply (§6)
  normalization_rules
  toolbar_actions
  validation_rules
  ai_actions                  // which §8 workflows are offered in this context
  projection_rules            // how this env maps into MathContent / export / AI context
}
```

Examples (MVP): a **Theorem** environment autocompletes prior definitions/theorems, supports hypothesis/conclusion structure, offers the "polish theorem statement" AI action; a **Proof** environment autocompletes assumptions and theorem refs, supports step/dependency links, offers "find hidden assumptions"; a **Source-note** environment autocompletes source/object refs and preserves the source anchor. **MVP scope guardrail:** environments are a *platform-internal* abstraction with a small fixed set (note, definition, theorem, proof, source-note). A *user-definable* environment editor is a §6 non-goal ("user-defined workflow editor"), explicitly out of scope — the abstraction is for internal structure, not a configuration surface.

### 9.y How structure gets set — the central authoring workflow

This is **the single most important workflow in the MVP**, and the whole content model (§6.0) exists to serve it. The governing constraint: **typing is never interrupted to classify.** Structure is never a *precondition* of writing — only ever something layered onto writing that already exists, or declared in the same keystrokes as the writing. There are three sources of structure, in descending order of how often they fire, and a strict priority among them:

**1. User-declared — deterministic, authoritative, primary.** The user assigns a unit's `type` with one gesture, and the dominant gesture is the one mathematicians already use: a **leading cue while typing**. Typing `Thm.`, `Def:`, `Q:`, `Idea:`, `Claim:` at the start of a line *makes* that unit that type — the way Markdown turns `#` into a heading, with no menu and no selection. Secondary gestures, for content already written: **select-then-mark** (highlight a sentence → "Intuition") and a **slash command** (`/conjecture`). All three set the *same one field* (`type`); the user never picks a shape or fills fields. A relational cue expands atomically: `Counterexample:` creates the unit *and* opens the `counterexample_to` target picker — still one act (§6.0b). `declared_by = user` here, and it is **authoritative**: nothing downstream silently overrides it. One subtlety matters for trust: the machinery that *recognizes* a leading cue is the same deterministic parser as source 2 — but **recognition is not authorship**. A cue is **user-declared-via-syntax** (`declared_by = user`, never `deterministic`); the parser is the messenger, the user is the author of the classification — which is what entitles cue-declared types to materialize (§ below) while parser-inferred *forms* never do.

**2. Deterministic inference — silent, instant, syntactic.** Anything with a *syntactic signature* is inferred by a deterministic program — no LLM, because this fires on the keystroke path and must be instant and predictable: paragraph/line boundaries → unit boundaries; `$$…$$` → a `math` unit (display) and `$…$` → an inline math element in prose — both wrapping a `MathExpression` whose **id is presentation-independent**, so toggling inline↔display is a placement change, never an identity change (§6.3a); an aligned `=`/`≤`/`⇒` chain → a `derivation`; `[[…]]` → a reference edge; `;NN` → notation; "Case 1: … Case 2: …" → a `case_split`. Crucially, **`content.kind` is always inferred here, never chosen** — the authored material's syntax fixes the form immediately (*shape-now*); the declared `type` may *inform* inference in ambiguous cases but never determines the kind (a theorem may be prose, a display expression, or a group of parts). `declared_by = deterministic`.

**The deterministic layer never sets a `type` (user decision).** Everything above sets *form, references, or notation* — punctuation heuristics are deliberately excluded from the MVP: a line ending in `?` is **just prose** until the user cues it (`Q:` / `Question.` / `/question` / select-then-mark) or accepts an LLM suggestion. So the rule is exact: **only explicit user cues create authoritative unit types**; heuristic type-guessing belongs to the suggestion beat (source 3), never the keystroke path. Since auto-materialization triggers on *declared* types (below), this also means a stray `?` can never mint a graph object — `declared_by = deterministic` marks form/reference declarations, not types.

**User-typed markup (Markdown-style), and where it lands.** The user writes with the ordinary affordances — directly, like Obsidian, by typing markup (or via toolbar/shortcut): `$…$`/`$$…$$` for math, `**bold**`, `*italics*`, `` `code` ``, `-`/`1.` lists, `#` headings, `> ` quotes, `[[links]]`, `;` notation. This is all the deterministic layer, and the only subtlety — which an implementer hits on day one — is that the *same keystrokes sort into three different bins in the model*:

- **Model constructs (durable)** — `$…$` creates an **inline math element inside prose**, `$$…$$` a **`math` unit** (display); both carry the *same* `MathExpression` structure with a presentation-independent id (§6.3a) — inline-vs-display is *placement*, not meaning, which is why this bin is named for the model, not for "semantics". `-`/`1.` create **list content** (`content.kind = list`; items as child rows). Real model constructs, not styling.
- **Inline presentational marks** — `**bold**`, `*italics*`, `#` headings, `` `code` ``, `>` quotes are *formatting inside a unit's prose content* (`prose.marks`), stored as lightweight inline marks in the specified content format (the one legitimate place editor-style "marks" live — *inside* prose, never as a unit-level concept). The core preserves them but treats them as opaque styling, not meaning. A heading is **not** a `type`: "heading" isn't a math-flow role like *theorem* or *motivation*; it's prose formatting. *(Reserved refinement: in long structured notes, headings may later be promoted to titled `group` units — real section semantics, an additive change since `group` already exists. For MVP they remain presentational.)*
- **References / notation** — `[[…]]` resolves to an edge (§6.1b), `;NN` to a notation entry (§6).

This is why the model holds up: **markup that is presentational rides inside prose (and may not survive a format change); model-level markup (`$$`, lists) and the unit's `type` are the durable layer** that export to LaTeX/Typst must preserve. The unifying UX point is that the leading-marker reflex is *one* muscle — `#` → heading (presentational) and `Thm.` → a `type` (semantic) feel identical to type, even though they land in different bins. So the user gets one fluid markup-driven editor; the model files each keystroke where it belongs. (`type` remains the orthogonal axis of §9.y-source-1 — you never get *intuition* or *theorem* from a markup character.)

**3. LLM-proposed — semantic, on a beat, never imposed.** Structure with *no* syntactic tell — "this paragraph is *motivation*", "this is the key *idea*", "these three lines are a *proof sketch*", "the hypotheses are X and Y, the conclusion is Z" — requires understanding, so it is the LLM's job (§8 workflow 4). Under three hard constraints from the trust model (§2.5/§3.9): it runs **on an explicit beat** (on demand, or at "promote this note" — *not* per keystroke, to avoid a "possessed editor"); it **proposes** (Review Queue / inline `[Accept] [Edit] [Ignore]`), never silently rewriting; and a proposal is **one-gesture** to accept or dismiss. *Decomposition is the deferred half* — `extracted_structure` (hypotheses/conclusion) is proposed here, after the fact (*decomposition-later*). An AI proposal is never a canonical unit: it lives in `review_items`; on acceptance the structure enters with `declared_by = user` and provenance recording the AI origin and derivation — **authority and origin are two facts in two homes**.

**The priority is strict:** user-declared > deterministic > LLM-suggested. The LLM never overrides a user's label; deterministic inference yields to an explicit user type. And the three degrade gracefully into each other — if the user doesn't cue it (1) and it has no syntactic tell (2), it sits as `rough` prose until the LLM offers something (3) or nobody ever bothers, **and that is a valid terminal state** (§2.2).

**Structure must be as easy to remove and change as to add** — otherwise people stop adding it. The affordances come in inverse pairs: a cue/slash sets a type, **one click clears it** (back to plain content, history kept in versions); re-typing a leading word changes the type; the LLM proposes, a dismiss rejects it for good. Splitting a unit splits it into stable-id children with defined propagation of type/annotations/provenance; merging is its inverse (§6.0a). This is what "progressive, local, reversible" means *in the hands*.

**What the user sees.** A normal flowing document — never "fields." Types render as **light affordances** (a gutter label, a subtle tint), not boxes: a theorem with tagged hypotheses still reads and edits as flowing text. Editing is **edit-in-place / WYSIWYG with progressive disclosure** — you see the rendered theorem; click a rendered expression and its LaTeX surface opens. Presentation and editing can't drift because they are two projections of the *same* units (§6.0) — there is no separate rendered copy.

**Fluid object identity, history in the log.** Because structure is reversible, the user **mutates objects freely** — a question companion to a theorem, a note that becomes three objects, a label removed. Prior states are **not** kept lingering in the workspace (that would violate the calm-desk principle, §5.11); they are recoverable from `object_versions` + provenance (§6.4). So §2.2 ("never lose effort") is met by the *log*, not by cluttering the live surface — the user stays in control of their material.

**Object boundaries do not leak into the default UI — and materialization is greedy, with staged maturity.** The model distinguishes units inside a flow from standalone objects joined by edges (§6.0b) — but that is the *system's* bookkeeping, and the §3.18 principle applies inward: **the UI is an adapter over the canonical model, including over object boundaries. The UI presents a continuous mathematical document; internal object boundaries may differ from visual boundaries, as long as editing remains smooth, predictable, and reversible.** The user writes "Theorem. … Proof. …" as one document and is never asked "promote this to an object?"

Underneath, the policy is **greedy capture, staged maturity** *(revising an earlier lazy-objectification position — lazy keeps the workspace tidy by leaving the graph empty exactly where the product's value lives: `[[ ]]` resolution, backlinks, search, and dedup all operate over objects, so a lazy theorem is undiscoverable)*. The governing principle:

> **User-declared formal knowledge units materialize by default. Discourse units remain local by default, but *any* unit can be materialized by explicit user action. AI may *suggest* materialization, but user acceptance is required. Graph visibility is controlled by status, type, and filters — not by preventing object creation.**

Three categories, with the user sovereign over all of them:

- **Auto-materialized on declaration.** Declaring `theorem` / `lemma` / `proposition` / `corollary` / `definition` / `conjecture` / `question` / `proof` / `example` creates a **draft object** immediately and silently (`source_excerpt` is an object by construction) — where *declaring* means an **explicit cue** (leading keyword, slash, select-then-mark), never a punctuation heuristic (user decision, source 2 above). `question` is deliberately included: in a learning platform, questions are knowledge artifacts, not mere discourse — the volume of small question nodes is a *filtering* problem, not an identity problem. The graph sees the object *now* — `[[ ]]` autocomplete, backlinks, search, dedup — and **maturity, not absence, controls noise**: the existing lifecycle (`draft → user_verified → trusted`, `deprecated`) is the filter, no new status machinery, with search/autocomplete ranking accepted above draft (and the future map UI, a §6 non-goal for MVP, filtering on the same axis). Because questions auto-materialize, **verify early that draft-question volume stays navigable** — `status` + user tags ("central", "return") are the MVP filter; a dedicated importance field stays reserved until evidence demands it.
- **Local by default, materializable on demand.** `motivation`/`intuition`/`idea`/`proof_idea`/`remark`/`warning`/`analogy`/`application`/`note` — and `open_issue`/`return_later`, which the return surface reads as units — stay units attached to what they sit beside. **But the user remains sovereign:** a profound intuition or a load-bearing idea can be elevated to a graph object with one action. (`application` stays local by default precisely because it is ambiguous between discourse and durable artifact — but it is a *strong* Add-to-graph candidate, typically materializing as an `example`/`note` object with an `application_of` edge — and a watch-item: if usage shows people expect *Application* to be graph-visible by default, the default moves on evidence, not principle. A counterexample materializes as an `example` object + `counterexample_to` edge.)
- **AI-suggested materialization.** The LLM may propose *"this question seems central — add it to the graph?"* (a §8 suggestion kind), but an AI never silently creates objects: a candidate is a `review_item`, not an object (§3.9), structurally outside the graph until accepted — no special status needed.

**The storage contract: product rule binding, mechanism prototyped.** The binding rule is — **a materialized object remains editable exactly where the user wrote it**: same flow, no visible boundary, no editing discontinuity. *How* ownership is stored is settled by an **early prototype of seamless inline object editing** (§13a slice 2), not finalized here. The prototype's pass bar is wider than typing: **copy/paste, undo/redo, export, backlinks, object version history, delete/dissolution, and tag propagation** must all behave — these are where hidden ownership problems surface (a local idea tagged "central" must keep its tag through materialization). Each is a pass/fail question: can a theorem declared inside a note become graph-backed with zero change to the visual flow? can the declaration be undone cleanly? can undo/redo cross a materialized boundary? can the user copy that theorem to another note **without accidentally duplicating identity** (copy-vs-transclude must be a deliberate choice)? does the object's version history stay coherent when all edits arrive via the host note? can export reconstruct the visual flow *and* export the object? does dissolution explain its references? **If this prototype fails, greedy capture itself gets revisited — so it runs as the first deliverable of slice 2, before anything depends on it.** The prototype should also test, *as an open question*, a subtle optional "graph-backed" affordance on embedded materialized objects (a collapse/expand or faint badge): does it aid orientation or harm calm editing? The default remains boundary-invisible either way. The candidates, with the evaluation criteria named: **re-homing** the declared unit subtree into the new object *(the lean: one content model, the object owns its own version history, exports cleanly — but it is a heavy invariant: silent content movement behind an invisible embed)* versus a **stable origin reference** *(lighter at declaration, but introduces a by-reference content mode and muddies whose `object_versions` hold the content)*. The product contract binds either way.

- **Reversibility — dissolution as a reviewable operation.** Clearing the type on a materialized unit dissolves the draft object back into local units **if nothing depends on its identity**. If inbound links, annotations, or review items reference it, dissolution becomes a **reviewable operation, not a silent failure**: the UI shows *what* references it ("referenced in 3 places: …") and offers deprecate / keep / detach. Materialization and dissolution are both recorded in provenance.

**Materialization includes the obvious edge.** "Proof." immediately following a theorem-like unit in the same flow materializes the proof object **and deterministically adds its `proves` edge to that theorem** — adjacency is a syntactic cue, owned by the deterministic layer (source 2) under the same priority rules (user's explicit cue — "Proof of [[X]]." — is authoritative; the deterministic edge is detachable). The rule, narrowly: a proof unit immediately following **exactly one** unambiguous theorem-like unit (`theorem` / `lemma` / `proposition` / `corollary` / `claim`) in the same local flow → deterministic edge; any ambiguity → a *review suggestion*, never a silent guess; a proof following a **`conjecture`** also routes to review — proving a conjecture is a notable event (it usually wants a re-type to theorem), worth a beat rather than a silent edge. *(Reserved nicety: re-typing a conjecture to a theorem can prompt revisiting nearby proofs and pending `proves` suggestions.)* And the cue governs **creation only**: once created, the edge is ordinary canonical state — if the user later moves the proof elsewhere, the system **never silently deletes** the `proves` edge; it persists until the user removes it, or is marked **stale** / flagged for review when its structural basis has vanished (the same staleness machinery as everywhere else). An auto-materialized proof must not enter the graph missing its most important edge — and must not lose it to a reordering.

**Edge-driven materialization (closes a gap the v15 rule opened):** graph edges target objects only (§6.1b) — so when an edge is created at a *local* typed unit, that unit **materializes at edge time**: the edge is the first action needing identity, and this is the general principle behind every non-declaration path into the graph. **The trigger is narrow:** only **canonical** edges — deliberate user edges or deterministic relation edges — that require object identity materialize anything. Content-derived markers never do (structurally they *cannot* target local units: `[[ ]]` and occurrences resolve to objects/notation/sources or stay unresolved, §6.1b), and AI-*suggested* edges materialize only at acceptance — acceptance is what makes them canonical. Concretely: a deterministic `proves` arriving at a local `claim` (which deliberately does *not* auto-materialize on declaration) materializes the claim then — justified by the two explicit acts that preceded it (`Claim:` then `Proof.`), recorded in provenance, dissolvable as usual. **Claim's lifecycle, as product reasoning:** `claim` is local by default because many claims are *proof-internal*; it earns identity when proved, reused, edge-targeted, or explicitly added to the graph — proof-internal claims should not all become top-level graph objects, but a claim with a proof deserves a node. *Greedy capture covers declaration time; edge-driven materialization covers everything after.*

**Worked examples (canonical):**
- *Note → theorem.* A note contains "Thm. Every compact metric space is complete." Declaring `Thm.` materializes a draft theorem object; the note still shows and edits the theorem inline (the storage contract); `[[ ]]` finds it immediately; `unit.type = theorem` and the new `object.type = theorem` are different layers (§6.0b).
- *Theorem + proof.* "Proof." on the next line materializes a proof object **with** `proves → that theorem` (adjacency rule above) — graph-complete from the first keystrokes.
- *Dissolution with inbound references.* Un-typing a materialized theorem that two notes link to neither silently fails nor silently dissolves — it opens the reviewable dissolution flow: shows the two references, offers deprecate / keep / detach.

Natural actions — *Add another proof · Reuse this proof · Link this proof to another theorem · Show dependencies · Extract as a separate note · **Add to graph** · **Track this** · **Make reusable*** — *compile to* the canonical operation `materialize_object` + edges (§6.0a). **The operation name is core vocabulary only:** the UI never says "materialize" or "promote" — it says *Add to graph* or *Track this*. (The same adapter rule as everywhere else: internal vocabulary never leaks into the surface.)

**Math — owned `mathmeander` surface, rendered via KaTeX/MathML; meaning via refs.** Synchronous, fast, sufficient for MVP rendering and annotation. An `Expression` (§6.0/§6.3a) holds a **surface** (our names-canonical grammar, rendered by transpiling to KaTeX/MathML) *plus* an optional **meaning** where the user accepted notation/object resolution — so a surface is canonical as renderable *text*, never as *meaning*. Input ergonomics and the keying model are §9.z. *Reserved:* a parsed expression tree (MathML via MathJax/Temml) for subexpression hit-testing, when equation-subexpression anchoring (§7) arrives.

**PDF — PDF.js as the substrate.** PDF.js is the substrate; **react-pdf is used only if it does not obstruct** the control the anchor/overlay engine needs — text-layer spans, viewport transforms, selection rects, scroll/zoom sync, overlay coordinate systems, page lifecycle, render timing. Because that engine is too important to hide behind a wrapper that fights it, the plan is to **prototype both** (react-pdf wrapper vs. direct PDF.js viewer) early and be ready to drop to direct PDF.js. Capabilities: text/region selection, highlight, **multi-selector anchors** (§6.2), reading-position memory, margin notes, and an "extract candidate" action routing a version-bound typed candidate to the **Review Queue**. The PDF is just another addressable place (§3.6), not a separate app.

**Annotations — overlay + decorations.** Free-floating primitives (highlight, margin note, callout, ellipse, curly brace, arrow, underline — §3.14) render on an **SVG overlay** whose geometry is computed from **anchor + placement** (§6.2) and recomputed on edit/scroll/zoom (ProseMirror transactions + ResizeObserver). In-flow marks (highlight/underline) ride as **ProseMirror decorations** / PDF text-layer overlays. The shared engine is the **anchor resolver** (anchor + placement + current layout → geometry), feeding both. **The user can move marks:** dragging a margin note (down, below the equation, to the other margin, off to the side as a callout) updates its stored *relative placement* and re-derives geometry — so it persists and survives reflow without ever storing pixels; **re-attaching** to a different target is a separate, deliberate gesture that changes the *anchor*, so casual dragging never silently changes what a note is about. **Graceful degradation:** when a mutable target changed and an anchor can't fully resolve, the annotation is surfaced as **orphaned** in the Review Queue (`orphaned_annotation`) — content and last-known placement preserved, attachment flagged honestly — never silently misplaced. PDF/immutable targets never reach this path. (MVP anchors are block/span/region; subexpression is reserved.)

**Diagrams — reserved, not in the MVP (§14).** No SVG renderer, direct-manipulation editor, NL diagram authoring, or TikZ codegen is built for the MVP. The diagram object type and a structured diagram model are *reserved* in the canonical model so adding them later is additive (the "structured data, not pixels" thesis, §3.13, is preserved for when it lands).

**Home — calm desk (§5.11).** Continue-where-you-left-off, active trails, Inbox, Review Queue, return-later items, recent sources, recent notes. Not a graph dashboard.

### 9.z Math input ergonomics and the universal-`Tab` keying model

The owned surface (§6.3a) is only as good as how it is typed. Three commitments, all frontend adapters over the canonical surface — the answer to "is this like Obsidian, LaTeX, or Typst?": it *feels* like writing rough notes in Obsidian, with math that **types** like Typst and **exports** like LaTeX, while cross-references and numbering (§6.3b) are handled for you.

**Recognition over recall (the load-bearing mechanic).** Calligraphic/fraktur/blackboard and the symbol zoo are entered by *recognition*, not by recalling backslash commands: type `F` and a live, filterable popup offers ℱ / 𝔉 / 𝔽 with a recents/favorites row; one keystroke commits. Three interchangeable routes land the same canonical token — the recognition popup; function calls `cal(F)` / `frak(g)` / `bb(N)`; and `;`-snippets / the notation registry when the symbol carries *meaning* (which insert a `NotationRef` carrying `notation_id`, distinct from a display-only glyph, §6). Pasting a Unicode glyph also works and normalizes to the name. Recognition is syntax-independent — it never demands a private mnemonic alphabet.

**Fractions and structure, predictably.** `/` is **literal-by-default** with an explicit build-up gesture — `G/H`, `R/I`, `X/~`, `dy/dx` never silently become a built-up fraction (specified as a formal grammar production, not a fragile "suppress near group symbols" heuristic). Scripts are `x^2` / `x_(i+1)`; structured templates (`sum`, `mat`, `cases`, `sqrt`) come from an in-math `/`-palette and drop a tab-stop ring (a transient editor affordance with no model home). Live rendering softens errors during incremental typing — rough math is never punished (§5.1).

**Polyglot input, one canonical surface.** The user may type in whatever dialect they know — `mathmeander`, LaTeX, even pasted Unicode — detected per-expression (or by the InputEnvironment, §9.x) and normalized to the canonical surface **at input/paste time, before any anchor exists** (the keystone invariant, §6.3a), recording `input_syntax`. Copy-out is the dual clipboard (§6.3a). Reverse projection (re-edit in an arbitrary dialect) is *not* MVP — it is lossy and would re-import the editor-as-truth risk; the dual clipboard + `original_input` cover the need.

**The universal `Tab` key (Emacs-style), browser-safe.** `Tab` is the single context-sensitive "do the smart thing" key inside the editor surface (ProseMirror/TipTap can `preventDefault` and rebind it while focused; CodeMirror/Notion do the same). The conflict is **not** technical — it is **accessibility / focus traversal**, `Tab`'s default browser job. So `Tab` is captured *only while the editor or a widget holds focus and there is a meaningful action*, via a deterministic **precedence ladder**: accept the active completion popup → expand the snippet/token before the cursor (build up a fraction, `cal`→ℱ) → advance to the next template tab-stop → otherwise fall through to normal focus traversal (`Shift-Tab` reverses). When the ladder has nothing to do, `Tab` must move focus normally, and an explicit escape (Esc to blur; a "Tab moves focus" toggle) guarantees keyboard/AT users are never trapped — the one hard browser-first constraint. One key, one ladder; the same ladder drives the review overlay's Verb-Lens tab-ring (§9.w). *(Exact order + the AT fallback are a spec item.)*

### 9.w The structuring review/edit loop (rough → LLM proposes → you edit the proposal)

Authoring is **rough-by-default** (§9.y). On an explicit beat — on demand, or at "promote this note" — the LLM proposes structure (a `type`, a hypotheses/conclusion decomposition, links) as a version-bound typed candidate in `review_items` (§8, §3.9); it never rewrites silently and acceptance is explicit (§2.5). The hard requirement of the `[Edit]` arm of `[Accept] [Edit] [Ignore]`: the user must be able to **edit the proposal directly, by interacting with its elements** — not only by typing prose at it.

**The overlay + Verb Lens.** The candidate renders *in place* as the §9.y light-affordance view (a gutter type chip, soft-tinted hypothesis/conclusion spans each with a reject tab, the computed label/number §6.3b, per-symbol variable pills, proof-step rows). A single **Verb Lens** docks to the focused element (like the recognition popup, §9.z) and dismisses on blur/Esc — so the surface can never accrete into a **form** and never becomes a **chat box** (the two anti-goals of §9.y). It offers, badged so the cost is known *before* acting:

- **Mechanical (no model turn)** — un-mark / re-mark a hypothesis, change the type (via the recognition popup), swap a symbol to a *named* glyph, rename a label, token-snap a span, accept/reject an edge. A direct edit to the candidate sub-part.
- **Parameterized-semantic (a scoped model turn, zero typing)** — pre-baked `RevisionIntent` verbs carrying a fixed token: `Weaken` / `Strengthen` / `StateMoreGenerally` / `StateMoreSpecifically` on a hypothesis; `UseDifferentKindOfVariable` on a symbol; `SplitStep` / `ExpandStep` / `JustifyStep` on a step; `ReclassifyAs(type)` on the chip. The intent + the anchored element *is* the instruction (deixis, no prose); steppers commit-on-release / debounce.
- **Describe… (an element-anchored free instruction)** — a free-text field docked to the focused element, carrying its anchor automatically, so "a finer notion of variable" or "weaker, drop continuity" is always *about* something pointed at. This is the grounded fast path for the long tail, **not a cage**: arbitrary, complex, or cross-cutting intents belong to the global assistant (below).

Routing doctrine: *mechanical* = a deterministic result the user could produce by hand → an instant candidate edit; *semantic* = needs judgement → a scoped model turn that returns a **proposal**. ("A different *letter* you name" is mechanical; "a different *kind* of variable" is semantic.)

**Scoped revision.** A semantic verb fires `revise_candidate_part` (§6.0a) — glue-tier (the model call lives in glue per §8; the core only validates the return). It carries the anchored sub-part's *current* value (post any prior user corrections), the surrounding candidate read-only, and the part's base binding; the instruction text lives only in the `ai_context_snapshot` (AI input, never user content). It returns a typed sub-part replacement that **cannot touch siblings** (a wanted sibling change surfaces as a separate suggestion). The result lands as a soft before/after diff with `[Keep] [Revert] [Tweak-again]`; only **Keep** promotes it into the working candidate. The core **refuses** any return that drops or re-mints an `expression_id`.

**Trust spine.** Nothing canonical is written until one explicit accept. Pre-accept edits — mechanical *and* semantic — mutate only `review_items.candidate`; per-sub-part lineage is an append-only `edit_log` inside the candidate (§6 schema). `status` flips to `corrected`. Real `provenance` + `provenance_derivations` are minted only at `accept_ai_candidate`, deriving the mixed lineage from the `edit_log` — every materialized fact carries `declared_by = user` + `provenance{origin = ai, created_by = accepting user, review_item_id}` (authority ≠ origin; `ai` stays absent from `declared_by`, §6.1). **Accept blocks** while any sub-part is pending-confirm (a model-revised part not yet Kept/Reverted). Version binding holds at two scales — a per-sub-part `base_object_revision_at_edit`, the row's whole-candidate `base_refs`, and a candidate-local `working_revision` token — and on a stale base or a re-generation a per-sub-part `correspondence_key` re-routes prior corrections through review, **never blind-reapplied** (§6.4).

**The global context-aware assistant (the open-ended surface).** Beyond this in-context overlay there is a **global, fully context-aware assistant** that can take *arbitrary* actions across the platform — cross-cutting edits, multi-element asks, complex restructuring, anything the verb lanes do not cover. The overlay is the fast, grounded path; the assistant is the powerful, open-ended one. They interoperate: the assistant is **element-aware** (deixis works there too — it can reference the focused element / current selection), and `Describe…` can hand off to it. The same constraint binds both surfaces (and the agent): the trust model (§2.5/§3.9) holds — anything that creates or mutates canonical content flows through proposal → explicit acceptance, or is at minimum attributed, reversible, and provenance-stamped. An agent that "can do anything" still cannot make AI output *silently* become user content. The autonomy boundary (what the assistant may auto-apply vs. must propose) is an open product decision; the full assistant is a larger effort than the authoring-input flow, and this section only fixes the contract it must honor.

**Build order:** specify the full loop now, ship a minimal version first — `[Accept]` / `[Reject]` plus the mechanical verbs — with the scoped-revision channel and the parameterized verbs following, all behind slice 2's proven editing contract (§13a).

---

## 10. Export, import, and migration

This layer *proves* the architecture: if the canonical model is clean, the *projections* are pure functions over it (§3.17 — "not a late feature"). But a `.mathpack` is a zip with assets, which is I/O — so the responsibility splits, and the purity claim is scoped honestly:

- **Core (pure):** build/serialize the export **manifest** and the canonical-graph JSON; **validate** an import manifest; **migrate** imported objects; compute **expected asset references** (content hashes); the deterministic **readable projections** (`MathContent` → Markdown/HTML, and reserved Typst/LaTeX). These are pure functions and are property-tested.
- **Glue (I/O):** zip/unzip; read/write/stream **assets** to and from R2; verify content hashes against the manifest's expected references; stream large PDFs; HTTP response streaming. None of this is in the core.

So `.mathpack` is *assembled* by the glue (zip + asset streaming) around a *deterministic manifest + serialization* produced by the core.

- **`.mathpack` contents** = a `manifest.json` + the canonical-graph JSON + an `assets/` folder (PDFs, images, content-hashed for dedup). A minimal manifest, fixed now so export/import property tests are concrete (fields may evolve, the integrity story may not):

```json
{
  "format": "mathpack",
  "format_version": 1,
  "schema_version": 1,
  "created_at": "…",
  "space": { "id": "…" },
  "counts": { "objects": 0, "links": 0, "sources": 0, "assets": 0 },
  "assets": [ { "key": "sha256:…", "media_type": "application/pdf", "bytes": 0 } ],
  "checksums": { "graph_json": "sha256:…" }
}
```
  The graph JSON carries objects, edges/references, aliases, annotations, trails, **notation entries + conventions**, provenance, and per-object schema versions; Inbox/Review states where appropriate. (Diagrams: reserved, §14.) Assets are referenced by content hash; the manifest's `checksums` + `assets` give a clear integrity/migration story.
- **Readable export (MVP):** `MathContent` → **Markdown** and **HTML**. *Reserved:* Typst (primary future PDF path), emitted LaTeX, BibTeX/RIS, and **Pandoc** strictly as a conversion bridge — added as more projections, never as the canonical backend.
- **Tests (mandatory, §5.10).** Round-trip `serialize → deserialize` and `export → import` as **proptest** invariants in the core (over the pure manifest/serialization), plus migration tests against old fixtures, plus an integration test that exercises the glue's zip+asset round-trip. These guard the §2.2 "no lost user effort" promise — not optional polish.

---

## 11. (intentionally folded into §5–§10)

---

## 12. Sync, sessions, and offline posture

- **Server-authoritative with local read cache.** The server is the single source of truth; the client caches for speed and read-resilience.
- **Single active session per user (MVP).** This eliminates *multi-device divergence* — a cleaner simplification than a conflict policy, and it avoids the §2.2-violating "last-write-wins silently drops an edit" trap. Enforced at the session layer (§7), absent from the data model. **It does not, however, eliminate ordinary concurrency:** two tabs, stale client state, racing requests, and asynchronous jobs (AI, dedup, export, review approvals against older state) are all still concurrent writers. That residual concurrency is handled by **optimistic concurrency control (§6.4)** — `revision` + `expected_revision` on writes, 409 on mismatch, and version-bound AI candidates. (Correcting an earlier overstatement: single-session removes the *merge* problem, not the *concurrency* problem.)
- **Offline:** the MVP is an **online web app**; offline editing is out of scope (and native apps are a §6 non-goal). The pieces that would make offline cheap later — client-mintable IDs, append-friendly writes, the core compiling to WASM — are reserved, so offline/multi-device is additive.

**Reserved (not built):** CRDT convergence (ProseMirror→Yjs is the path), a sync-relay service, and offline-create. The rule to hold so these stay additive: never bake "the server is the only writer" or "there is exactly one client" into the canonical model.

**Stated precisely, to prevent confusion:** the MVP is **online-first and server-authoritative**. It is **portability-first / export-first** — data sovereignty comes via `.mathpack`, client-mintable IDs, and a future WASM-core path — but it is **not local-first at runtime**. Client-mintable IDs + "WASM later" *enable* local-first; they do not *make the MVP* local-first. Full local-first/offline editing is reserved by design, not delivered.

---

## 13. Hard builds and honest risk

This is a **large MVP** — worth stating plainly for planning. The genuinely hard builds, in rough order of design risk:

1. **The editor + environment system** — ProseMirror editing a projection of `MathContent`, the **InputEnvironment** abstraction (§9.x) driving scope-aware autocomplete, snippet input rules resolving against the **notation registry** (§6), canonical operations on save, and annotation-anchor marks. The framework provides the engines; the projection, environment/notation/context-routing logic, and popup UI are real work.
2. **PDF + the anchor layer** — multi-selector anchors with graceful degradation are real engineering; raw PDF offsets are fragile, hence the multi-strategy model. (Prototype react-pdf vs. direct PDF.js early — §9.)
3. **The annotation overlay engine** — the anchor resolver + SVG overlay + decorations, shared between editor and PDF. This is where the "not just screen coordinates" promise (§2.1) is kept or quietly broken; get the resolver right early.
4. **The AI tier** — thin in infra, heavy in behavior (§8); **three workflows first**, each a context-recipe/template/schema triple routing version-bound candidates through the Review Queue with provenance, then expand toward the eleven.

*(Diagrams were a fifth hard build in earlier drafts; cutting them from the MVP — §14 — removes a whole rendering/codegen workstream and is a deliberate scope reduction.)*

Builds 2 and 3 share the anchor model — which is why pinning the anchor model down early matters more than any single library choice. The integrity core should be the **first thing to stabilize** (it's the bet, and the part most worth crystallizing); the workflows and UI churn around it.

### 13a. Vertical-slice build sequence

The MVP is large, so build it as **thin vertical slices** that each prove part of the core loop end-to-end, rather than completing layers horizontally. Recommended order:

1. **Canonical object core** — `objects` + `content_units` + edges + detail + `provenance` + `object_versions` + `revision`; the first `MathContent` spec/serializer + unit-level canonical operations; the **owned `mathmeander` surface grammar + parser/serializer** (`parse_status` ours) with the `mathmeander → KaTeX/MathML` render transpile and LaTeX import/export adapters, plus `input_syntax`; the `handles` table and the numbering/display-name projection scaffolding (§6.3b); the `.mathpack` manifest + serialization; migration fixtures. No fancy editor yet. *(Crystallize the integrity core — and pin the surface grammar's precedence/fraction rule — here.)*
2. **Editor object loop + the authoring workflow (§9.y)** — create note/definition/theorem/example; rough input preserved as `rough` units; **`type`-tagging via leading cues / slash / select-then-mark**, deterministic shape inference, **greedy materialization of object-worthy types (+ reviewable dissolution)**, **seamless inline editing of materialized objects (the re-homing vs origin-reference decision is made here, §9.y)**, **the inline↔display toggle preserving expression identity (§6.3a)**, and the split/merge propagation rules (prototype and try to break these early — this is the make-or-break surface; the ownership prototype must pass copy/paste, undo/redo, export, backlinks, version history, dissolution, and **chip survival across copy + the universal-`Tab` expansion undo**, §9.y); the **math input ergonomics** (§9.z — recognition popup, `cal()`/`frak()`/`bb()` routes, literal-by-default fractions + tab-stops, the universal-`Tab` ladder, paste-time LaTeX import, dual clipboard) over KaTeX/MathML rendering; the **zero-manual-labels cross-reference UX** (`[[`/Cmd-K + reference-by-pointing + computed numbering + optional `handles`/`aliases` names, §6.3b); references/occurrences-as-edges; snippet/notation MVP; status; an export/import round-trip that passes. *(LLM structure suggestions and the review/edit loop come in slice 5.)* *Heavy AI and PDF-annotation work deliberately wait behind this slice's ownership gate — nothing feature-rich gets built on an unproven editing contract.*
3. **Source grounding** — PDF upload/view; text selection; source-excerpt object; PDF anchor; extract-candidate → Review Queue; approve a candidate into an object.
4. **Annotation MVP** — text highlight; PDF highlight; margin note; `UnitRef` anchors ("this hypothesis"); ellipse/arrow *only once the anchor model holds*; orphaned-annotation review.
5. **AI workflows** — extract from selection; polish a rough object; suggest links/duplicates; **suggest structure** (§9.y). The **review/edit loop (§9.w)** lands here: ship `[Accept]`/`[Reject]` + mechanical inline edits first, then the scoped-revision multimodal channel (`edit_candidate` / `revise_candidate_part` / `RevisionIntent` / `AnchorTarget` / the Verb Lens). Then expand toward the broader set. *(The global context-aware assistant is a larger, later effort; §9.w fixes the contract it must honor.)*

This keeps the **read/write → object → source-linked → annotated → reviewed → exported** loop validated at every step while holding the largest risks (the `MathContent` model, the anchor model, AI iteration) where they can be managed. *(Diagrams are not in this sequence — reserved, §14.)*

---

## 14. Reserved futures (doors held open at near-zero cost)

Each is an *extension, not a rewrite* (§7), because of a specific cheap reservation made now:

- **Computational pillar (§3.16):** object families + relationship types reserved as a *namespace* (the object families added to the core enum only when their minimal schema is known; relationship-type names reserved now); *everything else* — generator registry, client GPU runtime (WebGPU/WebGL), Lenia-class systems — is future. (Such compute is a **client GPU** concern, orthogonal to the backend language; it never argued for or against Rust here.)
- **Diagrams:** a `diagram` object type + a structured diagram model are reserved (no renderer, editor, NL authoring, or TikZ codegen in the MVP). Adding them is additive — a new object type with detail + projections — touching neither `MathContent` nor the graph. (Cut from the MVP to shrink scope; the "structured data, not pixels" thesis, §3.13, is preserved for when it lands.)
- **Multi-device + sync:** client-mintable UUIDv7 + append-friendly writes + core-compiles-to-WASM; CRDT/Yjs + sync relay are future.
- **Native apps:** **desktop via Tauri** is the likely first native shell and is relatively plausible (it wraps the same web frontend). **Mobile/tablet is reserved but is *not* cheap** — even as a Capacitor/RN WebView shell it likely needs substantial surface *redesign*, because ProseMirror mobile behavior, PDF annotation gestures, pen/stylus support, the loss of hover/keyboard shortcuts, and tight layout constraints all make the editor/PDF/annotation interactions a real product surface, not a reflow. The WASM core makes client-side *integrity* portable; it does nothing for the *interaction* redesign. (True per-platform native UI remains explicitly out — it would mean rebuilding those surfaces per platform.)
- **Subexpression & diagram-element anchoring:** the `StructuralPath`/composite selector variants + a parsed expression tree; the MathML rendering upgrade is future.
- **BYOK / BYO-endpoint:** the `LlmProvider` interface + encrypted-secret handling + open-ended provenance `model` field.
- **Richer export (Typst/LaTeX/PDF) + Pandoc bridge:** added `MathContent` projections over the same canonical model.
- **Collaboration:** the ProseMirror→Yjs path.

The standing test for all of these: *could this be added behind an existing boundary without touching the canonical model, the provenance schema, or unrelated code?* If yes, the reservation is correct.

---

## 15. Infrastructure & ops

- **Database:** managed Postgres (Neon — `pgvector` support + branch-per-migration; Supabase if bundled auth/storage is wanted).
- **Assets:** Cloudflare R2 (S3-compatible), content-hashed; zero egress for repeatedly served PDFs.
- **Hosting:** the **Node server (with the Rust core as a native napi-rs addon)** as a long-running **container** (Fly.io / Railway). A container (not serverless) matters because export will later shell out to Typst/Pandoc, and binary deps (the Rust addon, CLI tools) + cold starts make serverless a trap for this workload.
- **Auth:** hosted IdP, JWT verified in-process.
- **Observability:** structured logs + Sentry.

---

## 16. Testing strategy

- **Core (Rust):** unit tests + **proptest** invariants — the serialize/deserialize round-trip, the export/import round-trip, and migration totality. These are the heart of the §2.2 guarantee.
- **Migration suite:** old fixtures migrated forward, asserting non-destructiveness and tri-state preservation.
- **Glue/API:** integration tests against a real Postgres.
- **Frontend:** **Playwright** e2e on the editor, PDF, and annotation flows (the surfaces most likely to regress subtly).

---

## 17. Decided: TypeScript glue/AI tier + Rust core (via napi-rs)

The earlier spike question is **resolved**: the **glue + AI tier is TypeScript (Node)**, the **integrity core stays Rust**, and the two meet at an **in-process napi-rs FFI**. The decision is driven by the AI tier being heavy in *behavior* (§8) — the mature TS LLM/streaming/eval ecosystem and a single language shared with the frontend outweigh the cost of the FFI seam.

**The accepted tradeoff, stated plainly:**
- **Gained:** the TS LLM ecosystem (streaming-to-React, structured-output libraries, richer eval tooling) and faster iteration on experimental AI workflows; one language across glue and frontend; easy type-sharing into the frontend.
- **Paid:** a **napi-rs FFI boundary** at the core edge (a serialization boundary on validate/migrate/serialize/apply-operation calls — acceptable, since these are not hot-path) and a **two-toolchain build** (Rust core + TS). This is the same "load-bearing, slow-changing boundary" judged worthwhile earlier: the core is the part that stabilizes and is touched least, so the FFI cost is bounded while the AI-velocity benefit is ongoing.

**What this fixes across the stack:** jobs = pg-boss/BullMQ; auth = hosted IdP incl. Auth.js; type-sharing = the core's versioned schema artifact → ts-rs/specta + zod; AI = TS SDKs with SSE streaming; DB access = a TS query layer with the Rust core for pure transforms. Context assembly stays unified with the model call (both in TS), so the seam discipline holds.

**Unchanged regardless:** the Rust core, the `MathContent` model, the explicit schema, the frontend, the export/import split, and the reserved futures. The core boundary is exactly what made this decision cheap to take and cheap to revisit.

---

## 18. Current assumptions

The document's load-bearing commitments, stated once — correct any that are wrong.

1. **One canonical model.** ProseMirror, KaTeX, LaTeX, Typst, HTML, and the LLM are adapters (§3.18). The Rust core owns types, validation, total non-destructive migration, and canonical operations; TypeScript glue owns product and AI orchestration; client/server schemas are generated from the core (§7, §17).
2. **One user-facing structural axis: `unit.type`** (math-flow role/category). `UnitContent.kind` is the authored form — inferred, never chosen, authoritative inside `content`; any SQL `content_kind` column is a derived projection. **No type↔kind admissibility**: the core rejects impossible structural states only.
3. **Only explicit user cues create authoritative types** (user decision): leading keyword, slash, select-then-mark — *recognized* by the deterministic parser but **user-declared-via-syntax** (`declared_by = user`). The deterministic layer sets form, references, and notation, never `type`; heuristics live in the suggestion beat.
4. **Materialization is greedy + edge-driven + sovereign.** User-declared object-worthy types materialize draft objects immediately; any unit is user-materializable; **edges target objects only, so an edge at a local typed unit materializes it**; AI only proposes (Review Queue), and acceptance enters as user authority with AI provenance.
5. **The binding product contract:** a materialized object remains editable exactly where written. The storage mechanism (re-homing vs origin reference) is **prototype-gated** — first deliverable of slice 2, against the §9.y pass/fail matrix.
6. **Maturity, ranking, and tags control graph noise — not absence** (questions auto-materialize; §6.3b ranking defaults do the filtering work).
7. **`MathExpression` identity is presentation-independent.** Ids are unique workspace-wide; display mode is derived from placement; the toggle composes a placement operation with ordinary split/merge; **copying mints fresh expression ids** (paste-as-reference = transclusion); the expression→unit index is an MVP projection.
8. **The typed knowledge graph is object-only** (a validated invariant). Content-derived references may resolve to notation entries or sources; *passage* references flow through `source_excerpt` objects; unresolved references carry `unresolved_text` on the edge.
9. **Annotations:** targets are rows with structural roles (main | from | to | member) and per-target anchors; **relation semantics live only in `links`** (`backing_link_id`); primitives describe drawing and reference target rows. *Marks are cheap; excerpts are knowledge.*
10. **One fact, one home.** Every projection — `content_kind`, `in_expression`, display mode, search documents — is derived, never independently written.
11. **Provenance is typed and auditable.** Origin ≠ authority; acceptance is explicit (`review_item_id`); derivation chains are FK-checked rows.
12. **`extracted_structure` is candidate-only**: version-bound envelope, a named registry of kinds with acceptance operations; nothing affecting graph, search, rendering, or trust lives only there.
13. **Online-first, server-authoritative, optimistic concurrency** (`revision` + 409); AI candidates are version-bound (§6.4).
14. **Export is a complete `.mathpack`** (manifest + objects + units + edges + assets); projections may emit derived fields for self-description.
15. **We own the math surface.** `MathExpression.surface_text` is our names-canonical `mathmeander` grammar (atoms as ASCII names, 2D structure as linear operators); LaTeX/Typst are import/export adapters and KaTeX/MathML a render adapter; `parse_status` is defined by our parser; `original_input` is preserved verbatim; normalization runs only before any anchor exists (the keystone invariant) or through an explicit span-remap op (§6.3a). Input is recognition-first and dialect-agnostic, with a universal-`Tab` ladder (§9.z).
16. **Labels are human-readable and user-nameable.** A reference binds to a stable id (never shown); the display label is a number computed on demand by the numbering projection, or an optional user name — `aliases` for objects, `handles` for a unit/expression — with no `\label`/`\ref` bookkeeping (generated only at the export boundary) (§6.3b).
17. **The AI `[Edit]` arm is element-anchored and multimodal, trust-spine-bound.** Mechanical edits apply directly to the candidate; semantic edits are a scoped, anchored `revise_candidate_part`; nothing canonical is written until an explicit `accept_ai_candidate` (declared_by = user + AI provenance; version-bound). A **global context-aware assistant** is the open-ended surface and is bound by the same trust model — an agent that "can do anything" still cannot make AI output silently canonical (§9.w, §2.5/§3.9).
