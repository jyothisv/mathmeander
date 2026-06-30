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
  applyHeadingCue,
  applyDisplayCue,
  splitLineOut,
  HEADING_CUE_RE,
  DISPLAY_CUE_RE,
  clearTypeAtStart,
  displayEnter,
  headingEnter,
  enterParagraph,
  exitTypedUnit,
  guardConfigMerge,
  guardConfigMergeForward,
  guardDisplayMerge,
  guardDisplayMergeForward,
  guardHeadingMergeForward,
  insertHardBreak,
  mergeIntoPrevious,
} from './cues';
import { headingRecognize } from './headingRecognize';
import { mathRecognize } from './mathRecognize';

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

describe('applyCue — `X[name].` captures an authored name into the `names` attr (§6.3b)', () => {
  it('strips the cue + name from the BODY and sets `names` (chrome, not body content)', () => {
    const text = 'Thm[Cauchy–Schwarz].';
    const s = stateWith(text, { cursor: text.length });
    const m = CUE_RE.exec(`${text} `)!;
    expect(m[2]).toBe('Cauchy–Schwarz');
    const next = s.apply(applyCue(s, m, 1, 1 + text.length)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('theorem');
    expect(next.doc.firstChild!.textContent).toBe(''); // the name never enters the body
    const names = next.doc.firstChild!.attrs.names as { id: string; name: string }[];
    expect(names.map((n) => n.name)).toEqual(['Cauchy–Schwarz']);
    expect(names[0]!.id).toMatch(/[0-9a-f-]{36}/); // a client-minted handle id
  });

  it('captures a NESTED-bracket name (`Def[C([0,1])]:`)', () => {
    const text = 'Def[C([0,1])]:';
    const s = stateWith(text, { cursor: text.length });
    const m = CUE_RE.exec(`${text} `)!;
    expect(m[2]).toBe('C([0,1])');
    const next = s.apply(applyCue(s, m, 1, 1 + text.length)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('definition');
    expect(next.doc.firstChild!.textContent).toBe('');
    expect((next.doc.firstChild!.attrs.names as { name: string }[])[0]!.name).toBe('C([0,1])');
  });

  it('a PLAIN cue (no brackets) leaves `names` empty', () => {
    const s = stateWith('Thm.', { cursor: 4 });
    const next = s.apply(applyCue(s, CUE_RE.exec('Thm. ')!, 1, 5)!);
    expect(next.doc.firstChild!.attrs.names).toEqual([]);
  });

  it('returns null inside a HEADING (the cue is literal there — review MINOR4)', () => {
    const block = editorSchema.nodes.prose.create(
      { unitId: 'h1', heading: true },
      editorSchema.text('Thm.'),
    );
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const s = EditorState.create({ schema: editorSchema, doc });
    expect(applyCue(s, CUE_RE.exec('Thm. ')!, 1, 5)).toBeNull();
  });
});

describe('clearTypeAtStart — peeling the type also clears names (review MINOR2)', () => {
  it('empties the `names` attr so the orphaned handles get dropped', () => {
    const block = editorSchema.nodes.prose.create(
      { unitId: 't1', unitType: 'theorem', names: [{ id: 'g1', name: 'Cauchy–Schwarz' }] },
      editorSchema.text('x'),
    );
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const s = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1))); // caret at block start
    const { ran, next } = capture(clearTypeAtStart, s);
    expect(ran).toBe(true);
    expect(next!.doc.firstChild!.attrs.unitType).toBeNull();
    expect(next!.doc.firstChild!.attrs.names).toEqual([]);
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

describe('displayEnter — multi-line display source + clean exit', () => {
  it('Enter at the END of a closed $$a$$ exits to a new plain unit (the equation stays intact)', () => {
    const { ran, next } = capture(displayEnter, stateWith('$$a$$'));
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(2); // equation block + a new block below
    expect(next!.doc.child(0).textContent).toBe('$$a$$'); // equation unchanged (still renders)
    expect(next!.doc.child(1).content.size).toBe(0); // new empty plain unit, caret there
  });

  it('Enter inside an OPEN $$ inserts a newline (hard_break), staying in the equation', () => {
    const { ran, next } = capture(displayEnter, stateWith('$$', { cursor: 2 }));
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(1); // no split — newline stays in the block
    expect(breaksIn(next!.doc.child(0))).toBe(1);
  });

  it('Enter at the end of a MULTI-LINE closed $$⏎a$$ exits (one block → two)', () => {
    const { ran, next } = capture(
      displayEnter,
      stateAtEnd([{ id: 'u1', lines: ['$$', 'a$$'] }], 0),
    );
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(1).content.size).toBe(0);
  });

  it('Enter inside a closed $$a$$ (caret not at end) inserts a newline — multi-line edit, no exit', () => {
    const { ran, next } = capture(displayEnter, stateWith('$$a$$', { cursor: 2 }));
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(1);
    expect(breaksIn(next!.doc.child(0))).toBe(1);
  });

  it('returns false for a non-display block (the normal paragraph Enter applies)', () => {
    expect(capture(displayEnter, stateWith('hello')).ran).toBe(false);
    expect(capture(displayEnter, stateWith('an $x$ inline')).ran).toBe(false); // inline math, not display
  });
});

describe('guardDisplayMerge — a display equation is atomic for block joins (Backspace/Delete)', () => {
  it('Backspace at the start of a paragraph BELOW an equation is swallowed (equation preserved)', () => {
    const s = stateAt(
      [
        { id: 'm', lines: ['$$x$$'] },
        { id: 'p', lines: ['para'] },
      ],
      1,
      0,
    );
    expect(guardDisplayMerge(s)).toBe(true); // → mergeIntoPrevious never runs, equation not dissolved
  });
  it('Backspace at the very start of the equation itself is swallowed', () => {
    const s = stateAt(
      [
        { id: 'p', lines: ['para'] },
        { id: 'm', lines: ['$$x$$'] },
      ],
      1,
      0,
    );
    expect(guardDisplayMerge(s)).toBe(true);
  });
  it('does NOT swallow a normal merge of two plain paragraphs', () => {
    const s = stateAt(
      [
        { id: 'a', lines: ['aaa'] },
        { id: 'b', lines: ['bbb'] },
      ],
      1,
      0,
    );
    expect(guardDisplayMerge(s)).toBe(false); // → mergeIntoPrevious handles it
  });
  it('does NOT swallow Backspace mid-source (offset > 0) — editing the equation source works', () => {
    const s = stateAt([{ id: 'm', lines: ['$$x$$'] }], 0, 2);
    expect(guardDisplayMerge(s)).toBe(false);
  });
  it('Delete at the end of a paragraph BEFORE an equation is swallowed (forward mirror)', () => {
    const s = stateAtEnd(
      [
        { id: 'p', lines: ['para'] },
        { id: 'm', lines: ['$$x$$'] },
      ],
      0,
    );
    expect(guardDisplayMergeForward(s)).toBe(true);
  });
  it('multi-line equation is also atomic (Backspace into a $$⏎a$$ block swallowed)', () => {
    const s = stateAt(
      [
        { id: 'm', lines: ['$$', 'a$$'] },
        { id: 'p', lines: ['x'] },
      ],
      1,
      0,
    );
    expect(guardDisplayMerge(s)).toBe(true);
  });
  it('refuses NON-destructively: Backspace moves the caret up into the equation, no merge', () => {
    const { ran, next } = capture(
      guardDisplayMerge,
      stateAt(
        [
          { id: 'm', lines: ['$$x$$'] },
          { id: 'p', lines: ['para'] },
        ],
        1,
        0,
      ),
    );
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(2); // both blocks intact — nothing dissolved
    expect(next!.selection.$head.parent.textContent).toBe('$$x$$'); // caret moved into the equation
  });
  it('guardDisplayMergeForward does NOT fire between two plain paragraphs (negative)', () => {
    const s = stateAtEnd(
      [
        { id: 'a', lines: ['aaa'] },
        { id: 'b', lines: ['bbb'] },
      ],
      0,
    );
    expect(guardDisplayMergeForward(s)).toBe(false);
  });
});

describe('§B section attrs on split / merge', () => {
  it('a body split inherits the section parentId (Enter in a section stays in it) — #1', () => {
    // A body block in section h1 with an empty trailing line; Enter there must spawn a unit that STAYS in
    // the section (parentId = h1), not escape to top-level (the pre-fix default).
    const block = editorSchema.nodes.prose.create({ unitId: 'b1', parentId: 'h1' }, [
      editorSchema.text('hello'),
      editorSchema.nodes.hard_break.create(),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, block.nodeSize - 1)), // end (empty line)
    );
    let captured: Transaction | null = null;
    enterParagraph(state, (tr) => {
      captured = tr;
    });
    expect(captured).not.toBeNull();
    const newDoc = captured!.doc;
    expect(newDoc.childCount).toBe(2);
    expect(newDoc.child(1).attrs.parentId).toBe('h1'); // stayed in the section
    expect(newDoc.child(1).attrs.heading).toBe(false); // a split never makes a heading
  });

  it('Backspace at a body start does NOT merge into a heading title — #4', () => {
    // h1 is a section heading; b1 is its first body unit. Backspace at b1's start must NOT join b1's text
    // into the title — it lands the caret at the title's end, non-destructively (no merge).
    const headingBlock = editorSchema.nodes.prose.create({ unitId: 'h1', heading: true }, [
      editorSchema.text('Title'),
    ]);
    const bodyBlock = editorSchema.nodes.prose.create({ unitId: 'b1', parentId: 'h1' }, [
      editorSchema.text('body'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [headingBlock, bodyBlock]);
    const base = EditorState.create({ schema: editorSchema, doc });
    // cursor at the start of b1 (just inside its open token)
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, headingBlock.nodeSize + 1)),
    );
    let captured: Transaction | null = null;
    const handled = mergeIntoPrevious(state, (tr) => {
      captured = tr;
    });
    expect(handled).toBe(true); // guarded (not a fall-through to a default join)
    // the doc is unchanged structurally — still two blocks, the title intact (no body text merged in)
    expect(captured!.doc.childCount).toBe(2);
    expect(captured!.doc.child(0).textContent).toBe('Title');
    expect(captured!.doc.child(1).textContent).toBe('body');
  });

  it('Backspace in an EMPTY body block after a heading DELETES it — #4b', () => {
    // Unlike a NON-empty body (refused above), an EMPTY body block is removed on Backspace (the normal
    // empty-block behavior), the caret landing at the title's end. The heading itself is untouched.
    const headingBlock = editorSchema.nodes.prose.create({ unitId: 'h1', heading: true }, [
      editorSchema.text('Title'),
    ]);
    const bodyBlock = editorSchema.nodes.prose.create({ unitId: 'b1', parentId: 'h1' }); // EMPTY
    const doc = editorSchema.nodes.doc.create(null, [headingBlock, bodyBlock]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, headingBlock.nodeSize + 1)),
    );
    let captured: Transaction | null = null;
    const handled = mergeIntoPrevious(state, (tr) => {
      captured = tr;
    });
    expect(handled).toBe(true);
    expect(captured!.doc.childCount).toBe(1); // the empty body is gone
    expect(captured!.doc.child(0).textContent).toBe('Title'); // heading intact
    expect(captured!.doc.child(0).attrs.heading as boolean).toBe(true);
  });

  it('Backspace at a heading START with an EMPTY previous block deletes it (heading moves up) — #5', () => {
    const emptyPrev = editorSchema.nodes.prose.create({ unitId: 'b0' }); // EMPTY block above the heading
    const headingBlock = editorSchema.nodes.prose.create({ unitId: 'h1', heading: true }, [
      editorSchema.text('Title'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [emptyPrev, headingBlock]);
    const base = EditorState.create({ schema: editorSchema, doc });
    // caret at the heading start (offset 0): just inside the heading's open token
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, emptyPrev.nodeSize + 1)),
    );
    let captured: Transaction | null = null;
    const handled = mergeIntoPrevious(state, (tr) => {
      captured = tr;
    });
    expect(handled).toBe(true);
    expect(captured!.doc.childCount).toBe(1); // the empty prev is gone — heading moved up
    expect(captured!.doc.child(0).attrs.heading as boolean).toBe(true); // heading PRESERVED (not demoted)
    expect(captured!.doc.child(0).textContent).toBe('Title');
  });

  it('Backspace at a heading START with a NON-empty previous block is swallowed (no merge/delete) — #5', () => {
    const prevBlock = editorSchema.nodes.prose.create({ unitId: 'b0' }, [
      editorSchema.text('prev'),
    ]);
    const headingBlock = editorSchema.nodes.prose.create({ unitId: 'h1', heading: true }, [
      editorSchema.text('Title'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [prevBlock, headingBlock]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, prevBlock.nodeSize + 1)),
    );
    let captured: Transaction | null = null;
    const handled = mergeIntoPrevious(state, (tr) => {
      captured = tr;
    });
    expect(handled).toBe(true); // swallowed
    expect(captured).toBeNull(); // nothing deleted, title not merged into the prev
  });
});

