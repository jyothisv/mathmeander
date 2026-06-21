// Pure unit tests for the cue + paragraph-model keystroke layer (cues.ts) — no DOM (prosemirror-state/
// model run in node). Locks: cues fire at a line start (unit start re-types; a soft-line start spawns a new
// typed unit); the paragraph model (single Enter = soft line; blank line = new unit in plain prose but a
// paragraph break inside a typed unit; a 2nd consecutive blank exits a typed unit); ⌘Enter exits; Backspace
// clears a type (peel) and soft-break-merges a plain unit; Shift-Enter never splits.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { chainCommands } from 'prosemirror-commands';
import type { Node } from 'prosemirror-model';
import { editorSchema } from './schema';
import {
  CUE_MAP,
  CUE_RE,
  applyCue,
  clearTypeAtStart,
  enterParagraph,
  exitTypedUnit,
  insertHardBreak,
  mergeIntoPrevious,
} from './cues';

/** A single-prose-block doc; `cursor` is a code-point offset within the block (doc pos = 1 + cursor). */
function stateWith(text: string, opts: { type?: string; cursor?: number } = {}): EditorState {
  const block = editorSchema.nodes.prose.create(
    { unitId: 'u1', unitType: opts.type ?? null },
    text ? editorSchema.text(text) : undefined,
  );
  const doc = editorSchema.nodes.doc.create(null, [block]);
  const base = EditorState.create({ schema: editorSchema, doc });
  const cursor = opts.cursor ?? text.length;
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1 + cursor)));
}

/** Build a multi-block doc; each block's `lines` join with `hard_break`s (within-unit soft breaks). */
function docOf(blocks: Array<{ id?: string; type?: string; lines: string[] }>): Node {
  const nodes = blocks.map((b) => {
    const inline: Node[] = [];
    b.lines.forEach((line, i) => {
      if (i > 0) inline.push(editorSchema.nodes.hard_break.create());
      if (line.length) inline.push(editorSchema.text(line));
    });
    return editorSchema.nodes.prose.create(
      { unitId: b.id ?? 'u', unitType: b.type ?? null },
      inline,
    );
  });
  return editorSchema.nodes.doc.create(null, nodes);
}

/** Absolute position of content-offset `o` within block index `i`. */
function posInBlock(doc: Node, i: number, o: number): number {
  let p = 0;
  for (let k = 0; k < i; k++) p += doc.child(k).nodeSize;
  return p + 1 + o; // +1 for the block's open token
}

function stateAt(
  blocks: Array<{ id?: string; type?: string; lines: string[] }>,
  i: number,
  o: number,
): EditorState {
  const doc = docOf(blocks);
  const base = EditorState.create({ schema: editorSchema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, posInBlock(doc, i, o))));
}

/** Cursor at the very end of block `i`'s content. */
function stateAtEnd(
  blocks: Array<{ id?: string; type?: string; lines: string[] }>,
  i: number,
): EditorState {
  return stateAt(blocks, i, docOf(blocks).child(i).content.size);
}

function capture(cmd: (s: EditorState, d?: (tr: Transaction) => void) => boolean, s: EditorState) {
  let tr: Transaction | null = null;
  const ran = cmd(s, (t) => {
    tr = t;
  });
  return { ran, next: tr ? s.apply(tr) : null };
}

const breaksIn = (block: Node): number => {
  let n = 0;
  block.forEach((c) => {
    if (c.type.name === 'hard_break') n += 1;
  });
  return n;
};

describe('CUE_RE / CUE_MAP', () => {
  it('matches each cue word with `.` or `:` + a trailing space, at a line start', () => {
    for (const word of Object.keys(CUE_MAP)) {
      expect(CUE_RE.test(`${word}. `)).toBe(true);
      expect(CUE_RE.test(`${word}: `)).toBe(true);
      expect(CUE_RE.test(`line￼${word}. `)).toBe(true); // after a within-unit break = a line start
    }
  });
  it('is case-sensitive and rejects near-misses / mid-line', () => {
    expect(CUE_RE.test('thm. ')).toBe(false); // lowercase
    expect(CUE_RE.test('Thmx. ')).toBe(false); // extra letter
    expect(CUE_RE.test('Thm.')).toBe(false); // no trailing space
    expect(CUE_RE.test('a Thm. ')).toBe(false); // mid-line (preceded by a space, not a break)
  });
});

