# Higher Mathematics Knowledge Platform

## 1. Product Vision

We want to build a platform for serious learners of pure mathematics: advanced undergraduates, graduate students, researchers-in-training, and independent learners who are reading difficult material and building their own mathematical worldview.

The platform is not primarily an automated theorem prover, course platform, general CAS, or discovery engine. It is a living mathematical workspace where users can read, write, annotate, connect, refine, preserve, and eventually computationally explore mathematical knowledge.

The core idea:

> A personal mathematical knowledge space where definitions, theorems, examples, proofs, diagrams, sources, questions, trails, and eventually computational explorations are first-class interconnected objects, with AI acting as a careful assistant rather than an authority.

The platform should respect informal mathematical thought. Users should be able to capture the beauty, intuition, roughness, and evolution of proofs without being forced into formal proof systems or rigid textbook structures.

---

## 2. Guiding Principles

### 2.1 Narrow but Excellent MVP

MVP does not mean shallow. It means narrow but structurally honest.

When we implement a feature, we should avoid shortcuts that would make future growth difficult. The first version can expose only a small slice, but the underlying model should anticipate the full direction.

Examples:

- A theorem should not be stored as just decorated text.
- A diagram should not be stored only as a generated image.
- A link should not be just a markdown URL.
- An annotation should not be only screen coordinates.
- A trail should not be merely an activity log.
- A source excerpt should not be just copied text without provenance.
- AI output should not silently become user-authored knowledge.
- Export should not be a lossy afterthought.
- Future computational explorations should not be bolted on as iframes.

### 2.2 User Effort Must Be Preserved

If a user inputs something into the platform, they should not have to redo that work because the platform changes later.

This requires:

- stable object IDs
- schema versioning
- migration support
- raw + structured storage
- provenance tracking
- lossless export/import
- preservation of unknown fields where possible
- lightweight version history
- non-destructive migrations

The realistic promise is:

> User-authored and user-accepted material should remain preserved, inspectable, exportable, and migratable across future versions.

### 2.3 User-Owned Knowledge Comes First

The user’s own notes, definitions, conventions, notation, trails, diagrams, experiments, and accepted objects are authoritative inside their space.

AI and imported sources can suggest, compare, extract, or warn, but they should not overwrite the user’s mathematical world without approval.

### 2.4 Structure Should Crystallize Gradually

The user should be able to write roughly, wander through sources, and capture fragments without classifying everything immediately.

The platform should support:

- rough capture now
- optional structuring later
- AI-assisted review
- manual editing at every stage

### 2.5 AI Should Accelerate Crystallization, Not Create Slop

AI should help users refine, compare, extract, and inspect mathematical content. It should not flood the space with plausible but untrusted prose.

AI-generated content should usually appear as draft/review material, with provenance and uncertainty visible.

### 2.6 Computation Should Be Reproducible, Not Merely Visual

Future computational features should be mathematical artifacts, not black-box images or disconnected simulators.

A computational exploration should preserve:

- the mathematical system
- parameters
- code or generator identity
- outputs
- saved observations
- links to objects
- reproducibility metadata

The platform should support computational/dynamical exploration, not attempt to become a general CAS.

---

## 3. Long-Term Product Direction

### 3.1 Mathematical Objects

The platform should treat mathematical entities as first-class objects.

Initial and eventual object types may include:

- definitions
- theorems
- lemmas/propositions/corollaries
- proofs and proof sketches
- examples
- counterexamples
- questions
- diagrams
- source excerpts
- notes
- trails
- conventions
- notation entries
- bridge notes
- construction notes
- proof gaps
- variants
- computational explorations
- saved observations

Objects should be reusable and embeddable in documents, trails, maps, explorations, and published views.

A theorem object, for example, may eventually contain or attach:

- statement
- hypotheses
- conclusion
- multiple proofs
- examples
- counterexamples
- hypothesis-importance notes
- diagrams
- source excerpts
- variants
- aliases
- related objects
- questions
- proof gaps
- status and provenance

The user should not be forced to fill all of this. Objects should grow progressively.

---

### 3.2 Attachments Rather Than Giant Forms

Large templates should not become cumbersome forms.

