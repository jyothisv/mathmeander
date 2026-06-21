// Math-mode key rules (mathKeys.ts) — pure, no DOM. Locks: inside a math node Enter/Tab/Esc exit and the
// arrows exit at the boundary; an empty node is removed by Backspace (and `$`-then-Esc leaves a literal `$`);
// in prose, Backspace-after / Delete-before a RENDERED FRESH equation OPENS its source (caret inside) rather
// than deleting it; the keystone guard (isFreshMath) keeps anchored exprs out of the inline-source path; and
// the prose-mode commands self-disable inside math.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { editorSchema } from './schema';
import {
  isFreshMath,
  mathExit,
  mathEscape,
  mathArrowLeft,
  mathArrowRight,
  mathBackspace,
  mathDelete,
  openMathBackward,
  openMathForward,
  dollarExit,
} from './mathKeys';
import { clearTypeAtStart, enterParagraph, insertHardBreak, mergeIntoPrevious } from './cues';

function mathNode(src: string, anchored = false): Node {
  const expr = {
    id: 'e1',
    surface_text: src,
    surface_format: 'mathmeander' as const,
    original_input: src,
    parse_status: 'renderable' as const,
    occurrences: anchored ? [{ selector: { start: 0, end: 1 } }] : [],
  };
  return editorSchema.nodes.inlineMath.create({ expr }, src ? editorSchema.text(src) : null);
}

/** A one-prose-block doc from the given inline nodes, caret at `pos`. */
function stateAt(inline: Node[], pos: number): EditorState {
  const doc = editorSchema.nodes.doc.create(null, [
    editorSchema.nodes.prose.create({ unitId: 'u1' }, inline),
  ]);
  const base = EditorState.create({ schema: editorSchema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
}

/** Run a command with a capturing dispatch → the resulting state (or null if unhandled). */
function run(cmd: Command, state: EditorState): EditorState | null {
  let tr: Transaction | null = null;
  const handled = cmd(state, (t) => {
    tr = t;
  });
  if (!handled) return null;
  return tr ? state.apply(tr) : state; // a handled no-dispatch command (shouldn't happen here)
}

function firstMath(doc: Node): Node | null {
  let m: Node | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'inlineMath') {
      m = n;
      return false;
    }
    return undefined;
  });
  return m;
}

// Positions for inline [text('ab'), math('x'), text('cd')]:
//  1..3 within "ab"; math node = [3,6] (4 = before 'x' / start, 5 = after 'x' / end); 6..8 within "cd".
const MIX = () => [editorSchema.text('ab'), mathNode('x'), editorSchema.text('cd')];

describe('isFreshMath (the keystone guard)', () => {
  it('is true for an expr with no occurrences, false for an anchored one', () => {
    expect(isFreshMath(mathNode('x'))).toBe(true);
    expect(isFreshMath(mathNode('x', true))).toBe(false);
    expect(isFreshMath(editorSchema.text('x'))).toBe(false);
  });
});

describe('exit gestures (caret inside math)', () => {
  it('mathExit moves the caret out after the node; no-op in prose', () => {
    const out = run(mathExit, stateAt(MIX(), 5)); // end of math source
    expect(out).not.toBeNull();
    expect(out!.selection.$from.parent.type.name).toBe('prose');
    expect(run(mathExit, stateAt(MIX(), 2))).toBeNull(); // inside "ab" → falls through
  });

  it('ArrowRight exits only at the source END', () => {
    expect(run(mathArrowRight, stateAt(MIX(), 5))).not.toBeNull(); // at end → exit
    expect(run(mathArrowRight, stateAt(MIX(), 4))).toBeNull(); // at start → move within (false)
  });

  it('ArrowLeft exits only at the source START', () => {
    expect(run(mathArrowLeft, stateAt(MIX(), 4))).not.toBeNull(); // at start → exit
    expect(run(mathArrowLeft, stateAt(MIX(), 5))).toBeNull(); // at end → move within (false)
  });

  it('Escape on an EMPTY node leaves a literal "$"; on a non-empty node it exits', () => {
    const empty = run(mathEscape, stateAt([mathNode('')], 2)); // empty math, caret inside
    expect(empty).not.toBeNull();
    expect(firstMath(empty!.doc)).toBeNull(); // the empty node is gone
    expect(empty!.doc.child(0).textContent).toBe('$'); // replaced by a literal dollar

    const nonEmpty = run(mathEscape, stateAt(MIX(), 5));
    expect(nonEmpty).not.toBeNull();
    expect(nonEmpty!.selection.$from.parent.type.name).toBe('prose');
    expect(firstMath(nonEmpty!.doc)).not.toBeNull(); // the math survives
  });

  it('Backspace removes an empty node; steps out of a non-empty one at its start', () => {
    const removed = run(mathBackspace, stateAt([mathNode('')], 2));
    expect(removed).not.toBeNull();
    expect(firstMath(removed!.doc)).toBeNull();

    // math('x') alone = [1,4]; pos 2 = source start, pos 3 = source end.
    const steppedOut = run(mathBackspace, stateAt([mathNode('x')], 2));
    expect(steppedOut).not.toBeNull();
    expect(steppedOut!.selection.$from.parent.type.name).toBe('prose');
    expect(firstMath(steppedOut!.doc)).not.toBeNull(); // a single Backspace does NOT delete a non-empty eqn

    // deleting the LAST char leaves an EMPTY, still-OPEN node with the caret inside (not a collapse)
    const emptied = run(mathBackspace, stateAt([mathNode('x')], 3)); // off 1, size 1 → delete-to-empty
    expect(emptied).not.toBeNull();
    const m = firstMath(emptied!.doc);
    expect(m).not.toBeNull();
    expect(m!.content.size).toBe(0); // emptied, but the node is kept
    expect(emptied!.selection.$from.parent.type.name).toBe('inlineMath'); // caret stays inside

    // with MORE than one char, a mid-source Backspace falls through to the native char delete.
    // mathNode('xy') = [1,5]; pos 3 = between x and y (off 1, size 2).
    expect(run(mathBackspace, stateAt([mathNode('xy')], 3))).toBeNull();
  });
});