describe('applyCue — unit start re-types; soft-line start spawns a typed unit', () => {
  // PM passes the doc range of the match EXCLUDING the not-yet-inserted trigger space.
  const m = CUE_RE.exec('Thm. ')!;

  it('strips the cue + sets the type, leaving an empty block (cue into an empty block)', () => {
    const s = stateWith('Thm.', { cursor: 4 });
    const next = s.apply(applyCue(s, m, 1, 5)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('theorem');
    expect(next.doc.firstChild!.textContent).toBe('');
  });

  it('does NOT eat the first content char when the cue is typed BEFORE existing content', () => {
    const s = stateWith('Thm.hello', { cursor: 4 });
    const next = s.apply(applyCue(s, m, 1, 5)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('theorem');
    expect(next.doc.firstChild!.textContent).toBe('hello'); // "h" intact — the prepend guard
  });

  it('RE-TYPES an already-typed unit (Def: at the start of a theorem → a definition)', () => {
    const md = CUE_RE.exec('Def. ')!;
    const s = stateWith('Def.theorem body', { type: 'theorem', cursor: 4 });
    const next = s.apply(applyCue(s, md, 1, 5)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('definition');
    expect(next.doc.firstChild!.textContent).toBe('theorem body');
  });

  it('SPLITS off a new typed unit when a cue is typed at a soft-line start (mid-block)', () => {
    // doc: one block "line1"⏎"Def:"  (cursor after "Def:"). PM passes start at the hard_break.
    const s = stateAtEnd([{ id: 'orig', lines: ['line1', 'Def:'] }], 0);
    const md = CUE_RE.exec('line1￼Def: ')!;
    const start = s.selection.head - 5; // hard_break(1) + "Def:"(4)
    const end = s.selection.head;
    const next = s.apply(applyCue(s, md, start, end)!);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).attrs.unitId).toBe('orig'); // first unit keeps its id
    expect(next.doc.child(0).attrs.unitType).toBeNull();
    expect(next.doc.child(0).textContent).toBe('line1');
    expect(next.doc.child(1).attrs.unitType).toBe('definition'); // new typed unit
    expect(next.doc.child(1).attrs.unitId).toBeNull(); // fresh id (stamped by idStamper at runtime)
    expect(next.doc.child(1).textContent).toBe(''); // cue stripped; line had no other text
  });

  it('returns null for a cue after an inline atom (mid-line, not a line start)', () => {
    // a reference atom then "Def:" on the same line → ￼ in the match text but nodeAfter is not a break
    const block = editorSchema.nodes.prose.create({ unitId: 'u' }, [
      editorSchema.nodes.reference.create({ text: 'r' }),
      editorSchema.text('Def:'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const s = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, base.doc.content.size - 1)),
    );
    const md = CUE_RE.exec('￼Def: ')!;
    expect(applyCue(s, md, s.selection.head - 5, s.selection.head)).toBeNull();
  });
});

describe('enterParagraph — the paragraph model', () => {
  it('plain, non-empty line → a soft line break (stays one unit)', () => {
    const { ran, next } = capture(enterParagraph, stateAtEnd([{ lines: ['abc'] }], 0));
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(1);
    expect(breaksIn(next!.doc.child(0))).toBe(1);
  });

  it('plain, empty line (blank line) → a NEW plain unit with a different id', () => {
    const { next } = capture(enterParagraph, stateAtEnd([{ id: 'a', lines: ['abc', ''] }], 0));
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).attrs.unitId).toBe('a');
    expect(next!.doc.child(0).textContent).toBe('abc');
    expect(breaksIn(next!.doc.child(0))).toBe(0); // trailing blank stripped
    expect(next!.doc.child(1).attrs.unitId).toBeNull(); // fresh id at runtime
    expect(next!.doc.child(1).attrs.unitType).toBeNull();
  });

  it('typed, non-empty line → a soft line break (stays)', () => {
    const { next } = capture(enterParagraph, stateAtEnd([{ type: 'proof', lines: ['step'] }], 0));
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).attrs.unitType).toBe('proof');
    expect(breaksIn(next!.doc.child(0))).toBe(1);
  });

  it('typed, single blank line → a paragraph break, STAYS one multi-paragraph unit', () => {
    const { next } = capture(
      enterParagraph,
      stateAtEnd([{ type: 'proof', lines: ['para1', ''] }], 0),
    );
    expect(next!.doc.childCount).toBe(1); // still one proof
    expect(next!.doc.child(0).attrs.unitType).toBe('proof');
    expect(breaksIn(next!.doc.child(0))).toBe(2); // a blank line (two breaks)
  });

  it('typed, 2nd consecutive blank line → EXIT to a new plain unit', () => {
    const { next } = capture(
      enterParagraph,
      stateAtEnd([{ id: 'p', type: 'proof', lines: ['para1', '', ''] }], 0),
    );
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).attrs.unitType).toBe('proof');
    expect(next!.doc.child(0).attrs.unitId).toBe('p');
    expect(next!.doc.child(0).textContent).toBe('para1');
    expect(breaksIn(next!.doc.child(0))).toBe(0); // trailing blanks stripped
    expect(next!.doc.child(1).attrs.unitType).toBeNull(); // new unit is plain
    expect(next!.doc.child(1).attrs.unitId).toBeNull();
  });
});

