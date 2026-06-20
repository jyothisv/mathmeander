// Save-status derivation (slice 2c autosave) — PURE, so it unit-tests without React. A flashing
// "Saving…" that mounts/unmounts each cycle is the discredited anti-pattern (Google retreated from
// it); the calm pattern is a PERSISTENT element whose text changes by strict precedence and never
// flickers per keystroke. We surface the risk states (offline / unsaved / couldn't-save) so a silent
// failed save never loses content unnoticed. Rendering lives in the isolated <SaveStatus> component,
// trivially swappable once the loop is trusted.
export type SaveStatusKind = 'saved' | 'unsaved' | 'saving' | 'offline' | 'error';

export interface SaveState {
  /** A save failed/was rejected and is NOT auto-resolving — needs the user's attention. */
  error: boolean;
  /** The browser is offline; edits are held in the local draft. */
  offline: boolean;
  /** A network flush is in flight. */
  saving: boolean;
  /** Local edits exist that aren't yet confirmed on the server. */
  dirty: boolean;
}

/** Strict precedence: error > offline > saving > unsaved(dirty) > saved. */
export function describeSaveStatus(s: SaveState): { kind: SaveStatusKind; label: string } {
  if (s.error) return { kind: 'error', label: 'Couldn’t save — review' };
  if (s.offline) return { kind: 'offline', label: 'Offline — saved locally' };
  if (s.saving) return { kind: 'saving', label: 'Saving…' };
  if (s.dirty) return { kind: 'unsaved', label: 'Unsaved…' };
  return { kind: 'saved', label: 'Saved' };
}