For example, the platform should not require every theorem to have an example field filled in. Instead, examples should be attachable at any point.

Object templates should define available affordances, not mandatory fields.

For a theorem, natural attachments might include:

- proof
- proof sketch
- example
- counterexample
- intuition
- source
- diagram
- question
- related theorem
- variant
- hypothesis note
- computational exploration

This lets objects remain lightweight while still being extensible.

---

### 3.3 Multiple Proofs

The platform should support multiple proofs of the same theorem.

Proofs may differ by:

- style
- source
- level of rigor
- method
- prerequisites
- intuition
- audience
- context

This is essential for capturing the beauty and diversity of mathematical reasoning.

---

### 3.4 Examples as First-Class Objects

Examples should not merely be text fields inside definitions or theorems.

A single example can illustrate many things:

- a definition
- a theorem
- a counterexample to a false statement
- the necessity of a hypothesis
- a connection between areas
- a proof idea
- a computational phenomenon

Examples should be reusable mathematical landmarks.

Computational outputs should be promotable into examples. For instance, a generated Cantor dust visualization or a Rule 90 spacetime diagram should be attachable to definitions, theorems, notes, and trails.

---

### 3.5 Hypothesis and Definition Probing

The platform should support built-in actions for understanding the design of mathematical statements.

For a theorem, users should be able to ask:

- Why is this hypothesis needed?
- What breaks if we remove it?
- Where is this hypothesis used in the proof?
- Is there a counterexample without this condition?

For a definition, users should be able to ask:

- Why is this condition included?
- What examples and non-examples clarify it?
- What theorem is this definition designed to enable?
- What changes if the definition is modified?

This should be a native AI-supported workflow, but with reviewable and source-aware output.

---

### 3.6 Sources and PDF Digestion

The platform should support serious mathematical reading without trying to become a general reference manager like Mendeley or Zotero.

The goal is source digestion:

> Turn mathematical reading into living mathematical knowledge.

Important source capabilities:

- smooth PDF viewing
- text/equation selection
- highlights and margin notes
- source anchors
- extraction of theorem/definition/example candidates
- linking source passages to objects
- reading-position memory
- source-specific aliases
- source-specific notation/conventions
- provenance preservation
- import/export of source-linked data

The PDF reader should not feel like a separate app. A PDF passage should be just another addressable place in the mathematical workspace.

---

### 3.7 Trails

Trails are first-class records of mathematical exploration.

A trail is not merely an activity log. It is a user-curated path through mathematical territory.

A trail may include:

- paper passages
- notes
- questions
- examples
- theorem objects
- source references
- offline reading placeholders
- web/source placeholders
- side quests
- return-later markers
- diagrams
- computational explorations
- saved observations
- breadcrumbs

The platform should support both:

1. automatic raw activity history, mostly hidden
2. user-curated trails, visible and meaningful

A trail should tolerate gaps. The user’s mathematical journey may include offline reading, another app, a conversation, a lecture, a computation run elsewhere, or a thought while walking.

Trail principle:

> The platform should help users preserve the thread of thought, not pretend to observe all thought.

---

### 3.8 Trail Refinement

A trail should be refinable into proper notes.

The workflow should be iterative:

1. raw trail
2. grouped breadcrumbs
3. proposed outline
4. user-edited outline
5. draft notes
6. extracted objects
7. polished notes or published view

AI can assist, but the user should be able to edit every step.

The original trail should remain preserved even after notes are produced. The journey and the exposition are both valuable.

---

### 3.9 Inbox and Review Queue

The platform should distinguish clearly between Inbox and Review.

#### Inbox

The Inbox contains user-captured raw material that has not yet been organized.

Examples:

- quick questions
- saved PDF highlights
- vague source notes
- rough theorem snippets
- unassigned breadcrumbs
- interesting examples
- handwritten/imported fragments
- saved computational observations not yet attached anywhere

The Inbox answers:

> What have I collected but not placed yet?

#### Review Queue

The Review Queue contains system-generated or AI-generated pending decisions.

Examples:

- extracted theorem candidates
- suggested duplicate matches
- proposed notation conflicts
- orphaned annotations
- AI-drafted proof comments
- proposed trail-to-notes outlines
- possible object links inferred from source text