describe('§B headingEnter (Enter in a heading flows body under it)', () => {
  it('headingEnter spawns a body unit flowing UNDER the heading', () => {
    const block = editorSchema.nodes.prose.create({ unitId: 'h1', heading: true }, [
      editorSchema.text('Title'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, block.nodeSize - 1)),
    );
    let captured: Transaction | null = null;
    expect(headingEnter(state, (tr) => (captured = tr))).toBe(true);
    const newDoc = captured!.doc;
    expect(newDoc.childCount).toBe(2);
    expect(newDoc.child(0).attrs.heading).toBe(true);
    expect(newDoc.child(1).attrs.parentId).toBe('h1'); // body flows under the heading
    expect(newDoc.child(1).attrs.heading).toBe(false);
  });

  it('headingEnter returns false for a non-heading block (normal Enter runs)', () => {
    const s = stateWith('plain', { cursor: 5 });
    expect(headingEnter(s, () => {})).toBe(false);
  });
});

/** Fire an input-rule handler the way prosemirror-inputrules does: build `textBefore` (the parent's text up
 *  to the caret, leaf nodes as `￼`) + the just-typed char, run the regex, derive `start`/`end`, apply. */
function fireCue(
  state: EditorState,
  apply: (s: EditorState, m: RegExpMatchArray, start: number, end: number) => Transaction | null,
  re: RegExp,
  typed: string,
): { matched: boolean; next: EditorState | null } {
  const from = state.selection.from;
  const $from = state.doc.resolve(from);
  const textBefore =
    $from.parent.textBetween(
      Math.max(0, $from.parentOffset - 500),
      $from.parentOffset,
      undefined,
      '￼',
    ) + typed;
  const match = re.exec(textBefore);
  if (!match) return { matched: false, next: null };
  const start = from - (match[0].length - typed.length);
  const tr = apply(state, match, start, from);
  return { matched: true, next: tr ? state.apply(tr) : null };
}

