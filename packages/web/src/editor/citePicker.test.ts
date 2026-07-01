// Pure unit tests for the `@`-citation picker's derivation (citePicker.ts) — no DOM. Locks: the picker
// opens only for an `@word` at a word boundary (block start or after whitespace) with the cursor at its
// end (so an email's `a@b` never triggers); the reported `from`/`to`/`query` map to doc positions; and
// the candidate ranking (substring, earlier = higher, empty query keeps all).
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { editorSchema } from './schema';
import { findPickerState, score, bestMatch, localBlocks, type BlockCandidate } from './citePicker';

/** A single prose block; `cursor` is a code-point offset within the block (doc pos = 1 + cursor). */
function stateWith(text: string, cursor: number = text.length): EditorState {
  const block = editorSchema.nodes.prose.create(
    { unitId: 'u1' },
    text ? editorSchema.text(text) : undefined,
  );
  const doc = editorSchema.nodes.doc.create(null, [block]);
  const base = EditorState.create({ schema: editorSchema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1 + cursor)));
}

describe('findPickerState', () => {
  it('opens for `@` at the block start', () => {
    const st = findPickerState(stateWith('@cau'));
    expect(st).not.toBeNull();
    expect(st!.query).toBe('cau');
    expect(st!.from).toBe(1); // doc pos of the `@`
    expect(st!.to).toBe(5); // cursor after "@cau"
  });

  it('opens for `@` after whitespace', () => {
    const st = findPickerState(stateWith('see @comp'));
    expect(st!.query).toBe('comp');
    expect(st!.from).toBe(5); // "see " = 4 chars → `@` at offset 4 → doc pos 5
    expect(st!.to).toBe(10);
  });

  it('opens with an empty query right after a bare `@`', () => {
    const st = findPickerState(stateWith('a @'));
    expect(st).not.toBeNull();
    expect(st!.query).toBe('');
  });

  it('does NOT open for an email (`@` not at a word boundary)', () => {
    expect(findPickerState(stateWith('mail me alice@example'))).toBeNull();
  });

  it('does NOT open once a space breaks the query', () => {
    expect(findPickerState(stateWith('@cau chy'))).toBeNull();
  });

  it('does NOT open when the cursor is not at the query end', () => {
    // cursor sits inside "see " (offset 2), before the `@`
    expect(findPickerState(stateWith('see @comp', 2))).toBeNull();
  });

  it('tracks the LAST `@` when several are present', () => {
    const st = findPickerState(stateWith('@a and @b'));
    expect(st!.query).toBe('b');
    expect(st!.from).toBe(8); // "@a and " = 7 chars → `@` at offset 7 → doc pos 8
  });

  it('opens for `@` at the start of a SOFT (2nd) line (right after a hard_break)', () => {
    const block = editorSchema.nodes.prose.create({ unitId: 'u1' }, [
      editorSchema.text('line1'),
      editorSchema.nodes.hard_break.create(),
      editorSchema.text('@cau'),
    ]);
    const doc = editorSchema.nodes.doc.create(null, [block]);
    const base = EditorState.create({ schema: editorSchema, doc });
    const st = findPickerState(base.apply(base.tr.setSelection(TextSelection.atEnd(base.doc))));
    expect(st).not.toBeNull();
    expect(st!.query).toBe('cau');
  });
});

describe('score', () => {
  const thm: BlockCandidate = {
    unitId: '1',
    type: 'theorem',
    snippet: 'a statement',
    names: [{ id: 'h1', name: 'Cauchy–Schwarz' }],
  };

  it('keeps everything for an empty query', () => {
    expect(score(thm, '')).toBeGreaterThan(0);
  });

  it('matches a name case-insensitively, earlier = higher', () => {
    expect(score(thm, 'cau')).toBeGreaterThan(score(thm, 'schwarz'));
  });

  it('matches the kind too', () => {
    expect(score(thm, 'theorem')).toBeGreaterThan(0);
  });

  it('returns < 0 for no match', () => {
    expect(score(thm, 'zzz')).toBeLessThan(0);
  });
});

describe('bestMatch — the alias a query selects within a unit', () => {
  const def: BlockCandidate = {
    unitId: 'd1',
    type: 'definition',
    snippet: 'a set is …',
    names: [
      { id: 'a', name: 'open set' },
      { id: 'b', name: 'clopen' },
    ],
  };

  it('empty query → the primary (min-by-id)', () => {
    expect(bestMatch(def, '')).toEqual({ handleId: 'a', name: 'open set' });
  });
  it('picks the alias with the earliest substring match', () => {
    expect(bestMatch(def, 'clo')).toEqual({ handleId: 'b', name: 'clopen' });
    expect(bestMatch(def, 'open')).toEqual({ handleId: 'a', name: 'open set' }); // "open" is earlier in "open set"
  });
  it('no name matches → falls back to the primary', () => {
    expect(bestMatch(def, 'zzz')).toEqual({ handleId: 'a', name: 'open set' });
  });
  it('an unnamed unit → null (cite by number)', () => {
    expect(bestMatch({ unitId: 't', type: 'theorem', snippet: 's', names: [] }, 'x')).toBeNull();
  });
});

describe('localBlocks', () => {
  /** A doc of prose blocks with the cursor placed in the LAST block. */
  function docState(
    blocks: Array<{ unitId: string; unitType: string | null; text: string }>,
  ): EditorState {
    const nodes = blocks.map((b) =>
      editorSchema.nodes.prose.create(
        { unitId: b.unitId, unitType: b.unitType },
        b.text ? editorSchema.text(b.text) : undefined,
      ),
    );
    const doc = editorSchema.nodes.doc.create(null, nodes);
    let off = 0;
    for (let i = 0; i < nodes.length - 1; i++) off += nodes[i]!.nodeSize;
    const base = EditorState.create({ schema: editorSchema, doc });
    return base.apply(base.tr.setSelection(TextSelection.near(base.doc.resolve(off + 1), 1)));
  }

  it('lists typed blocks, excluding plain blocks and the block the caret is in', () => {
    const st = docState([
      { unitId: 't1', unitType: 'theorem', text: 'For all x, P(x).' },
      { unitId: 'p1', unitType: null, text: 'just prose' },
      { unitId: 'd1', unitType: 'definition', text: 'A set is open if…' },
      { unitId: 'cur', unitType: 'theorem', text: 'current block' }, // caret here → excluded
    ]);
    const blocks = localBlocks(st);
    expect(blocks.map((b) => b.unitId)).toEqual(['t1', 'd1']); // typed, minus the current + the plain
    expect(blocks[0]!.type).toBe('theorem');
    expect(blocks[0]!.snippet).toBe('For all x, P(x).');
  });
});
