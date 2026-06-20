// Classify a failed flush (slice 2c autosave) so the editor reacts correctly — PURE, node-testable.
//  - conflict: a 409 revision race → run the additive merge (merge.ts).
//  - semantic: a deterministic 4xx (e.g. 422 content_save_invalid) → the SAME delta will always be
//    rejected, so LATCH it (don't re-send every keystroke) and surface for review.
//  - transient: a network failure or 5xx → keep retrying on the next edit / on reconnect.
import { ApiError } from '../api/client';

export type FlushErrorClass = 'conflict' | 'semantic' | 'transient';

export function classifyFlushError(err: unknown): FlushErrorClass {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'conflict';
    if (err.status >= 400 && err.status < 500) return 'semantic';
    return 'transient'; // 5xx — server-side, retry
  }
  return 'transient'; // fetch threw (offline / DNS / abort) — retry
}