/** A block source with `\n` per hard_break (text nodes ignore breaks in `textContent`). */
const blockSrc = (block: Node): string => {
  let s = '';
  block.forEach((c) => {
    if (c.isText) s += c.text ?? '';
    else if (c.type.name === 'hard_break') s += '\n';
  });
  return s;
};

describe('headingCueRule (`# ` on any line splits the line into its own block, keeps the `#`)', () => {
  it('at a BLOCK START it just keeps `# ` (no split) — headingRecognize promotes the whole block', () => {
    const { next } = fireCue(stateWith('#', { cursor: 1 }), applyHeadingCue, HEADING_CUE_RE, ' ');
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.textContent).toBe('# '); // the `#` is KEPT (Obsidian)
  });

  it('on a SOFT-LINE it splits the `# ` line off as its own block (anti-merge), keeping the head', () => {
    const { next } = fireCue(
      stateAtEnd([{ id: 'orig', lines: ['intro', '#'] }], 0),
      applyHeadingCue,
      HEADING_CUE_RE,
      ' ',
    );
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).attrs.unitId).toBe('orig'); // head keeps the original id
    expect(next!.doc.child(0).textContent).toBe('intro');
    expect(next!.doc.child(1).textContent).toBe('# '); // the heading line, on its own block, `#` kept
    expect(next!.doc.child(1).attrs.unitId).toBeNull(); // fresh (idStamper mints at runtime)
  });

  it('ANTI-ABSORPTION: a heading typed mid-block does NOT swallow the trailing line (3 blocks)', () => {
    // one block `line⏎#heading⏎after`, caret right after the `#` on line 2; typing the space must yield
    // [line][# heading][after] — the title NEVER absorbs `after`.
    const { next } = fireCue(
      stateAt([{ lines: ['line', '#heading', 'after'] }], 0, /* after the `#` on line 2 */ 6),
      applyHeadingCue,
      HEADING_CUE_RE,
      ' ',
    );
    expect(next!.doc.childCount).toBe(3);
    expect(next!.doc.child(0).textContent).toBe('line');
    expect(next!.doc.child(1).textContent).toBe('# heading');
    expect(next!.doc.child(2).textContent).toBe('after'); // peeled into its own block, not absorbed
  });

  it('a typed unit does NOT fire (its leading `#` is literal text)', () => {
    const { next } = fireCue(
      stateAtEnd([{ type: 'theorem', lines: ['x', '#'] }], 0),
      applyHeadingCue,
      HEADING_CUE_RE,
      ' ',
    );
    expect(next).toBeNull(); // handler returned null → default insertion (the `#` stays literal)
  });

  it('end-to-end with headingRecognize: a `# ` soft-line becomes a recognized top-level heading', () => {
    const doc = docOf([{ id: 'orig', lines: ['intro', '#'] }]);
    const base = EditorState.create({ schema: editorSchema, doc, plugins: [headingRecognize] });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, base.doc.child(0).content.size + 1)),
    );
    const { next } = fireCue(state, applyHeadingCue, HEADING_CUE_RE, ' ');
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(1).attrs.heading).toBe(true); // recognizer promoted the split-off line
    expect(next!.doc.child(1).attrs.parentId ?? null).toBeNull(); // a single `#` → top-level
  });
});

