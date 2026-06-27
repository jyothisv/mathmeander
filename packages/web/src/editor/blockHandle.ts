// A Notion-style per-block HANDLE in the left gutter (a ⋮⋮ grip), revealed on hover / when the block is
// active. Clicking it opens a small menu — Move up / Move down — wired to the `moveBlock` command. The handle
// is a widget decoration per top-level prose block; the menu is a single shared, document-level element
// (dismissed on an outside click or after an action). Drag-to-reorder + Delete are deferred.
import { Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { moveBlock } from './moveBlock';

let closeOpenMenu: (() => void) | null = null;

/** Place the caret in the block at `blockStart`, then run `cmd` (which acts on the caret's block). */
function actOnBlock(view: EditorView, blockStart: number, cmd: ReturnType<typeof moveBlock>): void {
  const sel = TextSelection.near(view.state.doc.resolve(blockStart + 1), 1);
  view.dispatch(view.state.tr.setSelection(sel));
  cmd(view.state, view.dispatch);
  view.focus();
}

function openMenu(view: EditorView, anchor: HTMLElement, blockStart: number): void {
  closeOpenMenu?.();
  const menu = document.createElement('div');
  menu.className = 'mm-block-menu';
  const add = (label: string, onClick: () => void): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onClick();
      closeOpenMenu?.();
    });
    menu.appendChild(btn);
  };
  add('Move up', () => actOnBlock(view, blockStart, moveBlock('up')));
  add('Move down', () => actOnBlock(view, blockStart, moveBlock('down')));

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${window.scrollX + rect.left}px`;
  menu.style.top = `${window.scrollY + rect.bottom + 4}px`;
  document.body.appendChild(menu);

  const onOutside = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) closeOpenMenu?.();
  };
  // Defer so the opening mousedown doesn't immediately dismiss the menu.
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  closeOpenMenu = () => {
    document.removeEventListener('mousedown', onOutside, true);
    menu.remove();
    closeOpenMenu = null;
  };
}

function handleWidget(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mm-block-handle';
  el.textContent = '⋮⋮';
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('aria-label', 'block actions');
  el.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep the caret where it is until an action is chosen
    const pos = getPos();
    if (pos == null) return;
    openMenu(view, el, pos - 1); // the widget sits at blockStart+1 → blockStart = pos - 1
  });
  return el;
}

export const blockHandle = new Plugin({
  // The menu is a document-level element with a capture-phase listener; close it on editor teardown so
  // navigating away (keyboard/back) with the menu open doesn't orphan the DOM + listener over a destroyed
  // view. (It self-heals on the next outside mousedown, but destroy() is the clean hook.)
  view() {
    return { destroy: () => closeOpenMenu?.() };
  },
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      state.doc.forEach((block, offset) => {
        if (block.type.name !== 'prose' && block.type.name !== 'config') return; // config (notation home) too
        const id = (block.attrs.unitId as string | null) ?? `@${offset}`;
        decos.push(Decoration.widget(offset + 1, handleWidget, { side: -1, key: `bh:${id}` }));
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});