The Review Queue answers:

> What decisions does the system need me to approve, reject, or correct?

Clean rule:

> If the user captured it, it goes to Inbox. If the system generated or detected it, it goes to Review.

---

### 3.10 Links and Addressability

Anything meaningful should be addressable, and anything addressable should be linkable.

Link targets may include:

- objects
- subobjects
- theorem hypotheses
- proof steps
- equation fragments
- diagram nodes/arrows
- PDF passages
- source regions
- margin notes
- trail breadcrumbs
- annotations
- versions
- computational experiment outputs
- parameter settings
- saved observations

Links should support:

- object search via `[[...]]`
- selection-based linking
- unresolved/fuzzy links
- typed relationships
- aliases
- backlinks
- previews
- graceful degradation when anchors move or change

Typed relationships may include:

- uses
- source for
- example of
- counterexample to
- generalizes
- special case of
- equivalent to
- explains
- questions
- related to
- notation for
- visualizes
- generated by
- observation from

For MVP, the surface can be simple, but the model should anticipate rich typed links.

---

### 3.11 Aliases

Aliases should be first-class.

A mathematical object may have many names depending on source, context, and personal habit.

Alias types:

- user aliases
- source aliases
- context aliases
- standard aliases

Examples:

- Bolzano-Weierstrass theorem
- BW theorem
- compactness subsequence theorem
- Munkres Theorem 28.2
- “the compactness result from earlier”
- “main theorem” inside a trail

Aliases should be scoped:

- global
- space
- source
- trail
- local note

Aliases improve fuzzy linking, import deduplication, and user-friendly references.

---

### 3.12 Notation and Convention Management

Notation and conventions should be handled as context-sensitive knowledge, but not in a pedantic way.

Examples:

- `;NN` → `\mathbb N`
- `;RR` → `\mathbb R`
- `;cal U` → `\mathcal U`
- `;frak p` → `\mathfrak p`
- `;Hom` → `\operatorname{Hom}`

The semicolon prefix can be used for notation snippets, while slash commands remain reserved for higher-level actions.

Notation support should include:

- personal snippets
- scoped snippets
- symbol palette
- recent/favorite notations
- notation polish action
- match notation to parent theorem/source
- role-based style suggestions

The editor should avoid intrusive popups. Most notation help should be pull-based:

- user invokes snippet prefix
- user opens palette
- user runs “Polish notation”
- user runs “Match notation”

Conventions should live near notation as part of context settings.

Examples:

- whether `0 ∈ \mathbb N`
- rings are unital or not
- compact includes Hausdorff or not
- inner product linear in first or second argument

For MVP, convention handling can be lightweight context notes rather than a formal ontology.

---

### 3.13 Diagrams

Diagrams should be code-backed and structurally editable, not merely generated images.

The platform should prioritize math-native diagram types:

- commutative diagrams
- function/map diagrams
- inclusion diagrams
- exact sequences
- simple graph diagrams
- set containment diagrams
- coordinate/region sketches
- probability trees
- dependency mini-maps

Users should be able to create and edit diagrams through natural language and direct manipulation.

Examples:

- “Create a commutative square with nodes X, Y, W, Z.”
- “Make the arrow from X to W dashed.”
- “Move W below X.”
- “Add a diagonal map φ.”
- “Export this as TikZ.”

The backend should preserve structured diagram data:

- nodes
- arrows
- labels
- relations
- layout
- styles
- source/object links

Rendered SVG/TikZ/PDF are outputs, not the canonical source.

---

### 3.14 Annotations

Annotations should be anchored objects.

They may attach to:

- text spans
- math spans
- equation blocks
- theorem blocks
- proof steps
- PDF regions
- diagram elements
- trail breadcrumbs
- computational outputs

For MVP, annotations can start with block/span/source anchors. The model should anticipate richer anchors later, including equation-subexpression anchors, diagram-element anchors, and visualization anchors.

A useful annotation design is structured annotation primitives:

- highlight
- margin note
- callout
- ellipse
- curly brace
- arrow
- underline

These feel like mathematical marginalia but provide interpretable anchors.