describe('displayCueRule (`$$…$$` on any line splits onto its own block)', () => {
  it('at a BLOCK START it just completes `$$x$$` (no split)', () => {
    const { next } = fireCue(
      stateWith('$$x$', { cursor: 4 }),
      applyDisplayCue,
      DISPLAY_CUE_RE,
      '$',
    );
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.textContent).toBe('$$x$$');
  });

  it('on a SOFT-LINE it splits the `$$x$$` onto its own block', () => {
    const { next } = fireCue(
      stateAtEnd([{ id: 'orig', lines: ['intro', '$$x$'] }], 0),
      applyDisplayCue,
      DISPLAY_CUE_RE,
      '$',
    );
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).textContent).toBe('intro');
    expect(next!.doc.child(1).textContent).toBe('$$x$$');
  });

  it('end-to-end with mathRecognize: the split-off `$$x$$` is marked a display equation', () => {
    const doc = docOf([{ id: 'orig', lines: ['intro', '$$x$'] }]);
    const base = EditorState.create({ schema: editorSchema, doc, plugins: [mathRecognize] });
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(base.doc, base.doc.child(0).content.size + 1)),
    );
    const { next } = fireCue(state, applyDisplayCue, DISPLAY_CUE_RE, '$');
    const eq = next!.doc.child(1);
    const mark = eq.firstChild!.marks.find((m) => m.type.name === 'mathExpr');
    expect(mark).toBeDefined();
    expect(mark!.attrs.display).toBe(true);
  });

  it('does NOT fire on `$$$$` (empty inner)', () => {
    expect(DISPLAY_CUE_RE.test('$$$$')).toBe(false);
  });

  it('does NOT fire on a whitespace-only inner `$$  $$`', () => {
    const m = DISPLAY_CUE_RE.exec('$$  $$')!;
    expect(applyDisplayCue(stateWith('$$  $', { cursor: 5 }), m, 1, 6)).toBeNull();
  });

  it('does NOT fire in a heading title (the `$$` stays literal)', () => {
    const block = editorSchema.nodes.prose.create({ unitId: 'h1', heading: true }, [
      editorSchema.text('$$x$'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 5)));
    const { next } = fireCue(state, applyDisplayCue, DISPLAY_CUE_RE, '$');
    expect(next).toBeNull();
  });
});

