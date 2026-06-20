// The local-first restore decision (slice 2c autosave) — PURE, so it unit-tests without ProseMirror.
// On mount we have the server's content and maybe a local draft; this decides whether to load the
// draft (it has unsynced edits at the current base) or discard it (stale/equal/impossible). The
// `draftEqualsServer` predicate is injected so this module never touches PM (the caller supplies a
// `flushToContent`-based comparison).
import type { MathContent } from '@mathmeander/schema';
import type { EditorDraft } from './draftStore';

export type RestoreVerdict = { action: 'restore' } | { action: 'discard' } | { action: 'conflict' };

/**
 * Distinguishes "content I authored over" from "content that appeared elsewhere" so a draft with real
 * unsynced edits is NEVER silently deleted (the review's §2.2 fix). Discard ONLY when there's nothing
 * to recover.
 * - **discard**: no draft; OR the draft already equals the server (already synced / nothing unsaved);
 *   OR `baseRevision > revision` (impossible future — trust the server).
 * - **restore**: the draft differs from the server AND `baseRevision === server.revision` (genuine
 *   unsynced local edits at the current base) → load `draft.doc`, then sync.
 * - **conflict**: the draft differs AND `baseRevision < server.revision` (the server advanced AND I have
 *   unsynced work) → do NOT auto-restore (could clobber) and do NOT delete the draft (would lose) →
 *   keep the draft, surface the conflict, let the user reconcile.
 */
export function decideRestore(
  draft: EditorDraft | null,
  server: MathContent,
  draftEqualsServer: (draft: EditorDraft, server: MathContent) => boolean,
): RestoreVerdict {
  if (!draft) return { action: 'discard' };
  if (draftEqualsServer(draft, server)) return { action: 'discard' }; // nothing to recover — safe to clear
  // The draft DIFFERS from the server (genuine unsynced edits exist) → never discard it.
  if (draft.baseRevision === server.revision) return { action: 'restore' };
  if (draft.baseRevision < server.revision) return { action: 'conflict' };
  return { action: 'discard' }; // baseRevision > revision: impossible — trust the server
}
