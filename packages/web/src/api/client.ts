// THE fetch chokepoint: every response is zod-parsed with the GENERATED schemas
// ("parse, don't trust") — a drifting server fails loudly at runtime, never silently.
// Attaches the bearer token, maps the error envelope, and routes 401 to /login.
import { z } from 'zod';
import {
  CanonicalObjectSchema,
  MathpackGraphSchema,
  OpOutcomeSchema,
  type CanonicalObject,
  type MathpackGraph,
  type ObjectPatch,
  type OpOutcome,
  type Unit,
  type UnitType,
} from '@mathmeander/schema';
import { API_ORIGIN, DEV_IDP_ORIGIN } from '../config';
import { clearSession, currentToken } from '../auth/store';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const ErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const token = currentToken();
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (res.status === 401) {
    clearSession();
    window.location.assign('/login');
    throw new ApiError(401, 'UNAUTHENTICATED', 'session ended');
  }

  if (!res.ok) {
    const parsed = ErrorEnvelope.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      const e = parsed.data.error;
      throw new ApiError(res.status, e.code, e.message, e.details);
    }
    throw new ApiError(res.status, 'UNKNOWN', `request failed with ${res.status}`);
  }

  if (res.status === 204) return schema.parse(undefined);
  return schema.parse(await res.json());
}

// ── Auth ──

const SessionResponse = z.object({
  token: z.string(),
  user: z.object({ id: z.string(), email: z.string().nullable() }),
  space: z.object({ id: z.string() }),
});

/** Dev login: mint an IdP token from the dev issuer, then exchange it for a session. */
export async function devLogin(email: string): Promise<z.infer<typeof SessionResponse>> {
  const idpRes = await fetch(`${DEV_IDP_ORIGIN}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!idpRes.ok) throw new ApiError(idpRes.status, 'IDP', 'dev issuer rejected the request');
  const { token: idpToken } = (await idpRes.json()) as { token: string };
  return request('POST', '/api/auth/sessions', SessionResponse, { idp_token: idpToken });
}

export async function logout(): Promise<void> {
  await request('DELETE', '/api/auth/sessions/current', z.undefined());
}

// ── Objects (response shapes are the GENERATED CanonicalObject) ──

const ObjectEnvelope = z.object({ object: CanonicalObjectSchema });
const ListEnvelope = z.object({ items: z.array(CanonicalObjectSchema) });

export async function createNote(input: {
  id: string;
  title?: string;
  raw_source?: string;
}): Promise<CanonicalObject> {
  const body = { type: 'note', ...input };
  return (await request('POST', '/api/objects', ObjectEnvelope, body)).object;
}

export async function getObject(id: string): Promise<CanonicalObject> {
  return (await request('GET', `/api/objects/${id}`, ObjectEnvelope)).object;
}

export async function listObjects(): Promise<CanonicalObject[]> {
  return (await request('GET', '/api/objects', ListEnvelope)).items;
}

export async function patchObject(id: string, patch: ObjectPatch): Promise<CanonicalObject> {
  return (await request('PATCH', `/api/objects/${id}`, ObjectEnvelope, patch)).object;
}

// ── Journal (§6.5 surface): a day = its object + the date it carries; the eager read carries the
// transitive subgraph so the view resolves Embed{Object} inline. ──

export interface JournalDaySummary {
  object: CanonicalObject;
  date: string;
}
export interface JournalDayEager extends JournalDaySummary {
  graph: MathpackGraph;
}

const JournalDayEnvelope = z.object({ object: CanonicalObjectSchema, date: z.string() });
const JournalListEnvelope = z.object({ items: z.array(JournalDayEnvelope) });
const JournalDayEagerEnvelope = z.object({
  object: CanonicalObjectSchema,
  date: z.string(),
  graph: MathpackGraphSchema,
});

/** Idempotent get-or-create for one calendar day (the "Today" button). */
export async function createJournalDay(date: string): Promise<JournalDaySummary> {
  return request('POST', '/api/journal/days', JournalDayEnvelope, { date });
}

export async function listJournalDays(): Promise<JournalDaySummary[]> {
  return (await request('GET', '/api/journal', JournalListEnvelope)).items;
}

export async function getJournalDay(date: string): Promise<JournalDayEager> {
  return request('GET', `/api/journal/days/${date}`, JournalDayEagerEnvelope);
}

// ── Authoring: the §6.0a coarse prose delta (slice 2c). Unit ids are client-minted (§6.3). ──

const OpOutcomeEnvelope = z.object({ outcome: OpOutcomeSchema });

export async function saveContent(
  objectId: string,
  body: { expected_revision: number; upserts: Unit[]; deletes: string[] },
): Promise<OpOutcome> {
  return (await request('PUT', `/api/objects/${objectId}/content`, OpOutcomeEnvelope, body))
    .outcome;
}

/** The §6.0a canonical type-set op (slice 2c-2): a leading cue / clear routes here, NOT through the prose
 *  delta (the core freezes type on `save_content`). `unit_type` is a §6.3 Patch — a value SETS, `null`
 *  CLEARS to plain; the editor never sends "absent". A stale `expected_revision` → 409 (same gate as
 *  `save_content`). The unit must already exist (a brand-new cue'd unit is created prose-first). */
export async function setUnitType(
  objectId: string,
  body: { expected_revision: number; unit_id: string; unit_type: UnitType | null },
): Promise<OpOutcome> {
  return (
    await request('POST', `/api/objects/${objectId}/ops/set-unit-type`, OpOutcomeEnvelope, body)
  ).outcome;
}

/** Best-effort exit flush (slice 2c autosave): a fire-and-forget `keepalive` PUT used on
 *  `visibilitychange→hidden` / `pagehide` so the last delta still reaches the server when the page is
 *  going away. We use `fetch keepalive` (not `navigator.sendBeacon`, which is header-less) to carry the
 *  bearer token. The keepalive body shares a ~64 KiB browser cap, so callers send only the pending
 *  delta — and the IndexedDB draft, not this beacon, is the real durability guarantee. */
export function saveContentBeacon(
  objectId: string,
  body: { expected_revision: number; upserts: Unit[]; deletes: string[] },
): void {
  const token = currentToken();
  void fetch(`${API_ORIGIN}/api/objects/${objectId}/content`, {
    method: 'PUT',
    keepalive: true,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }).catch(() => {
    /* best-effort; the local draft covers durability */
  });
}