describe('open gestures (caret in prose, adjacent to a rendered equation)', () => {
  it('Backspace right AFTER a fresh equation opens it (caret at source end)', () => {
    // [math('x'), text('y')]: math = [1,4]; caret at 4 sits right after it (before 'y').
    const out = run(openMathBackward, stateAt([mathNode('x'), editorSchema.text('y')], 4));
    expect(out).not.toBeNull();
    expect(out!.selection.$from.parent.type.name).toBe('inlineMath');
    expect(out!.selection.$from.parentOffset).toBe(1); // at the END of "x"
  });

  it('Delete right BEFORE a fresh equation opens it (caret at source start)', () => {
    // [text('y'), math('x')]: 'y' = [1,2]; math = [2,5]; caret at 2 sits right before the math.
    const out = run(openMathForward, stateAt([editorSchema.text('y'), mathNode('x')], 2));
    expect(out).not.toBeNull();
    expect(out!.selection.$from.parent.type.name).toBe('inlineMath');
    expect(out!.selection.$from.parentOffset).toBe(0); // at the START of "x"
  });

  it('does NOT open an ANCHORED equation (the keystone guard)', () => {
    expect(
      run(openMathBackward, stateAt([mathNode('x', true), editorSchema.text('y')], 4)),
    ).toBeNull();
  });

  it('is inert when the caret is not adjacent to math', () => {
    expect(run(openMathBackward, stateAt([editorSchema.text('ab')], 2))).toBeNull();
    expect(run(openMathForward, stateAt([editorSchema.text('ab')], 1))).toBeNull();
  });
});

describe('prose-mode commands self-disable inside math', () => {
  it('Enter/Backspace-merge/clear-type/hard-break all no-op when the caret is inside a math node', () => {
    const inside = stateAt([mathNode('x')], 2); // caret inside the math source
    expect(enterParagraph(inside, () => {})).toBe(false);
    expect(mergeIntoPrevious(inside, () => {})).toBe(false);
    expect(clearTypeAtStart(inside, () => {})).toBe(false);
    expect(insertHardBreak(inside, () => {})).toBe(false);
  });
});

describe('mathDelete (forward-delete symmetry)', () => {
  it('deleting the last char (caret before the only char) leaves an empty-open node, caret inside', () => {
    // math('x') = [1,4]; pos 2 = before 'x' (off 0, size 1) → forward-delete empties it.
    const out = run(mathDelete, stateAt([mathNode('x')], 2));
    expect(out).not.toBeNull();
    const m = firstMath(out!.doc);
    expect(m).not.toBeNull();
    expect(m!.content.size).toBe(0); // emptied, node kept
    expect(out!.selection.$from.parent.type.name).toBe('inlineMath'); // caret stays inside
  });

  it('at the END of the source → steps out after the node', () => {
    const out = run(mathDelete, stateAt(MIX(), 5)); // end of "x" in [ab][x][cd]
    expect(out).not.toBeNull();
    expect(out!.selection.$from.parent.type.name).toBe('prose');
    expect(firstMath(out!.doc)).not.toBeNull(); // the equation survives
  });

  it('removes an empty node', () => {
    const out = run(mathDelete, stateAt([mathNode('')], 2));
    expect(out).not.toBeNull();
    expect(firstMath(out!.doc)).toBeNull();
  });

  it('with >1 char, a mid-source Delete falls through to the native forward delete', () => {
    // math('xy') = [1,5]; pos 3 = between x and y (off 1, size 2).
    expect(run(mathDelete, stateAt([mathNode('xy')], 3))).toBeNull();
  });
});

describe('dollarExit ($ typed inside math)', () => {
  function runDollar(state: EditorState, text = '$'): EditorState | null {
    let tr: Transaction | null = null;
    const view = {
      state,
      dispatch: (t: Transaction) => {
        tr = t;
      },
    } as unknown as EditorView;
    if (!dollarExit(view, 0, 0, text)) return null;
    return tr ? state.apply(tr) : state;
  }

  it('on an EMPTY node, `$` leaves a literal dollar sign (the `$`-then-`$` escape hatch)', () => {
    const out = runDollar(stateAt([mathNode('')], 2));
    expect(out).not.toBeNull();
    expect(firstMath(out!.doc)).toBeNull(); // the empty node is gone
    expect(out!.doc.child(0).textContent).toBe('$'); // replaced by a literal dollar
  });

  it('on a non-empty node, `$` exits after the node (the closing delimiter)', () => {
    const out = runDollar(stateAt(MIX(), 5)); // end of "x"
    expect(out).not.toBeNull();
    expect(out!.selection.$from.parent.type.name).toBe('prose');
    expect(firstMath(out!.doc)).not.toBeNull(); // the math survives
  });

  it('is inert for a non-`$` char, and outside math', () => {
    expect(runDollar(stateAt(MIX(), 5), 'a')).toBeNull(); // not a `$`
    expect(runDollar(stateAt(MIX(), 2))).toBeNull(); // caret in prose ("ab")
  });
});
