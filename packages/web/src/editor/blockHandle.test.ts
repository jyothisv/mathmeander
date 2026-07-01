// blockHandle: a ⋮⋮ gutter handle. It is a HOVER-TRACKED OVERLAY in <body> (managed in the plugin's
// `view()`), NOT a per-block widget decoration — a block-START widget sits at the caret position and hits a
// browser-level ProseMirror caret bug (#1061) that SCRAMBLED text typed at a block start (a block-opening
// `$…$` equation never recognized). The hover/positioning/menu are DOM-level (manual/e2e — see
// e2e/tests/journal-math.spec.ts, which now passes block-start equations). Here we lock the design invariant
// that prevents a regression back into the bug.
import { describe, expect, it } from 'vitest';
import { blockHandle } from './blockHandle';

describe('blockHandle', () => {
  it('injects NO document decoration — it is an out-of-flow overlay, never a block-start widget (PM #1061)', () => {
    // A per-block `Decoration.widget(offset+1, …)` is exactly what corrupted block-start typing. Guard that
    // the plugin exposes no `decorations` prop and instead drives everything from `view()` (the overlay).
    expect(blockHandle.props?.decorations).toBeUndefined();
    expect(typeof blockHandle.spec.view).toBe('function');
  });
});
