// A Notion-style per-block HANDLE in the left gutter (a ⋮⋮ grip), revealed on hover. Clicking it opens a
// small menu — Move up / Move down — wired to the `moveBlock` command. Drag-to-reorder + Delete are deferred.
//
// It is a single HOVER-TRACKED OVERLAY element positioned by coordinates (getBoundingClientRect) OUTSIDE the
// editable DOM — NOT a per-block widget decoration. This is deliberate and matches Tiptap's DragHandle / Notion:
// a widget decoration at a block's START position (`offset+1`) sits exactly where the caret lands and hits a
// browser-level ProseMirror bug (archived PM issue #1061) — the caret jumps / lands on the wrong side, which
// SCRAMBLED text typed at the start of a block (e.g. a block-opening `$…$` equation never recognized). An
// out-of-flow overlay touches neither the document nor the caret, so block-start editing stays clean.
import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
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

export const blockHandle = new Plugin({
  view(view) {
    const handle = document.createElement('div');
    handle.className = 'mm-block-handle';
    handle.textContent = '⋮⋮'; // out-of-flow (in <body>) → this text never enters any block's textContent/copy
    handle.setAttribute('aria-label', 'block actions');
    handle.style.display = 'none';
    document.body.appendChild(handle);

    let curBlockStart: number | null = null;
    let hideTimer: number | null = null;
    const cancelHide = (): void => {
      if (hideTimer != null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const hide = (): void => {
      cancelHide();
      handle.style.display = 'none';
      curBlockStart = null;
    };
    const scheduleHide = (): void => {
      cancelHide();
      hideTimer = window.setTimeout(hide, 150); // bridge the gutter gap between the block and the handle
    };

    /** The top-level prose/config block under the pointer (its start pos + DOM), or null. */
    const blockUnder = (
      clientX: number,
      clientY: number,
    ): { start: number; dom: HTMLElement } | null => {
      const found = view.posAtCoords({ left: clientX, top: clientY });
      if (!found) return null;
      const $pos = view.state.doc.resolve(found.pos);
      if ($pos.depth < 1) return null;
      const node = $pos.node(1);
      if (node.type.name !== 'prose' && node.type.name !== 'config') return null;
      const start = $pos.before(1);
      const dom = view.nodeDOM(start);
      return dom instanceof HTMLElement ? { start, dom } : null;
    };

    const onMove = (e: MouseEvent): void => {
      cancelHide();
      const hit = blockUnder(e.clientX, e.clientY);
      if (!hit) {
        scheduleHide();
        return;
      }
      const rect = hit.dom.getBoundingClientRect();
      handle.style.display = 'block';
      handle.style.left = `${rect.left - 22}px`; // the gutter, left of the text
      handle.style.top = `${rect.top + 2}px`; // aligned to the block's first line (Notion-style)
      curBlockStart = hit.start;
    };

    view.dom.addEventListener('mousemove', onMove);
    view.dom.addEventListener('mouseleave', scheduleHide);
    handle.addEventListener('mouseenter', cancelHide);
    handle.addEventListener('mouseleave', scheduleHide);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep the caret where it is until an action is chosen
      if (curBlockStart != null) openMenu(view, handle, curBlockStart);
    });

    return {
      destroy: () => {
        closeOpenMenu?.();
        cancelHide();
        view.dom.removeEventListener('mousemove', onMove);
        view.dom.removeEventListener('mouseleave', scheduleHide);
        handle.remove();
      },
    };
  },
});