describe('insertHardBreak (Shift-Enter) — never splits/exits', () => {
  it('on an empty line in a plain unit, stays one unit', () => {
    const { next } = capture(insertHardBreak, stateAtEnd([{ lines: ['abc', ''] }], 0));
    expect(next!.doc.childCount).toBe(1);
    expect(breaksIn(next!.doc.child(0))).toBe(2);
  });
  it('on a 2nd blank line in a typed unit, stays one unit (no exit)', () => {
    const { next } = capture(
      insertHardBreak,
      stateAtEnd([{ type: 'proof', lines: ['p', '', ''] }], 0),
    );
    expect(next!.doc.childCount).toBe(1);
  });
});

describe('exitTypedUnit (⌘Enter)', () => {
  it('at the end → a new plain unit; the original keeps its id + type', () => {
    const { ran, next } = capture(
      exitTypedUnit,
      stateAtEnd([{ id: 't', type: 'theorem', lines: ['T'] }], 0),
    );
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).attrs.unitId).toBe('t');
    expect(next!.doc.child(0).attrs.unitType).toBe('theorem');
    expect(next!.doc.child(1).attrs.unitType).toBeNull();
    expect(next!.doc.child(1).attrs.unitId).toBeNull();
  });
  it('mid-content → content after the cursor moves into the new plain unit', () => {
    const { next } = capture(
      exitTypedUnit,
      stateAt([{ type: 'theorem', lines: ['abcdef'] }], 0, 3),
    );
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).textContent).toBe('abc');
    expect(next!.doc.child(1).textContent).toBe('def');
    expect(next!.doc.child(1).attrs.unitType).toBeNull();
  });
});

describe('clearTypeAtStart (Backspace peel)', () => {
  it('at a typed unit start: clears the type and KEEPS the text', () => {
    const { ran, next } = capture(
      clearTypeAtStart,
      stateWith('Hello', { type: 'definition', cursor: 0 }),
    );
    expect(ran).toBe(true);
    expect(next!.doc.firstChild!.attrs.unitType).toBeNull();
    expect(next!.doc.firstChild!.textContent).toBe('Hello');
  });
  it('returns false when not at offset 0', () => {
    expect(clearTypeAtStart(stateWith('Hello', { type: 'definition', cursor: 1 }), () => {})).toBe(
      false,
    );
  });
  it('returns false on an untyped block', () => {
    expect(clearTypeAtStart(stateWith('Hello', { cursor: 0 }), () => {})).toBe(false);
  });
});

describe('mergeIntoPrevious (Backspace soft-break join)', () => {
  it('plain B at offset 0 → merges into plain A with a soft break; A’s id survives', () => {
    const { ran, next } = capture(
      mergeIntoPrevious,
      stateAt(
        [
          { id: 'a', lines: ['Hello'] },
          { id: 'b', lines: ['World'] },
        ],
        1,
        0,
      ),
    );
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).attrs.unitId).toBe('a');
    expect(breaksIn(next!.doc.child(0))).toBe(1); // soft-break join, not a raw concat
    expect(next!.doc.child(0).textContent).toBe('HelloWorld'); // text nodes "Hello","World" around the break
  });

  it('returns false in a TYPED unit (clearTypeAtStart peels first)', () => {
    expect(
      mergeIntoPrevious(
        stateAt(
          [
            { id: 'a', lines: ['Hello'] },
            { id: 'b', type: 'theorem', lines: ['World'] },
          ],
          1,
          0,
        ),
        () => {},
      ),
    ).toBe(false);
  });

  it('returns false at the first unit (nothing before)', () => {
    expect(mergeIntoPrevious(stateAt([{ lines: ['only'] }], 0, 0), () => {})).toBe(false);
  });

  it('Backspace chain: typed B peels (1st press), then merges as plain (2nd press)', () => {
    const back = chainCommands(clearTypeAtStart, mergeIntoPrevious);
    const s0 = stateAt(
      [
        { id: 'a', lines: ['Hello'] },
        { id: 'b', type: 'theorem', lines: ['World'] },
      ],
      1,
      0,
    );
    const r1 = capture(back, s0); // clears B's type, keeps two units
    expect(r1.ran).toBe(true);
    expect(r1.next!.doc.childCount).toBe(2);
    expect(r1.next!.doc.child(1).attrs.unitType).toBeNull();
    // re-seat the cursor at B's start and press again → merge
    const s1 = r1.next!.apply(
      r1.next!.tr.setSelection(TextSelection.create(r1.next!.doc, posInBlock(r1.next!.doc, 1, 0))),
    );
    const r2 = capture(back, s1);
    expect(r2.ran).toBe(true);
    expect(r2.next!.doc.childCount).toBe(1);
    expect(r2.next!.doc.child(0).attrs.unitId).toBe('a');
  });
});
