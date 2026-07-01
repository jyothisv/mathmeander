// The `@`-citation picker (same-document block citation). Typing `@` at a word boundary opens a
// caret-anchored popover listing the TYPED BLOCKS of the current document (theorems / definitions / …),
// sourced live from the editor doc — no server call. Choosing one REPLACES the `@query` text with a
// zero-width `reference` atom targeting that block (`ReferenceTarget::Unit`). No atom is created until
// the user confirms (Enter / click); Escape dismisses, leaving the typed text. The `@` must sit at a
// block start or after whitespace, so an email's `a@b` never triggers. The atom carries a CLIENT-minted
// `linkId`; the core derives the `Link` edge from `save_content`. Cross-document citation is the later
// widening: only the candidate SOURCE changes (this doc → a global index) — the atom, the target shape,
// and the commit are unchanged (the `unit_id` is globally unique).
import { Plugin, TextSelection, type EditorState } from 'prosemirror-state';
import { type EditorView } from 'prosemirror-view';
import { v7 as uuidv7 } from 'uuid';
import { editorSchema } from './schema';
import { sortedNames, type Name } from './names';

export interface PickerState {
  from: number; // doc pos of the `@`
  to: number; // doc pos of the cursor (end of the query)
  query: string;
}

/** A citable candidate — ONE per typed unit, carrying ALL its authored names (§6.3b). The picker shows one
 *  row per unit with the aliases visible; the query selects the best-matching alias WITHIN the row
 *  (`bestMatch`), and the commit pins the unit (`target`) + that alias (`targetHandleId`). */
export interface BlockCandidate {
  unitId: string;
  type: string;
  snippet: string;
  names: Name[];
}

/** The alias (within a unit) that a query selects: empty query → the primary (min-by-id); else the name
 *  with the EARLIEST case-insensitive substring match; no match → the primary; no names → `null` (by number). */
export function bestMatch(
  c: BlockCandidate,
  query: string,
): { handleId: string; name: string } | null {
  if (c.names.length === 0) return null;
  const primary = sortedNames(c.names)[0]!;
  if (query === '') return { handleId: primary.id, name: primary.name };
  const q = query.toLowerCase();
  let best: Name | null = null;
  let bestIdx = Infinity;
  for (const n of c.names) {
    const i = n.name.toLowerCase().indexOf(q);
    if (i >= 0 && i < bestIdx) {
      bestIdx = i;
      best = n;
    }
  }
  const chosen = best ?? primary;
  return { handleId: chosen.id, name: chosen.name };
}

/** Derive the active picker from the doc: an empty selection sitting right after an `@word` in a prose
 *  block, where the `@` is at the block start or preceded by whitespace. `textBetween` with a one-char
 *  placeholder per inline leaf keeps the string length equal to `parentOffset`, so offsets map directly
 *  to doc positions. Returns null whenever no picker should be open. */
export function findPickerState(state: EditorState): PickerState | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $from = sel.$from;
  if ($from.parent.type.name !== 'prose') return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '￼');
  // `@` triggers at a word boundary: block start, after whitespace, OR after a leaf (`￼` — a
  // hard_break/atom), so it opens at the start of a SOFT line too. An email's `a@b` (preceded by a
  // letter) still never matches.
  const m = /(?:^|\s|￼)@([^\s@￼]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  return { from: $from.pos - query.length - 1, to: $from.pos, query };
}

/** Substring rank over the unit's names + snippet + type: empty query keeps everything; an earlier match
 *  (in ANY name) ranks higher. `< 0` = no match. */
export function score(c: BlockCandidate, query: string): number {
  if (query === '') return 1;
  const hay = `${c.names.map((n) => n.name).join(' ')} ${c.snippet} ${c.type}`.toLowerCase();
  const i = hay.indexOf(query.toLowerCase());
  return i < 0 ? -1 : 1000 - i;
}

/** Enumerate the document's TYPED blocks (theorems/definitions/…), ONE per unit, excluding the block the
 *  caret sits in (no self-citation). Each carries the unit id, a one-line snippet, type, and all names. */
export function localBlocks(state: EditorState): BlockCandidate[] {
  const curId = (state.selection.$from.parent.attrs.unitId as string | null) ?? null;
  const out: BlockCandidate[] = [];
  state.doc.forEach((block) => {
    if (block.type.name !== 'prose') return;
    const type = block.attrs.unitType as string | null;
    const unitId = block.attrs.unitId as string | null;
    if (!type || !unitId || unitId === curId) return;
    const snippet = block.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    const names = sortedNames(
      ((block.attrs.names as Name[]) ?? []).filter((n) => n.name.length > 0),
    );
    out.push({ unitId, type, snippet, names });
  });
  return out;
}

/** "theorem" → "Theorem" — the inline display of a block citation until numbers (Stage 2) / names land. */
export function displayType(type: string): string {
  return type.length ? type[0]!.toUpperCase() + type.slice(1) : type;
}

const MAX_ROWS = 8;

class CitePickerView {
  private dom: HTMLElement | null = null;
  private selected = 0;
  private openFrom: number | null = null;
  private dismissed = false;

  /** `selfId` is the current document's object id — the home object of every block it lists. */
  constructor(private readonly selfId: string) {}

  update(view: EditorView): void {
    const st = findPickerState(view.state);
    if (!st) {
      this.close();
      return;
    }
    if (this.openFrom !== st.from) {
      this.openFrom = st.from;
      this.dismissed = false;
      this.selected = 0;
    }
    if (this.dismissed) {
      this.hideDom();
      return;
    }
    this.render(view, st);
  }

  onKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    const st = findPickerState(view.state);
    if (!st || this.dismissed) return false;
    if (event.key === 'Escape') {
      this.dismissed = true;
      this.hideDom();
      return true;
    }
    const items = this.filter(view.state, st.query);
    if (event.key === 'ArrowDown') {
      if (items.length) this.selected = (this.selected + 1) % items.length;
      this.render(view, st);
      return true;
    }
    if (event.key === 'ArrowUp') {
      if (items.length) this.selected = (this.selected - 1 + items.length) % items.length;
      this.render(view, st);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const pick = items[this.selected];
      if (!pick) return false; // no matches → let the key through (Enter = newline)
      this.commit(view, pick);
      return true;
    }
    return false;
  }

  private filter(state: EditorState, query: string): BlockCandidate[] {
    return localBlocks(state)
      .map((c) => ({ c, s: score(c, query) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_ROWS)
      .map((x) => x.c);
  }

  private render(view: EditorView, st: PickerState): void {
    const items = this.filter(view.state, st.query);
    if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);
    const dom = this.ensureDom();
    dom.replaceChildren();

    if (items.length === 0) {
      dom.appendChild(this.message('No theorems or definitions to cite'));
    } else {
      items.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        if (i === this.selected) {
          btn.setAttribute('aria-selected', 'true');
          btn.style.background = 'rgba(0,0,0,0.08)';
        }
        const kind = document.createElement('span');
        kind.className = 'mm-cite-kind';
        kind.textContent = displayType(c.type);
        kind.style.fontWeight = '600';
        kind.style.marginRight = '0.5em';
        btn.append(kind);
        // The names, with the alias the query selects highlighted (cited on Enter); aliases `·`-separated.
        const chosen = bestMatch(c, st.query)?.handleId ?? null;
        if (c.names.length > 0) {
          const namesEl = document.createElement('span');
          namesEl.className = 'mm-cite-names';
          namesEl.style.marginRight = '0.5em';
          c.names.forEach((n, j) => {
            if (j > 0) namesEl.append(document.createTextNode(' · '));
            const span = document.createElement('span');
            const isMatch = n.id === chosen;
            span.className = isMatch ? 'mm-cite-match' : 'mm-cite-alias';
            span.textContent = n.name;
            span.style.fontWeight = isMatch ? '700' : '400'; // the alias the query selected, highlighted
            span.style.opacity = isMatch ? '1' : '0.55';
            namesEl.append(span);
          });
          btn.append(namesEl);
        }
        const name = document.createElement('span');
        name.className = 'mm-cite-name';
        name.textContent = c.snippet || '(empty)';
        name.style.opacity = '0.7';
        btn.append(name);
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep editor focus + selection until we commit
          this.commit(view, c);
        });
        dom.appendChild(btn);
      });
    }

    const coords = view.coordsAtPos(st.from);
    dom.style.left = `${window.scrollX + coords.left}px`;
    dom.style.top = `${window.scrollY + coords.bottom + 4}px`;
    dom.style.display = '';
  }

  private commit(view: EditorView, c: BlockCandidate): void {
    const st = findPickerState(view.state); // recompute against live state (no stale range)
    if (st) {
      const m = bestMatch(c, st.query); // the alias the current query selected (null → cite by number)
      const node = editorSchema.nodes.reference.create({
        // Fallback display text (used only if the live projection can't resolve the target/name); the
        // chosen NAME is shown reactively via `targetHandleId` (referenceLivePreview), else the number.
        text: m?.name ?? displayType(c.type),
        target: { kind: 'unit', object_id: this.selfId, unit_id: c.unitId },
        linkId: uuidv7(), // CLIENT-minted edge id; the core derives the Link from it (never mints one)
        targetHandleId: m?.handleId ?? null, // §6.3b: which authored name this cite chose (null = by number)
      });
      view.dispatch(view.state.tr.replaceWith(st.from, st.to, node));
    }
    this.close();
    view.focus();
  }

  private message(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mm-cite-message';
    el.style.padding = '0.25em 0.5em';
    el.style.opacity = '0.6';
    el.textContent = text;
    return el;
  }

  private ensureDom(): HTMLElement {
    if (!this.dom) {
      const el = document.createElement('div');
      el.className = 'mm-block-menu mm-cite-menu'; // reuse the block-menu chrome; cite-menu for future theming
      el.style.position = 'absolute';
      el.style.zIndex = '50';
      el.style.maxHeight = '16em';
      el.style.overflowY = 'auto';
      document.body.appendChild(el);
      this.dom = el;
    }
    return this.dom;
  }

  private hideDom(): void {
    if (this.dom) this.dom.style.display = 'none';
  }

  private close(): void {
    this.openFrom = null;
    this.dismissed = false;
    this.selected = 0;
    if (this.dom) {
      this.dom.remove();
      this.dom = null;
    }
  }

  destroy(): void {
    this.close();
  }
}

/** The `@`-citation picker plugin. `selfObjectId` is the current document's object id (the home of the
 *  blocks it lists). The plugin owns one `CitePickerView` per editor view; `handleKeyDown` routes
 *  navigation/commit keys to it only while a picker is open, so Enter/↑/↓/Esc fall through to the normal
 *  keymaps otherwise. Place this BEFORE the Enter/Arrow keymaps so it can pre-empt them while open. */
export function citePicker(opts: { selfObjectId: string }): Plugin {
  let instance: CitePickerView | null = null;
  return new Plugin({
    view() {
      instance = new CitePickerView(opts.selfObjectId);
      return {
        update: (view) => instance?.update(view),
        destroy: () => {
          instance?.destroy();
          instance = null;
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        return instance ? instance.onKeyDown(view, event) : false;
      },
    },
  });
}
