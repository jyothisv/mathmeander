// §6.3b names-as-attr model: `names` lives as block chrome (never body content); the projection sets/reads
// it (no marker, no span-shift); `nameNeeds` diffs by HANDLE id (multi-handle aliases); the citation picker
// offers one candidate per name; a reference round-trips its chosen `targetHandleId`.
import { describe, expect, it } from 'vitest';
import type { MathContent, Unit } from '@mathmeander/schema';
import { editorSchema } from './schema';
import { primaryName, sortedNames } from './names';
import {
  docProjectedHandles,
  flushToContent,
  nameIntents,
  nameNeeds,
  projectToDoc,
  type ProjectedHandle,
} from './projection';
import { localBlocks } from './citePicker';
import { EditorState, TextSelection } from 'prosemirror-state';

function typed(
  unitId: string,
  type: string,
  names: { id: string; name: string }[],
  text = 'the statement',
) {
  return editorSchema.nodes.prose.create(
    { unitId, unitType: type, names },
    editorSchema.text(text),
  );
}
const server = (ids: string[]): MathContent =>
  ({ object_id: 'o', revision: 1, units: ids.map((id) => ({ id })) }) as unknown as MathContent;

describe('names helpers', () => {
  it('primaryName / sortedNames pick the min-by-id', () => {
    const ns = [
      { id: 'b', name: 'alias' },
      { id: 'a', name: 'primary' },
    ];
    expect(primaryName(ns)).toBe('primary');
    expect(sortedNames(ns).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('projectToDoc / blockToProse — name is CHROME, body is clean', () => {
  const unit = {
    id: 't1',
    object_id: 'o',
    parent_unit_id: null,
    position: 0,
    type: 'theorem',
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text: 'the statement', inline: [] },
    provenance_id: 'p',
  } as unknown as Unit;
  const content: MathContent = { object_id: 'o', revision: 1, units: [unit] };

  it('projects handles → the `names` attr (sorted), with the body untouched', () => {
    const handles: ProjectedHandle[] = [
      { target_unit_id: 't1', id: 'h2', name: 'C–S inequality' },
      { target_unit_id: 't1', id: 'h1', name: 'Cauchy–Schwarz' },
    ];
    const doc = projectToDoc(content, handles);
    const block = doc.firstChild!;
    expect(block.textContent).toBe('the statement'); // NO marker in the body
    expect((block.attrs.names as { id: string; name: string }[]).map((n) => n.name)).toEqual([
      'Cauchy–Schwarz', // h1 < h2 → primary first
      'C–S inequality',
    ]);
  });

  it('flush leaves the prose canonical (the name is not content)', () => {
    const doc = projectToDoc(content, [{ target_unit_id: 't1', id: 'h1', name: 'Cauchy–Schwarz' }]);
    const baseline: MathContent = {
      ...content,
      units: [{ ...unit, content: { kind: 'prose', text: 'OLD', inline: [] } } as unknown as Unit],
    };
    const flushed = flushToContent(doc, baseline).upserts.find((u) => u.id === 't1');
    expect((flushed?.content as { text: string } | undefined)?.text).toBe('the statement');
  });

  it('docProjectedHandles round-trips the names off the doc', () => {
    const doc = editorSchema.nodes.doc.create(null, [
      typed('t1', 'theorem', [{ id: 'h1', name: 'Cauchy–Schwarz' }]),
    ]);
    expect(docProjectedHandles(doc)).toEqual([
      { target_unit_id: 't1', id: 'h1', name: 'Cauchy–Schwarz' },
    ]);
  });
});

describe('a reference round-trips its chosen targetHandleId', () => {
  it('flushes the node attr → Inline.target_handle_id, and projects it back', () => {
    const ref = editorSchema.nodes.reference.create({
      text: 'clopen',
      target: { kind: 'unit', object_id: 'o', unit_id: 't1' },
      linkId: 'L',
      targetHandleId: 'h9',
    });
    const doc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.prose.create({ unitId: 'p1', unitType: null }, [
        editorSchema.text('see '),
        ref,
      ]),
    ]);
    const flushed = flushToContent(doc, server([])).upserts.find((u) => u.id === 'p1');
    const inline = (flushed?.content as { inline: { kind: string; target_handle_id?: string }[] })
      .inline;
    const r = inline.find((i) => i.kind === 'reference');
    expect(r?.target_handle_id).toBe('h9');

    // …and back: projectToDoc rebuilds the node attr from the inline.
    const content: MathContent = { object_id: 'o', revision: 1, units: [flushed as Unit] };
    expect(projectToDoc(content).firstChild!.child(1).attrs.targetHandleId).toBe('h9');
  });
});

describe('nameNeeds (multi-handle)', () => {
  const doc = editorSchema.nodes.doc.create(null, [
    typed('t1', 'theorem', [
      { id: 'h1', name: 'Cauchy–Schwarz' }, // unchanged vs sent
      { id: 'h2', name: 'C–S' }, // renamed vs sent ("C-S")
    ]),
    typed('t2', 'theorem', [{ id: 'h3', name: 'Pythagoras' }]), // new (not in sent)
    typed('new', 'theorem', [{ id: 'h4', name: 'Fresh' }]), // unit not on server → skip
  ]);
  const sent = new Map([
    ['h1', { unitId: 't1', name: 'Cauchy–Schwarz' }],
    ['h2', { unitId: 't1', name: 'C-S' }],
    ['h9', { unitId: 't1', name: 'gone alias' }], // removed from the doc → clear
  ]);

  it('upserts a new/changed name, clears a removed alias, skips a not-yet-persisted unit', () => {
    const out = nameNeeds(doc, server(['t1', 't2']), sent);
    expect(out).toEqual(
      expect.arrayContaining([
        { unitId: 't1', handleId: 'h2', name: 'C–S' }, // rename
        { unitId: 't2', handleId: 'h3', name: 'Pythagoras' }, // new
        { unitId: 't1', handleId: 'h9', name: '' }, // removed alias → clear
      ]),
    );
    expect(out).toHaveLength(3); // h1 unchanged; 'new' (off-server) skipped
  });
});

describe('nameIntents (draft-equality vs the server handle baseline — review M1)', () => {
  const doc = editorSchema.nodes.doc.create(null, [
    typed('t1', 'theorem', [
      { id: 'h1', name: 'Cauchy–Schwarz' }, // matches the baseline → NOT pending
      { id: 'h2', name: 'C–S' }, // new vs baseline → pending
    ]),
  ]);

  it('a name matching the server baseline is NOT pending; a new/changed/dropped one IS', () => {
    const baseline = new Map([
      ['h1', 'Cauchy–Schwarz'],
      ['h9', 'an alias the draft dropped'], // in baseline, gone from doc → pending (clear)
    ]);
    const out = nameIntents(doc, baseline);
    expect(out).toEqual(
      expect.arrayContaining([
        { unitId: 't1', handleId: 'h2', name: 'C–S' }, // new
        { unitId: '', handleId: 'h9', name: '' }, // dropped vs baseline
      ]),
    );
    expect(out).toHaveLength(2); // h1 (== baseline) is not pending
  });

  it('an exactly-synced doc has NO intents (so a stale draft can be discarded)', () => {
    const synced = new Map([
      ['h1', 'Cauchy–Schwarz'],
      ['h2', 'C–S'],
    ]);
    expect(nameIntents(doc, synced)).toEqual([]);
  });
});

describe('projectToDoc — a TYPED HEADING carries its names (review M3)', () => {
  it('attaches names on the heading branch (else the axis would delete the handle)', () => {
    const heading = {
      id: 'h1',
      object_id: 'o',
      parent_unit_id: null,
      position: 0,
      type: 'theorem',
      status: 'rough',
      declared_by: 'user',
      content: { kind: 'heading', text: 'A Named Section', inline: [] },
      provenance_id: 'p',
    } as unknown as Unit;
    const content: MathContent = { object_id: 'o', revision: 1, units: [heading] };
    const block = projectToDoc(content, [
      { target_unit_id: 'h1', id: 'g1', name: 'Pythagoras' },
    ]).firstChild!;
    expect(block.attrs.heading).toBe(true);
    expect((block.attrs.names as { name: string }[]).map((n) => n.name)).toEqual(['Pythagoras']);
  });
});

describe('citePicker.localBlocks — ONE candidate per unit (with all its names)', () => {
  it('groups aliases into a single row; an unnamed typed block has empty names', () => {
    const doc = editorSchema.nodes.doc.create(null, [
      typed('cur', 'theorem', []), // the caret block (excluded)
      typed('d1', 'definition', [
        { id: 'a', name: 'open set' },
        { id: 'b', name: 'clopen' },
      ]),
      typed('t1', 'theorem', []), // unnamed → cite by number
    ]);
    const state = EditorState.create({ schema: editorSchema, doc });
    const atCur = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    expect(localBlocks(atCur)).toEqual([
      {
        unitId: 'd1',
        type: 'definition',
        snippet: 'the statement',
        names: [
          { id: 'a', name: 'open set' },
          { id: 'b', name: 'clopen' },
        ],
      },
      { unitId: 't1', type: 'theorem', snippet: 'the statement', names: [] },
    ]);
  });
});
