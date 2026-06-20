// planMerge — the safe additive merge, branch-complete. The headline guarantee: a disjoint 409 keeps
// BOTH sides (no foreign unit is ever deleted), and a same-unit clash refuses to guess (conflict).
import { describe, expect, it } from 'vitest';
import type { Inline, MathContent, Unit } from '@mathmeander/schema';
import { planMerge, type Delta } from './merge';

const OBJ = '0197675f-71f4-7000-8000-000000000001';

function prose(id: string, position: number, text: string, inline: Inline[] = []): Unit {
  return {
    id,
    object_id: OBJ,
    position,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text, inline },
    provenance_id: '0197675f-71f4-7000-8000-0000000000d1',
  };
}
const content = (units: Unit[], revision: number): MathContent => ({
  object_id: OBJ,
  revision,
  units,
});
const ids = (c: { units: Unit[] }) => c.units.map((u) => u.id);
const textOf = (u: Unit) => (u.content.kind === 'prose' ? u.content.text : '');
const delta = (upserts: Unit[], deletes: string[] = []): Delta => ({ upserts, deletes });

describe('planMerge — additive (disjoint) cases keep both sides', () => {
  it('I edit P0, server added a foreign Z → merge keeps both; Z is never deleted (the blocker)', () => {
    const baseline = content([prose('p0', 0, 'P0')], 1);
    const server = content([prose('p0', 0, 'P0'), prose('z', 1, 'Z')], 2);
    const mine = delta([prose('p0', 0, 'P0x')]); // my edit to P0
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    expect(ids(r.content).sort()).toEqual(['p0', 'z']);
    expect(textOf(r.content.units.find((u) => u.id === 'p0')!)).toBe('P0x');
    expect(r.rebasedDelta.deletes).toEqual([]); // Z NOT deleted
    expect(r.rebasedDelta.upserts.map((u) => u.id)).toEqual(['p0']); // only my edit
  });

  it('server added a paragraph and I appended a new one → both present, mine appended after', () => {
    const baseline = content([prose('p0', 0, 'P0')], 1);
    const server = content([prose('p0', 0, 'P0'), prose('pb', 1, 'Pb')], 2);
    const mine = delta([prose('pa', 1, 'Pa')]); // my new unit (id not in baseline)
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    expect(r.content.units.map((u) => u.id)).toEqual(['p0', 'pb', 'pa']); // mine appended after server's
    expect(r.content.units.map((u) => u.position)).toEqual([0, 1, 2]); // gap-free
    expect(r.rebasedDelta.upserts.map((u) => u.id)).toEqual(['pa']);
    expect(r.rebasedDelta.deletes).toEqual([]);
  });

  it('I delete a server-untouched unit → merge removes it, foreign units survive (renumbered)', () => {
    const baseline = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1'), prose('p2', 2, 'P2')], 1);
    const server = content(
      [prose('p0', 0, 'P0'), prose('p1', 1, 'P1'), prose('p2', 2, 'P2'), prose('z', 3, 'Z')],
      2,
    );
    const mine = delta([], ['p1']); // I deleted P1
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    expect(r.content.units.map((u) => u.id)).toEqual(['p0', 'p2', 'z']); // P1 gone, Z survives
    expect(r.content.units.map((u) => u.position)).toEqual([0, 1, 2]);
    expect(r.rebasedDelta.deletes).toEqual(['p1']);
    // P2 and Z shifted position → upserted (position update), never deleted
    expect(r.rebasedDelta.upserts.map((u) => u.id).sort()).toEqual(['p2', 'z']);
  });

  it('both deleted the same unit → merge is a no-op for it', () => {
    const baseline = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1')], 1);
    const server = content([prose('p0', 0, 'P0')], 2); // server already deleted P1
    const mine = delta([], ['p1']); // I also deleted P1
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    expect(r.content.units.map((u) => u.id)).toEqual(['p0']);
    expect(r.rebasedDelta).toEqual({ upserts: [], deletes: [] });
  });

  it('my new unit never collides with a foreign new unit of identical text (distinct ids)', () => {
    const baseline = content([prose('p0', 0, 'P0')], 1);
    const server = content([prose('p0', 0, 'P0'), prose('foreign', 1, 'same')], 2);
    const mine = delta([prose('mine', 1, 'same')]); // identical text, different id
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    expect(ids(r.content).sort()).toEqual(['foreign', 'mine', 'p0']);
  });

  it('a pure reorder of server-untouched units defers to server order (no content lost)', () => {
    const baseline = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1')], 1);
    const server = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1'), prose('z', 2, 'Z')], 2);
    const mine = delta([prose('p1', 0, 'P1'), prose('p0', 1, 'P0')]); // I swapped order (no content change)
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    expect(r.content.units.map((u) => u.id)).toEqual(['p0', 'p1', 'z']); // server order kept
    expect(r.rebasedDelta).toEqual({ upserts: [], deletes: [] }); // reorder dropped, all content present
  });
});

