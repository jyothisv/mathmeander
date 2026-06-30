// §6.3b the TYPED-BLOCK TITLE BAR — interactive chrome replacing the old CSS `::before` label + the in-body
// `[name]` marker. For every typed block it renders, out-of-band in the reserved top row, the label +
// computed NUMBER ("Theorem 1") + the authored NAMES (primary, then aliases), each via `renderNameSource`
// so a name with `$…$` shows KaTeX. Double-click a NAME → it becomes an inline `<input>` IN PLACE; ＋ adds
// an alias, ✕ removes; Enter / click-away saves, Escape cancels. The widget carries `stopEvent: () => true`
// (+ contenteditable=false) so ProseMirror ignores the inputs' DOM events — they keep native focus/typing,
// no fight. Edit state lives in plugin state and is folded into the decoration `key`, so entering/leaving
// edit rebuilds only that block's widget and a pure caret move stays cheap. Numbers are cached (recomputed
// on docChanged). The widget DOM is excluded from `textContent`/copy, so it never pollutes the prose.
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { v7 as uuidv7 } from 'uuid';
import { displayLabels } from './numberingRuntime';
import { docBlocks } from './referenceLivePreview';
import { displayType } from './citePicker';
import { renderNameSource } from './renderName';
import type { Name } from './names';

interface Editing {
  unitId: string;
  focusId: string | null; // the name to focus on enter (null → the first / a fresh empty one)
}
interface TitleState {
  numbers: Map<string, number | null>; // unitId → its computed number (null when the policy omits it)
  editing: Editing | null;
}
const KEY = new PluginKey<TitleState>('typeTitle');

/** Reading-order numbers for the typed blocks, via the core numbering (wasm). Empty until the runtime loads. */
function computeNumbers(doc: PMNode): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const l of displayLabels(docBlocks(doc))) {
    if (l.unit_type != null) out.set(l.unit_id, l.number ?? null);
  }
  return out;
}

/** The block position of `unitId` (robust to shifts since edit mode opened). */
function blockPosOf(doc: PMNode, unitId: string): number | null {
  let at: number | null = null;
  doc.forEach((block, offset) => {
    if (at === null && block.type.name === 'prose' && block.attrs.unitId === unitId) at = offset;
  });
  return at;
}

function enterEdit(view: EditorView, editing: Editing): void {
  view.dispatch(view.state.tr.setMeta(KEY, { edit: editing }));
}

function sameNames(a: Name[], b: Name[]): boolean {
  return a.length === b.length && a.every((n, i) => n.id === b[i]!.id && n.name === b[i]!.name);
}

/** Build the inline name EDITOR into `bar` (replacing the static names): one `<input>` per name + ＋/✕. */
function buildEditor(view: EditorView, bar: HTMLElement, unitId: string, names: Name[], focusId: string | null): void {
  const rows: { id: string; input: HTMLInputElement }[] = [];
  let done = false;
  const finish = (write: boolean): void => {
    if (done) return;
    done = true;
    const tr = view.state.tr.setMeta(KEY, { edit: null });
    if (write) {
      const list = rows
        .map((r) => ({ id: r.id, name: r.input.value.trim() }))
        .filter((n) => n.name.length > 0);
      const pos = blockPosOf(view.state.doc, unitId);
      const cur = (pos != null ? (view.state.doc.nodeAt(pos)?.attrs.names as Name[] | undefined) : undefined) ?? [];
      // Only WRITE when the names actually changed — a no-op edit (select a title, click away) must not
      // dirty the doc (else a spurious "Unsaved → Saved" with nothing to save). `setMeta` alone (the exit)
      // doesn't change the doc, so it never triggers autosave.
      if (pos != null && !sameNames(list, cur)) tr.setNodeAttribute(pos, 'names', list);
    }
    view.dispatch(tr);
    view.focus();
  };
  const onBlur = (): void => {
    // commit when focus leaves the WHOLE bar (moving between this bar's inputs/buttons keeps it open).
    setTimeout(() => {
      if (!done && !bar.contains(document.activeElement)) finish(true);
    }, 0);
  };
  // A hidden mirror measures the EXACT text width (the `size` attr over-estimates for proportional/narrow
  // text like `$f(x)=e^x$`, leaving trailing space) — same font as `.mm-title-input` so widths match.
  const mirror = document.createElement('span');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.cssText =
    'position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden;font-style:italic;font-weight:600;font-size:0.86rem;';
  bar.appendChild(mirror);
  const fit = (input: HTMLInputElement): void => {
    mirror.textContent = input.value.length ? input.value : input.placeholder || '';
    input.style.width = `${Math.ceil(mirror.getBoundingClientRect().width) + 2}px`;
  };
  const addRow = (n: Name): void => {
    const chip = document.createElement('span');
    chip.className = 'mm-title-chip';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mm-title-input';
    input.value = n.name;
    input.placeholder = 'name';
    input.addEventListener('input', () => fit(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', onBlur);
    const rec = { id: n.id, input };
    rows.push(rec);
    chip.appendChild(input);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'mm-title-rm';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', 'remove name');
    rm.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't blur-commit; just drop this row
      rows.splice(rows.indexOf(rec), 1);
      chip.remove();
    });
    chip.appendChild(rm);
    bar.insertBefore(chip, add);
  };

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'mm-title-add';
  add.textContent = '＋';
  add.setAttribute('aria-label', 'add alias');
  add.addEventListener('mousedown', (e) => {
    e.preventDefault();
    addRow({ id: uuidv7(), name: '' });
    // size + focus the just-added field once it's laid out.
    setTimeout(() => {
      const last = rows[rows.length - 1]?.input;
      if (last) {
        fit(last);
        last.focus();
      }
    }, 0);
  });
  bar.appendChild(add);

  const seed = names.filter((n) => n.name.length > 0);
  const list = seed.length > 0 ? seed : [{ id: uuidv7(), name: '' }];
  list.forEach(addRow);
  // After the widget is attached (so measurement + focus work): size every field, then focus the target.
  setTimeout(() => {
    rows.forEach((r) => fit(r.input));
    const target = (focusId != null ? rows.find((r) => r.id === focusId) : undefined) ?? rows[0];
    if (target) {
      target.input.focus();
      target.input.select();
    }
  }, 0);
}

