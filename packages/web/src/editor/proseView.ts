// The prose block NodeView. It exists so per-block CHROME (the typed-unit title bar, the section-fold
// chevron) renders OUTSIDE the editable content: the chrome lives in `dom` as a sibling of `contentDOM`, so
// the caret only ever navigates `contentDOM` and copy/serialization only sees the content. This is the
// out-of-band fix for the block-start scramble — a chrome WIDGET at a block's start position (offset+1) sits
// where the caret lands and corrupts block-opening typing (a `$…$` equation never recognized; PM #1061).
//
// `dom` is the `<p>` (so node attrs + node-decoration classes — `unit-active`, `mm-heading` — land where the
// existing CSS/tests expect them); `contentDOM` is an inner `<span class="mm-content">` holding the content.
// The chrome DATA arrives on node-decoration specs (`title` from typeTitle, `fold` from headingFold); the
// interactive builders (`titleWidget`, `foldChevron`) are reused verbatim — only their delivery moves here.
import type { Node as PMNode } from 'prosemirror-model';
import type { Decoration, EditorView } from 'prosemirror-view';
import { titleWidget, type TitleData } from './typeTitle';
import { foldChevron, type FoldData } from './headingFold';

function readSpec<T>(decos: readonly Decoration[], key: 'title' | 'fold'): T | null {
  for (const d of decos) {
    const v = (d.spec as Record<string, unknown> | undefined)?.[key];
    if (v != null) return v as T;
  }
  return null;
}

class ProseView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly chrome: HTMLElement;
  private sig = '\0'; // force a first render

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    decos: readonly Decoration[],
  ) {
    this.dom = document.createElement('p');
    this.chrome = document.createElement('span');
    this.chrome.className = 'mm-chrome';
    this.chrome.setAttribute('contenteditable', 'false');
    this.contentDOM = document.createElement('span');
    this.contentDOM.className = 'mm-content';
    this.dom.append(this.chrome, this.contentDOM);
    this.syncAttrs(node);
    this.renderChrome(decos);
  }

  private toggleAttr(name: string, value: string | null): void {
    if (value == null) this.dom.removeAttribute(name);
    else this.dom.setAttribute(name, value);
  }

  /** Mirror the schema `toDOM` attrs onto `dom` (a NodeView replaces `toDOM`). set/removeAttribute + classList
   *  so it never clobbers node-DECORATION classes PM applies to the same element (e.g. `unit-active`). */
  private syncAttrs(node: PMNode): void {
    const a = node.attrs;
    this.dom.setAttribute('data-unit-id', (a.unitId as string | null) ?? '');
    this.toggleAttr('data-unit-type', (a.unitType as string | null) ?? null);
    this.toggleAttr('data-parent-id', (a.parentId as string | null) ?? null);
    const heading = a.heading as boolean;
    this.toggleAttr('data-heading', heading ? 'true' : null);
    this.dom.classList.toggle('mm-heading', heading);
  }

  /** Rebuild the chrome ONLY when its data actually changed (a stable signature) — so a pure caret move never
   *  rebuilds it, and mid-edit typing (which dispatches no transaction) never rips focus out of a name input. */
  private renderChrome(decos: readonly Decoration[]): void {
    const title = readSpec<TitleData>(decos, 'title');
    const fold = readSpec<FoldData>(decos, 'fold');
    const sig =
      (title
        ? `t:${title.type}:${title.number}:${title.editing ? `e${title.editing.focusId}` : ''}:${title.names
            .map((n) => `${n.id}=${n.name}`)
            .join('|')}`
        : '') + (fold ? `;f:${fold.id}:${fold.folded}` : '');
    if (sig === this.sig) return;
    this.sig = sig;
    this.chrome.replaceChildren();
    if (title)
      this.chrome.appendChild(
        titleWidget(title.unitId, title.type, title.number, title.names, title.editing)(this.view),
      );
    if (fold) this.chrome.appendChild(foldChevron(fold.id, fold.folded)(this.view));
    this.dom.classList.toggle('mm-has-chrome', !!(title || fold));
  }

  update(node: PMNode, decos: readonly Decoration[]): boolean {
    if (node.type.name !== 'prose') return false;
    this.syncAttrs(node);
    this.renderChrome(decos);
    return true;
  }

  /** Chrome events (title double-click, name inputs, fold click) are handled by the chrome itself, never PM. */
  stopEvent(event: Event): boolean {
    return this.chrome.contains(event.target as Node);
  }

  /** Chrome DOM churn (the title bar / inputs / chevron) is not document content — never sync it back. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target);
  }
}

export function proseNodeView(
  node: PMNode,
  view: EditorView,
  _getPos: () => number | undefined,
  decorations: readonly Decoration[],
): ProseView {
  return new ProseView(node, view, decorations);
}
