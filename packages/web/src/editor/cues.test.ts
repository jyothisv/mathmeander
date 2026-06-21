// Pure unit tests for the cue-recognition layer (cues.ts) — no DOM (prosemirror-state/model run in node).
// Locks: each cue recognized at block start only; the strip+set-type transform; Backspace-at-start clears
// the type WITHOUT deleting text (the issue-2 guard); Enter stays in a typed block but splits a plain one.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { editorSchema } from './schema';
import {
  CUE_MAP,
  CUE_RE,
  applyCue,
  clearTypeAtStart,
  enterInTypedBlock,
  insertHardBreak,
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

function capture(cmd: (s: EditorState, d?: (tr: Transaction) => void) => boolean, s: EditorState) {
  let tr: Transaction | null = null;
  const ran = cmd(s, (t) => {
    tr = t;
  });
  return { ran, next: tr ? s.apply(tr) : null };
}

describe('CUE_RE / CUE_MAP', () => {
  it('matches each cue word with `.` or `:` + a trailing space, at block start', () => {
    for (const word of Object.keys(CUE_MAP)) {
      expect(CUE_RE.test(`${word}. `)).toBe(true);
      expect(CUE_RE.test(`${word}: `)).toBe(true);
    }
  });
  it('is case-sensitive and rejects near-misses', () => {
    expect(CUE_RE.test('thm. ')).toBe(false); // lowercase
    expect(CUE_RE.test('Thmx. ')).toBe(false); // extra letter
    expect(CUE_RE.test('Thm.')).toBe(false); // no trailing space
    expect(CUE_RE.test('a Thm. ')).toBe(false); // not at start
  });
});

describe('applyCue (real input-rule timing — the trigger char is NOT yet in the doc)', () => {
  // PM matches `textBefore + text` = "Thm. " but the doc holds only "Thm." when the rule fires; it passes
  // start = cursor − (match.length − textLen) = 1 and end = cursor = 5. The space is consumed by the rule.
  const m = CUE_RE.exec('Thm. ')!;

  it('strips the cue + sets the type, leaving an empty block (cue into an empty block)', () => {
    const s = stateWith('Thm.', { cursor: 4 });
    const next = s.apply(applyCue(s, m, 1, 5)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('theorem');
    expect(next.doc.firstChild!.textContent).toBe('');
  });

  it('does NOT eat the first content char when the cue is typed BEFORE existing content', () => {
    const s = stateWith('Thm.hello', { cursor: 4 }); // cursor between "Thm." and "hello"
    const next = s.apply(applyCue(s, m, 1, 5)!);
    expect(next.doc.firstChild!.attrs.unitType).toBe('theorem');
    expect(next.doc.firstChild!.textContent).toBe('hello'); // "h" intact — the prepend bug
  });

  it('returns null when not at block start', () => {
    const s = stateWith('x Thm.', { cursor: 6 });
    expect(applyCue(s, m, 3, 7)).toBeNull(); // start (3) is not block-start → no cue
  });
});

describe('clearTypeAtStart (the issue-2 guard)', () => {
  it('at a typed block start: clears the type and KEEPS the text', () => {
    const { ran, next } = capture(
      clearTypeAtStart,
      stateWith('Hello', { type: 'definition', cursor: 0 }),
    );
    expect(ran).toBe(true);
    expect(next!.doc.firstChild!.attrs.unitType).toBeNull();
    expect(next!.doc.firstChild!.textContent).toBe('Hello'); // first letter NOT deleted
  });
  it('returns false when not at offset 0 (so normal backspace deletes a char)', () => {
    expect(clearTypeAtStart(stateWith('Hello', { type: 'definition', cursor: 1 }), () => {})).toBe(
      false,
    );
  });
  it('returns false on an untyped block', () => {
    expect(clearTypeAtStart(stateWith('Hello', { cursor: 0 }), () => {})).toBe(false);
  });
});

describe('enterInTypedBlock', () => {
  it('inserts a hard_break in a typed block (stays one unit)', () => {
    const { ran, next } = capture(
      enterInTypedBlock,
      stateWith('Hi', { type: 'theorem', cursor: 2 }),
    );
    expect(ran).toBe(true);
    const kinds = [] as string[];
    next!.doc.firstChild!.forEach((n) => kinds.push(n.type.name));
    expect(kinds).toContain('hard_break'); // a line break, not a new block
    expect(next!.doc.childCount).toBe(1); // still one block
  });
  it('returns false in a plain block (so baseKeymap splits it)', () => {
    expect(enterInTypedBlock(stateWith('Hi', { cursor: 2 }), () => {})).toBe(false);
  });
});

describe('insertHardBreak', () => {
  it('inserts a hard_break anywhere', () => {
    const { ran, next } = capture(insertHardBreak, stateWith('Hi', { cursor: 1 }));
    expect(ran).toBe(true);
    const kinds = [] as string[];
    next!.doc.firstChild!.forEach((n) => kinds.push(n.type.name));
    expect(kinds).toContain('hard_break');
  });
});