---

### 3.15 AI Actions and Context Control

AI should be integrated, but controlled.

Built-in AI actions should include:

- explain selected thing
- compare selected things
- check proof informally
- find hidden assumptions
- probe hypotheses/definitions
- generate examples/counterexamples
- extract theorem/definition from source
- resolve fuzzy references
- translate notation
- distill trail into notes
- explain a computational output
- suggest next exploration

AI output should be:

- context-aware
- reviewable
- provenance-aware
- editable
- usually draft-first
- visibly uncertain where needed

Users should be able to inspect what context the AI used:

- current selection
- current object
- current trail
- linked definitions
- source excerpts
- user notes
- computational outputs
- general background

Advanced users may eventually view or edit prompt templates.

---

### 3.16 Computational Exploration

Computational exploration is a future major pillar, not an MVP feature.

The platform should focus on computational and dynamical systems rather than general CAS functionality.

The goal is not:

> Build Mathematica, Sage, Jupyter, or Desmos inside the app.

The goal is:

> Let mathematical objects have reproducible, visual, inspectable explorations that become part of the user’s knowledge space.

Examples of future exploration families:

- cellular automata
- Conway’s Game of Life and variants
- graph-based automata
- Cantor sets and Cantor dust
- iterated function systems
- substitution tilings
- symbolic dynamics
- logistic map and simple chaotic maps
- cobweb and bifurcation diagrams
- chip-firing and sandpile models
- random walks on graphs
- simple Markov chains
- finite dynamical systems

A computational exploration should be a first-class object.

Example:

```text
Experiment: Elementary Cellular Automaton Rule 90

System:
  type: one-dimensional cellular automaton
  state space: {0,1}^Z
  rule: 90
  boundary: finite window
  initial condition: single seed
  time steps: 256

Outputs:
  spacetime diagram
  saved snapshots
  parameter settings
  observations

Links:
  example of: cellular automaton
  visualizes: Sierpinski triangle pattern
  related to: Pascal triangle mod 2
  attached to: current trail
```

The user should be able to:

- run a structured experiment
- vary parameters
- save a snapshot
- save an observation
- compare two parameter settings
- attach output to a theorem/definition/example/trail
- insert a visualization into notes
- ask AI about observed behavior
- export the experiment state and rendered outputs

Important principle:

> The platform should support focused mathematical explorations tied to objects, not arbitrary general-purpose code execution at first.

#### 3.16.1 Computational Outputs as Objects

A computational output should not be just a screenshot.

It should preserve:

- generating experiment
- parameters
- timestamp/version
- rendered image or animation
- raw data if applicable
- linked notes/questions
- exportable artifact
- reproducibility metadata

A saved observation can itself become an object.

Example:

```text
Observation:
Rule 90 from a single seed produces a Sierpinski-like spacetime pattern.

Source:
Experiment: Rule 90, 256 steps, finite window

Links:
- cellular automata
- Sierpinski gasket
- Pascal triangle mod 2
- additive cellular automata
```

#### 3.16.2 Cost and Execution Strategy

Computational exploration should initially prefer client-side execution when possible.

Good candidates for client-side computation:

- elementary cellular automata
- finite grids
- simple fractals
- finite graphs
- small random walks
- low-dimensional dynamical systems
- parameter sweeps of modest size

Backend computation can be introduced later with quotas, caching, and explicit user awareness.

Avoid arbitrary code execution early because it introduces security, reproducibility, cost, and UX complexity.

---

### 3.17 Privacy, Export, and Import

Data sovereignty is central.

The platform should support a lossless portable archive, e.g. `.mathpack`, containing:

- canonical object graph
- documents
- sources
- assets
- annotations
- diagrams
- links
- aliases
- notation/conventions
- trails
- computational explorations
- computational outputs
- review/inbox states where appropriate
- provenance
- schema versions

It should also export readable formats:

- Markdown
- LaTeX
- Typst
- HTML
- PDF
- SVG/TikZ for diagrams
- exported images/animations/data for computational outputs
- BibTeX/RIS where relevant

Export/import must be part of the core design, not a late feature.

---

### 3.18 Typographical Backend

