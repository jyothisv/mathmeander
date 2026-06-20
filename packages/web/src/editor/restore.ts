// The local-first restore decision (slice 2c autosave) — PURE, so it unit-tests without ProseMirror.
// On mount we have the server's content and maybe a local draft; this decides whether to load the
// draft (it has unsynced edits at the current base) or discard it (stale/equal/impossible). The
// `draftEqualsServer` predicate is injected so this module never touches PM (the caller supplies a
// `flushToContent`-based comparison).
import type { MathContent } from '@mathmeander/schema';
import type { EditorDraft } from './draftStore';

export type RestoreVerdict = { action: 'restore' } | { action: 'discard' };

/**
 * - **restore** iff the draft was derived from the CURRENT server revision AND still differs from it
 *   (genuine unsynced local edits) → load `draft.doc`, then sync.
 * - **discard** otherwise: no draft; `baseRevision < revision` (server moved ahead — another
 *   tab/device synced; discarding is server-wins, the conservative single-user choice that can't
 *   clobber newer content); `baseRevision > revision` (impossible — trust the server); or the draft
 *   already equals the server (nothing to recover).
 */
export function decideRestore(
  draft: EditorDraft | null,
  server: MathContent,
  draftEqualsServer: (draft: EditorDraft, server: MathContent) => boolean,
): RestoreVerdict {
  if (!draft) return { action: 'discard' };
  if (draft.baseRevision !== server.revision) return { action: 'discard' };
  if (draftEqualsServer(draft, server)) return { action: 'discard' };
  return { action: 'restore' };
}
