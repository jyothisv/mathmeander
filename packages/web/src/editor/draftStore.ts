// Local-first draft persistence (slice 2c autosave). The IndexedDB draft — not the network — is the
// durability guarantee: an edit is written here before/independent of the server flush, so it survives
// navigation, reload, and crashes. Industry-validated substrate (Notion/Linear/Obsidian/Yjs all use
// IndexedDB, never localStorage, for document bodies). We persist the ProseMirror doc JSON (it carries
// the idStamper unit ids), so restore is `Node.fromJSON` + the existing `flushToContent` recomputes the
// delta — no bespoke serialization. The backend is injectable so unit tests run without IndexedDB.
import {
  get as idbGet,
  set as idbSet,
  del as idbDel,
  keys as idbKeys,
  delMany as idbDelMany,
} from 'idb-keyval';

/** Bump when the draft schema changes. An OLDER tab (lower CURRENT) must NOT delete a NEWER deploy's
 *  draft, so the version gate clears only on `stored < CURRENT`, never on `stored > CURRENT`. */
export const CURRENT_DRAFT_VERSION = 1;

/** One day's unsynced editor state. `doc` is `view.state.doc.toJSON()` (structured-cloneable). */
export interface EditorDraft {
  version: number; // === CURRENT_DRAFT_VERSION when written; gated on read
  objectId: string;
  doc: unknown; // ProseMirror doc JSON
  baseRevision: number; // the server revision the doc was derived from (the rebase anchor)
  savedAt: number;
}

/** An async key-value store. Default = idb-keyval; tests inject a Map-backed stub. `keys`/`delMany` are
 *  optional so a minimal stub can omit them (only `clearAllDrafts` needs them). */
export interface DraftBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys?(): Promise<string[]>;
  delMany?(keys: string[]): Promise<void>;
}

const PREFIX = 'mm:journal-draft:'; // one key per journal_day (a notebook can aggregate per-page later)
const keyFor = (objectId: string): string => `${PREFIX}${objectId}`;

const idbBackend: DraftBackend = {
  get: (k) => idbGet(k),
  set: (k, v) => idbSet(k, v),
  del: (k) => idbDel(k),
  keys: async () => (await idbKeys()).filter((k): k is string => typeof k === 'string'),
  delMany: (ks) => idbDelMany(ks),
};

/** Read the draft for an object, or `null` if absent/corrupt/version-mismatched. Never throws;
 *  a corrupt entry is best-effort cleared so it can't wedge the restore path. */
export async function getDraft(
  objectId: string,
  backend: DraftBackend = idbBackend,
): Promise<EditorDraft | null> {
  try {
    const v = await backend.get(keyFor(objectId));
    if (typeof v !== 'object' || v === null) {
      if (v != null) void clearDraft(objectId, backend); // non-object junk
      return null;
    }
    const d = v as Record<string, unknown>;
    if (typeof d.version !== 'number') {
      void clearDraft(objectId, backend);
      return null;
    }
    if (d.version > CURRENT_DRAFT_VERSION) return null; // a newer deploy's draft — DON'T destroy it
    if (d.version < CURRENT_DRAFT_VERSION) {
      void clearDraft(objectId, backend); // stale schema — safe to drop
      return null;
    }
    if (d.objectId !== objectId || typeof d.baseRevision !== 'number' || d.doc == null) {
      void clearDraft(objectId, backend);
      return null;
    }
    return v as EditorDraft;
  } catch {
    return null; // IndexedDB unavailable / blocked — degrade silently (server sync still runs)
  }
}

/** Persist a draft. Never throws (quota/unavailable are swallowed — the server flush is the fallback). */
export async function setDraft(
  draft: EditorDraft,
  backend: DraftBackend = idbBackend,
): Promise<void> {
  try {
    await backend.set(keyFor(draft.objectId), draft);
  } catch {
    /* quota or unavailable — best-effort */
  }
}

/** Remove the draft for an object. Never throws. */
export async function clearDraft(
  objectId: string,
  backend: DraftBackend = idbBackend,
): Promise<void> {
  try {
    await backend.del(keyFor(objectId));
  } catch {
    /* best-effort */
  }
}

/** Drop EVERY journal draft (called on sign-out — shared-browser privacy). Clears only the
 *  `mm:journal-draft:` namespace, never other IndexedDB data. Never throws. */
export async function clearAllDrafts(backend: DraftBackend = idbBackend): Promise<void> {
  try {
    const all = (await backend.keys?.()) ?? [];
    const mine = all.filter((k) => k.startsWith(PREFIX));
    if (mine.length > 0) await backend.delMany?.(mine);
  } catch {
    /* best-effort */
  }
}
