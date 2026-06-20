// describeSaveStatus — the full precedence table (pure).
import { describe, expect, it } from 'vitest';
import { describeSaveStatus, type SaveState } from './saveStatus';

const state = (over: Partial<SaveState> = {}): SaveState => ({
  conflict: false,
  error: false,
  offline: false,
  saving: false,
  dirty: false,
  ...over,
});

describe('describeSaveStatus precedence', () => {
  it('saved is the settled default', () => {
    expect(describeSaveStatus(state())).toEqual({ kind: 'saved', label: 'Saved' });
  });

  it('dirty → unsaved', () => {
    expect(describeSaveStatus(state({ dirty: true })).kind).toBe('unsaved');
  });

  it('saving outranks dirty', () => {
    expect(describeSaveStatus(state({ saving: true, dirty: true })).kind).toBe('saving');
  });

  it('offline outranks saving and dirty', () => {
    expect(describeSaveStatus(state({ offline: true, saving: true, dirty: true })).kind).toBe(
      'offline',
    );
  });

  it('error outranks offline/saving/dirty', () => {
    expect(
      describeSaveStatus(state({ error: true, offline: true, saving: true, dirty: true })).kind,
    ).toBe('error');
  });

  it('conflict outranks everything', () => {
    expect(
      describeSaveStatus(
        state({ conflict: true, error: true, offline: true, saving: true, dirty: true }),
      ),
    ).toEqual({ kind: 'conflict', label: 'Changed elsewhere — your edits are kept' });
  });
});