describe('§B heading is atomic for block joins (M3 backward / M4 forward)', () => {
  const heading = (id: string, text: string): Node =>
    editorSchema.nodes.prose.create({ unitId: id, heading: true }, [editorSchema.text(text)]);
  const body = (id: string, text: string): Node =>
    editorSchema.nodes.prose.create({ unitId: id }, [editorSchema.text(text)]);
  const stateAtDoc = (blocks: Node[], pos: number): EditorState => {
    const doc = editorSchema.nodes.doc.create(null, blocks);
    const base = EditorState.create({ schema: editorSchema, doc });
    return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
  };

  it('M3: Backspace at a heading START does NOT merge its title into the previous body block', () => {
    const b = body('b', 'body');
    const state = stateAtDoc([b, heading('h', '# Title')], b.nodeSize + 1); // caret at heading offset 0
    let tr: Transaction | null = null;
    const handled = mergeIntoPrevious(state, (t) => {
      tr = t;
    });
    expect(handled).toBe(true); // swallowed (heading is atomic) — caret stays, no merge
    expect(tr).toBeNull();
  });

  it('M4: Delete at a heading END does NOT pull the next block into the title', () => {
    const h = heading('h', '# Title');
    const state = stateAtDoc([h, body('b', 'body')], 1 + h.content.size); // caret at heading end
    const { ran, next } = capture(guardHeadingMergeForward, state);
    expect(ran).toBe(true);
    expect(next!.doc.childCount).toBe(2); // both blocks intact (no forward merge)
    expect(next!.doc.child(0).textContent).toBe('# Title');
    expect(next!.doc.child(1).textContent).toBe('body');
  });

  it('M4: guardHeadingMergeForward does NOT fire between two plain paragraphs (negative)', () => {
    const a = body('a', 'aaa');
    const state = stateAtDoc([a, body('b', 'bbb')], 1 + a.content.size);
    expect(guardHeadingMergeForward(state)).toBe(false);
  });
});

