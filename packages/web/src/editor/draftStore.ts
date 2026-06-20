// Local-first draft persistence (slice 2c autosave). The IndexedDB draft — not the network — is the
// durability guarantee: an edit is written here before/independent of the server flush, so it survives
// navigation, reload, and crashes. Industry-validated substrate (Notion/Linear/Obsidian/Yjs all use
// IndexedDB, never localStorage, for document bodies). We persist the ProseMirror doc JSON (it carries
// the idStamper unit ids), so restore is `Node.fromJSON` + the existing `flushToContent` recomputes the
// delta — no bespoke serialization. The backend is injectable so unit tests run without IndexedDB.
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

/** One day's unsynced editor state. `doc` is `view.state.doc.toJSON()` (structured-cloneable). */
export interface EditorDraft {
  version: 1; // bump to invalidate drafts on a doc-format change
  objectId: string;
  doc: unknown; // ProseMirror doc JSON
  baseRevision: number; // the server revision the doc was derived from (the rebase anchor)
  savedAt: number;
}

/** An async key-value store. Default = idb-keyval; tests inject a Map-backed stub. */
export interface DraftBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const PREFIX = 'mm:journal-draft:'; // one key per journal_day (a notebook can aggregate per-page later)
const keyFor = (objectId: string): string => `${PREFIX}${objectId}`;

const idbBackend: DraftBackend = {
  get: (k) => idbGet(k),
  set: (k, v) => idbSet(k, v),
  del: (k) => idbDel(k),
};

function isDraft(v: unknown, objectId: string): v is EditorDraft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d.version === 1 &&
    d.objectId === objectId &&
    typeof d.baseRevision === 'number' &&
    d.doc != null
  );
}

/** Read the draft for an object, or `null` if absent/corrupt/version-mismatched. Never throws;
 *  a corrupt entry is best-effort cleared so it can't wedge the restore path. */
export async function getDraft(
  objectId: string,
  backend: DraftBackend = idbBackend,
): Promise<EditorDraft | null> {
  try {
    const v = await backend.get(keyFor(objectId));
    if (v === undefined || v === null) return null;
    if (!isDraft(v, objectId)) {
      void clearDraft(objectId, backend);
      return null;
    }
    return v;
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