describe('planMerge — same-unit clashes are conflicts (never a silent overwrite)', () => {
  it('both edited the same unit → conflict', () => {
    const baseline = content([prose('p0', 0, 'P0')], 1);
    const server = content([prose('p0', 0, 'P0-server')], 2);
    const mine = delta([prose('p0', 0, 'P0-mine')]);
    expect(planMerge({ baseline, server, mine })).toEqual({
      kind: 'conflict',
      reason: 'both-edited-same-unit',
    });
  });

  it('I edited a unit the server deleted → conflict', () => {
    const baseline = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1')], 1);
    const server = content([prose('p0', 0, 'P0')], 2); // server deleted P1
    const mine = delta([prose('p1', 1, 'P1-mine')]); // I edited P1
    expect(planMerge({ baseline, server, mine })).toEqual({
      kind: 'conflict',
      reason: 'i-edited-server-deleted',
    });
  });

  it('I deleted a unit the server edited → conflict', () => {
    const baseline = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1')], 1);
    const server = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1-server')], 2); // server edited P1
    const mine = delta([], ['p1']); // I deleted P1
    expect(planMerge({ baseline, server, mine })).toEqual({
      kind: 'conflict',
      reason: 'i-deleted-server-edited',
    });
  });

  it('non-flat content fails safe to conflict', () => {
    const mathUnit: Unit = {
      id: 'm',
      object_id: OBJ,
      position: 0,
      status: 'rough',
      declared_by: 'user',
      content: {
        kind: 'math',
        expr: {
          id: '0197675f-71f4-7000-8000-0000000000e1',
          surface_text: 'x',
          surface_format: 'mathmeander',
          original_input: 'x',
          parse_status: 'renderable',
          occurrences: [],
        },
      },
      provenance_id: '0197675f-71f4-7000-8000-0000000000d1',
    };
    const baseline = content([mathUnit], 1);
    const server = content([mathUnit], 2);
    expect(planMerge({ baseline, server, mine: delta([]) })).toEqual({
      kind: 'conflict',
      reason: 'non-flat',
    });
  });
});

describe('planMerge — invariants', () => {
  it('no-loss: every foreign + server-untouched unit survives a merge', () => {
    const baseline = content([prose('p0', 0, 'P0'), prose('p1', 1, 'P1')], 1);
    const server = content(
      [prose('p0', 0, 'P0'), prose('p1', 1, 'P1'), prose('za', 2, 'Za'), prose('zb', 3, 'Zb')],
      2,
    );
    const mine = delta([prose('p0', 0, 'P0x'), prose('new', 2, 'New')], ['p1']);
    const r = planMerge({ baseline, server, mine });
    expect(r.kind).toBe('merged');
    if (r.kind !== 'merged') return;
    const survivors = new Set(ids(r.content));
    // foreign server units must all survive; my-deleted may be gone; my new must be present
    expect(survivors.has('za')).toBe(true);
    expect(survivors.has('zb')).toBe(true);
    expect(survivors.has('new')).toBe(true);
    expect(survivors.has('p1')).toBe(false); // my delete applied
    expect(r.content.units.map((u) => u.position)).toEqual([0, 1, 2, 3]); // gap-free
    // the rebased delta never deletes a foreign unit
    expect(r.rebasedDelta.deletes).toEqual(['p1']);
  });
});