The canonical backend should not be pure LaTeX, Markdown, Typst, or Pandoc.

Recommended approach:

> Canonical internal document/object model first. Markdown/LaTeX/Typst/Pandoc are adapters.

#### Canonical

Structured document AST + object graph + provenance model.

#### Editing Surface

Markdown-like prose with math blocks and object blocks.

#### Math Input

LaTeX-compatible math input should be deeply supported.

#### Rendering

- web: HTML/CSS + math rendering
- PDF: Typst or LaTeX rendering/export
- diagrams: structured model → SVG/TikZ/Typst/etc.
- computational outputs: structured exploration model → SVG/canvas/WebGL/image/data outputs

#### Import/Export

Pandoc can be useful as a conversion bridge, but not as the canonical backend.

Principle:

> Store meaning canonically. Render/export syntax secondarily.

---

## 4. MVP Focus

The MVP should prioritize input.

The main MVP goal:

> Let serious learners input rough mathematical material and turn it into high-quality mathematical objects with minimal friction and no loss of raw input.

The MVP should prove this loop:

1. user writes, pastes, or selects mathematical material
2. raw input is preserved
3. platform suggests structure
4. user reviews/edits/accepts
5. clean objects are created
6. objects remain linked to source/provenance
7. everything is exportable/migratable

Computational exploration should not be part of the MVP surface, but the MVP data model should reserve room for future exploration objects, generated outputs, and saved observations.

---

## 5. MVP Feature Set

### 5.1 Rough Math Editor

A flexible editor that supports:

- rough text input
- LaTeX-compatible math
- theorem/definition/proof/example blocks
- Markdown-like writing
- rough references
- object promotion
- annotation anchors
- links via object search
- basic status/provenance

The editor should not punish malformed LaTeX or informal references. It should preserve rough input and offer clean-up/refinement.

---

### 5.2 Core Object Types

MVP object types:

- note
- definition
- theorem
- proof/proof sketch
- example
- question
- diagram
- source excerpt
- trail
- annotation

Each object should support:

- stable ID
- title/name
- raw source
- structured fields
- provenance
- status
- aliases
- links/backlinks
- attachments where relevant

Object states for MVP:

- raw/imported
- draft
- AI-drafted
- user-verified
- trusted
- needs review
- deprecated/replaced by

Future-reserved object families:

- computational exploration
- computational output
- saved observation
- parameter setting
- comparison experiment

These do not need full MVP UI, but the schema should not make them awkward later.

---

### 5.3 PDF Selection to Object

MVP PDF support should focus on source digestion, not full reference management.

Required:

- open/read PDF
- select text/region
- highlight
- add margin note
- extract candidate object
- attach source provenance
- remember reading position
- link source passage to object

Not required for MVP:

- full citation manager
- collaboration libraries
- advanced bibliography workflows
- replacing Zotero/Mendeley

---

### 5.4 Trails and Breadcrumbs

MVP should support:

- create trail
- add breadcrumb manually
- save current selection/object/source to trail
- add return-later marker
- support offline/external placeholders
- show current trail lightly
- preserve raw activity enough to help reconstruct recent path

Trail refinement can start simple:

- group breadcrumbs
- propose outline
- draft notes from selected trail section
- review before inserting

---

### 5.5 Inbox and Review Queue

MVP should include both:

#### Inbox

For user-captured unorganized material.

#### Review Queue

For AI/system-generated candidates and decisions.

This separation is important from the beginning to avoid AI pollution.

---

### 5.6 Notation Input

MVP notation support should include:

- semicolon snippets
- personal snippet dictionary
- space/context-specific snippets
- symbol palette
- recent/favorite symbols
- notation polish action
- notation match action

Examples:

- `;NN` → `\mathbb N`
- `;RR` → `\mathbb R`
- `;cal U` → `\mathcal U`
- `;frak p` → `\mathfrak p`
- `;Hom` → `\operatorname{Hom}`

The system should not pop up suggestions constantly. Batch notation review is preferred.

---

### 5.7 Diagram Input

MVP diagrams should be structured and editable.

Prioritize a small set of math-native diagram types:

