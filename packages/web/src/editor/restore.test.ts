// decideRestore — the revision logic, with an injected draftEqualsServer stub (pure, no PM).
import { describe, expect, it } from 'vitest';
import type { MathContent } from '@mathmeander/schema';
import { decideRestore } from './restore';
import type { EditorDraft } from './draftStore';

const OBJ = '0197675f-71f4-7000-8000-000000000001';
const server = (revision: number): MathContent => ({ object_id: OBJ, revision, units: [] });
const draft = (baseRevision: number): EditorDraft => ({
  version: 1,
  objectId: OBJ,
  doc: { type: 'doc', content: [] },
  baseRevision,
  savedAt: 1700000000000,
});
const DIFFERS = () => false; // draftEqualsServer → false means "has unsynced edits"
const EQUAL = () => true;

describe('decideRestore', () => {
  it('discards when there is no draft', () => {
    expect(decideRestore(null, server(2), DIFFERS)).toEqual({ action: 'discard' });
  });

  it('restores when base matches the server revision and the draft differs (unsynced edits)', () => {
    expect(decideRestore(draft(2), server(2), DIFFERS)).toEqual({ action: 'restore' });
  });

  it('discards when base matches but the draft already equals the server (nothing to recover)', () => {
    expect(decideRestore(draft(2), server(2), EQUAL)).toEqual({ action: 'discard' });
  });

  it('discards when the server moved ahead (baseRevision < revision) — server wins', () => {
    expect(decideRestore(draft(2), server(5), DIFFERS)).toEqual({ action: 'discard' });
  });

  it('discards an impossible future draft (baseRevision > revision)', () => {
    expect(decideRestore(draft(7), server(5), DIFFERS)).toEqual({ action: 'discard' });
  });
});