/** The title-bar widget for one typed block. */
function titleWidget(unitId: string, type: string, number: number | null, names: Name[], editing: Editing | null) {
  return (view: EditorView): HTMLElement => {
    const bar = document.createElement('span');
    bar.className = 'mm-title';
    bar.setAttribute('contenteditable', 'false');

    const label = document.createElement('span');
    label.className = 'mm-title-label';
    label.textContent = number != null ? `${displayType(type)} ${number}` : displayType(type);
    bar.appendChild(label);

    if (editing && editing.unitId === unitId) {
      buildEditor(view, bar, unitId, names, editing.focusId);
      return bar;
    }

    const shown = names.filter((n) => n.name.length > 0);
    if (shown.length > 0) {
      const namesEl = document.createElement('span');
      namesEl.className = 'mm-title-names';
      shown.forEach((n, i) => {
        if (i > 0) namesEl.appendChild(document.createTextNode(' · '));
        const span = document.createElement('span');
        span.className = 'mm-title-name';
        span.setAttribute('data-name-id', n.id); // which name this is (for double-click → focus it)
        span.appendChild(renderNameSource(n.name));
        namesEl.appendChild(span);
      });
      bar.appendChild(namesEl);
    }
    // ONE double-click handler: edit the NAME under the pointer (focus it); a dbl-click off any name (the
    // label, the `·` separator, or an unnamed block) starts a fresh name. Deriving the target via `closest`
    // is robust — no per-span listener / stopPropagation race that could fall through to "the first name".
    bar.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const t = e.target;
      const nameEl = t instanceof Element ? t.closest('.mm-title-name') : null;
      enterEdit(view, { unitId, focusId: nameEl?.getAttribute('data-name-id') ?? null });
    });
    return bar;
  };
}

export const typeTitle = new Plugin<TitleState>({
  key: KEY,
  state: {
    init: (_config, state) => ({ numbers: computeNumbers(state.doc), editing: null }),
    apply(tr, value, _old, newState) {
      const meta = tr.getMeta(KEY) as { edit: Editing | null } | undefined;
      const editing = meta ? meta.edit : value.editing;
      const numbers = tr.docChanged ? computeNumbers(newState.doc) : value.numbers;
      return numbers === value.numbers && editing === value.editing ? value : { numbers, editing };
    },
  },
  props: {
    decorations(state) {
      const ps = KEY.getState(state);
      if (!ps) return null;
      const decos: Decoration[] = [];
      state.doc.forEach((block, offset) => {
        if (block.type.name !== 'prose') return;
        const type = block.attrs.unitType as string | null;
        if (!type) return;
        const unitId = block.attrs.unitId as string | null;
        if (!unitId) return;
        const names = (block.attrs.names as Name[]) ?? [];
        const number = ps.numbers.get(unitId) ?? null;
        const editing = ps.editing && ps.editing.unitId === unitId ? ps.editing : null;
        decos.push(
          Decoration.widget(offset + 1, titleWidget(unitId, type, number, names, editing), {
            side: -1,
            stopEvent: () => true, // the title is chrome — PM ignores its events (so the inputs work)
            // re-render when the number, the names, or this block's edit-state change.
            key: `title:${unitId}:${number}:${editing ? `edit:${editing.focusId}` : names.map((n) => `${n.id}=${n.name}`).join('|')}`,
          }),
        );
      });
      return decos.length ? DecorationSet.create(state.doc, decos) : null;
    },
  },
});