- commutative diagrams
- function/map diagrams
- inclusion diagrams
- exact sequences
- simple set/region sketches

MVP capabilities:

- create diagram from natural language
- edit diagram by natural language
- edit via direct manipulation
- store structured diagram model
- render to SVG
- export to TikZ or another editable format where possible
- attach diagram to object/source/trail/note

Do not make generated PNGs the core diagram format.

---

### 5.8 Linking and Aliases

MVP linking should include:

- `[[...]]` object search
- selection → link to object
- source excerpt → link to object
- unresolved/fuzzy links
- aliases
- source-scoped aliases
- backlinks
- link previews
- basic typed relationships

Initial relationship types:

- related
- uses
- source for
- example of
- counterexample to
- generalizes
- special case of
- equivalent to
- questions

Future relationship types for computational exploration:

- visualizes
- generated by
- observation from
- parameter variant of
- compares with

---

### 5.9 Built-In AI Workflows

MVP should include a small set of excellent built-in AI workflows:

- Ask about selection
- Explain simply
- Compare selected things
- Extract theorem/definition/example from source
- Check proof informally
- Find hidden assumptions
- Probe hypothesis/definition
- Generate example/counterexample
- Resolve fuzzy reference
- Translate notation lightly
- Distill selected trail into outline/draft notes

All AI workflows should produce reviewable, editable output.

Future AI workflows may include:

- explain computational output
- compare experiment runs
- suggest next exploration
- turn saved observation into note/example
- warn about finite approximation artifacts

---

### 5.10 Export/Import and Migration Foundations

MVP must include foundations for:

- stable IDs
- schema versioning
- raw + structured storage
- migration framework
- `.mathpack` archive design
- readable export at least to Markdown/HTML initially
- preservation of source assets
- preservation of diagrams and annotations
- future preservation of computational explorations and outputs
- export/import tests

Even if all export targets are not polished on day one, the architecture should assume lossless export/import from the start.

---

### 5.11 Calm Desk Home

MVP home should be calm and practical.

It may show:

- continue where you left off
- active trails
- inbox
- review queue
- return-later items
- recent sources
- recent notes

It should not be a noisy graph dashboard.

---

## 6. Explicit MVP Non-Goals

The MVP should not prioritize:

- full graph/map UI
- user-defined workflow editor
- mobile app
- full desktop app
- collaboration
- social publishing
- full handwritten note import
- active recall/Anki
- complete proof-pattern library
- full convention ontology
- complete reference manager replacement
- broad diagram illustration system
- formal proof assistant integration
- automated theorem discovery
- general CAS functionality
- arbitrary code execution
- full computational exploration UI

These may matter later, but they should not distract from high-quality mathematical input and object creation.

---

## 7. Future Extensibility

The platform should be designed so that future features are natural extensions, not rewrites.

Future directions include:

- richer map views
- user-defined workflows
- advanced prompt/template editing
- local-first desktop app
- tablet annotation mode
- handwritten note import
- publication/audience views
- plugin/import-export ecosystem
- deeper convention management
- equation-subexpression anchoring
- richer diagram types
- proof-pattern tracking
- optional spaced review
- collaboration and shared spaces
- computational exploration of dynamical systems
- cellular automata explorations
- fractal/construction explorations
- symbolic dynamics and finite dynamical systems
- saved computational observations as examples
- client-side mathematical experiment runtime

---

## 8. Core Product Loop

The product loop we want to validate:

```text
Read or write rough math
→ capture notes/questions/breadcrumbs
→ extract or create objects
→ link objects to sources and each other
→ use AI carefully with controlled context
→ review drafts and suggestions
→ refine trails into notes
→ preserve/export everything
```

Long-term, this loop expands to:

```text
Explore a mathematical system computationally
→ save outputs/observations
→ attach them to objects/trails/notes
→ ask questions and compare variants
→ refine observations into examples/explanations
→ preserve/export the reproducible experiment
```

---

## 9. One-Sentence Summary

A serious, sovereignty-respecting mathematical workspace where learners can input rough mathematics, preserve their exploratory trails, and gradually crystallize sources, notes, diagrams, examples, proofs, and eventually computational explorations into a living network of high-quality mathematical objects.
