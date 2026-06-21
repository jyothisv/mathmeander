// The inline-math NodeView — math mode, Obsidian-style LIVE PREVIEW. The math RENDERS by default (KaTeX);
// its `$…$` SOURCE is revealed inline, in the prose flow itself, ONLY while the caret is inside the node —
// edited as real ProseMirror text (the `contentDOM`), not a separate editor. The moment the caret crosses
// back out, it re-renders. This is the multi-mode buffer: inside the math node the cursor plays by math rules
// (see mathKeys); the prose keymaps/cues self-disable because `$from.parent` is no longer `prose`.
//
// "Open" is not local state: a node decoration (class/marker `math-open`, from mathOpen.ts) marks whichever
// inline-math node currently contains the selection. Decorations recompute on every selection change and are
// delivered to `update`, which toggles source-vs-render. Closing is purely VISUAL — `mathSync` has already
// mirrored the source into `attrs.expr` on each keystroke, so there is no commit transaction here.
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView, Decoration, ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import type { MathExpression } from '@mathmeander/schema';
import { renderMathInto } from './renderMath';
import { isFreshMath } from './mathKeys';

/** Is the `math-open` marker (set by mathOpen.ts) among the node's decorations? */
function isOpen(decorations: readonly Decoration[]): boolean {
  return decorations.some((d) => (d.spec as { mathOpen?: boolean } | undefined)?.mathOpen === true);
}

/** A non-editable `$` delimiter span (an affordance shown only when the source is open). */
function delimiter(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'math-delim';
  s.contentEditable = 'false';
  s.textContent = '$';
  return s;
}

export class MathNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement; // PM renders the node's source TEXT here (the editing buffer)
  private readonly render: HTMLElement; // KaTeX output (we own it; PM must ignore its mutations)
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private node: PMNode;
  private open = false;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    decorations: readonly Decoration[],
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('span');
    this.dom.className = 'inline-math';

    this.contentDOM = document.createElement('span');
    this.contentDOM.className = 'math-source';

    this.render = document.createElement('span');
    this.render.className = 'math-render';
    this.render.contentEditable = 'false';

    // The `$…$` delimiters are real sibling spans (shown via CSS only when open), NOT pseudo-elements on the
    // source: the caret lives in `contentDOM` BETWEEN them, so on an empty `$` it renders inside the pair
    // (a `::before` would paint at the box edge → the caret appeared before the first `$`).
    this.dom.appendChild(delimiter());
    this.dom.appendChild(this.contentDOM);
    this.dom.appendChild(delimiter());
    this.dom.appendChild(this.render);
    // Double-click a RENDERED equation → reveal its source (a deliberate open; a single click does NOT).
    // A direct DOM listener is reliable here — PM's handleDoubleClickOn does not fire dependably on the
    // contentEditable=false KaTeX render. Only FRESH exprs open (the keystone guard).
    this.dom.addEventListener('dblclick', (e) => this.openSource(e));
    this.setOpen(isOpen(decorations));
  }

  /** Open the source for editing: drop the caret at the end of the source (mathOpen then reveals it). */
  private openSource(e: MouseEvent): void {
    if (this.open || !isFreshMath(this.node)) return;
    const pos = this.getPos();
    if (pos == null) return;
    e.preventDefault();
    const end = pos + this.node.nodeSize - 1; // just inside the closing token = end of the source
    this.view.dispatch(
      this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)),
    );
    this.view.focus();
  }

  private get expr(): MathExpression {
    return this.node.attrs.expr as MathExpression;
  }

  /** Toggle source/render. When CLOSED, (re)render KaTeX from the current expression. */
  private setOpen(open: boolean): void {
    this.open = open;
    this.dom.classList.toggle('math-open', open);
    if (!open) renderMathInto(this.expr, this.render, { display: false });
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.setOpen(isOpen(decorations));
    return true;
  }

  // While OPEN, let the DOM handle pointer events so a click lands the caret INSIDE the source. Because the
  // node is `atom: true`, PM would otherwise turn a click into a NodeSelection — which mathOpen drops (it
  // marks open only for a TextSelection inside the node), collapsing the source back to the rendered view.
  // Keyboard/beforeinput are NOT stopped (PM must still apply typing); when closed this is inert, so a single
  // click still NodeSelects and the dblclick listener still opens.
  stopEvent(e: Event): boolean {
    if (!this.open) return false;
    const t = e.type;
    return t.startsWith('mouse') || t.startsWith('pointer') || t === 'click' || t === 'dblclick';
  }

  // PM must read the user's edits to the source (contentDOM) but IGNORE everything we own — the KaTeX render,
  // the static `$` delimiter spans, and our `math-open` class toggles. Selection mutations pass through (PM
  // tracks the caret crossing in/out of the source).
  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains(m.target);
  }

  selectNode(): void {
    this.dom.classList.add('math-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('math-selected');
  }
}