describe('splitLineOut helper (the shared two-way line peel)', () => {
  it('returns false when the line is already the whole block (nothing to peel)', () => {
    const s = stateWith('only one line', { cursor: 3 });
    const tr = s.tr;
    expect(splitLineOut(tr, s.selection.from)).toBe(false);
    expect(tr.steps.length).toBe(0);
  });

  it('peels both a head and a tail around the cursor line (3 blocks)', () => {
    const s = stateAt([{ lines: ['aa', 'bb', 'cc'] }], 0, 4); // caret inside "bb"
    const tr = s.tr;
    expect(splitLineOut(tr, s.selection.from)).toBe(true);
    const next = s.apply(tr);
    expect(next.doc.childCount).toBe(3);
    expect(blockSrc(next.doc.child(0))).toBe('aa');
    expect(blockSrc(next.doc.child(1))).toBe('bb');
    expect(blockSrc(next.doc.child(2))).toBe('cc');
  });
});

// A1 — the notation home (config block) is ATOMIC for block joins. Without these guards, Backspace/Delete at
// a config↔prose boundary falls through to baseKeymap's joinBackward/joinForward and merges prose text INTO
// the notation source (config `content:'text*'` absorbs it) or destroys the home — silent §2.2 loss.
describe('config (notation-home) join guards (A1)', () => {
  const cfg = (src: string): Node =>
    editorSchema.nodes.config.create(
      { unitId: 'c1', configFamily: 'notation' },
      src ? [editorSchema.text(src)] : [],
    );
  const para = (t: string): Node =>
    editorSchema.nodes.prose.create({ unitId: 'p1' }, t ? editorSchema.text(t) : undefined);

  /** A doc of the given blocks with the caret at the start (or end) of block `index`'s content. */
  function at(blocks: Node[], index: number, atEnd: boolean): EditorState {
    const doc = editorSchema.nodes.doc.create(null, blocks);
    let pos = 0;
    for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
    const block = doc.child(index);
    const caret = atEnd ? pos + block.nodeSize - 1 : pos + 1;
    const base = EditorState.create({ schema: editorSchema, doc });
    return base.apply(base.tr.setSelection(TextSelection.create(base.doc, caret)));
  }
  const run = (cmd: typeof guardConfigMerge, s: EditorState) => {
    let tr: Transaction | null = null;
    const ran = cmd(s, (t) => (tr = t));
    return { ran, tr: tr as Transaction | null };
  };

  it('Backspace at the start of prose AFTER a config block is guarded (no merge into source)', () => {
    const { ran, tr } = run(guardConfigMerge, at([cfg('Z* := X'), para('after')], 1, false));
    expect(ran).toBe(true); // handled → baseKeymap joinBackward never runs
    expect(tr!.doc.childCount).toBe(2); // both blocks intact — the prose was NOT absorbed
  });

  it('Backspace at the START of a config block is swallowed (atomic; home preserved)', () => {
    const { ran, tr } = run(guardConfigMerge, at([para('intro'), cfg('Z* := X')], 1, false));
    expect(ran).toBe(true);
    expect(tr).toBeNull(); // pure swallow, no join
  });

  it('Backspace mid-config is NOT guarded (normal char delete falls through)', () => {
    const s = at([cfg('Z* := X')], 0, true); // caret at the config source end (mid/end, not start)
    expect(run(guardConfigMerge, s).ran).toBe(false);
  });

  it('Delete at the END of a config block is swallowed (no forward pull-in)', () => {
    const { ran, tr } = run(guardConfigMergeForward, at([cfg('Z* := X'), para('after')], 0, true));
    expect(ran).toBe(true);
    expect(tr).toBeNull();
  });

  it('Delete at the END of prose BEFORE a config block is guarded (no merge into source)', () => {
    const { ran, tr } = run(guardConfigMergeForward, at([para('intro'), cfg('Z* := X')], 0, true));
    expect(ran).toBe(true);
    expect(tr!.doc.childCount).toBe(2);
  });
});
