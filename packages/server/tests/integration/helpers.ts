// Integration harness: a REAL ephemeral dev-idp (listening on a random port, so jose's
// remote-JWKS fetch is genuinely remote) + the server app via fastify.inject, against
// the real Postgres test database (migrations applied by `just db-migrate`).
import { buildDevIdp } from '@mathmeander/dev-idp/idp';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Provenance, Unit } from '@mathmeander/schema';
import { buildApp, type App } from '../../src/http/app.js';
import { createIdpVerifier } from '../../src/auth/verify.js';
import { loadEnv } from '../../src/config/env.js';
import { seedContent } from '../../src/db/graph.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://mathmeander:mathmeander@localhost:5432/mathmeander_test?sslmode=disable';

export interface TestStack {
  app: App;
  idp: FastifyInstance;
  idpUrl: string;
  db: pg.Pool;
  /** Mint an IdP token (optionally short/negative ttl for expiry tests). */
  mintIdpToken(email: string, ttlSeconds?: number): Promise<string>;
  /** Full login: IdP token → session exchange → bearer session token. */
  login(email: string): Promise<string>;
  close(): Promise<void>;
}

export async function createStack(): Promise<TestStack> {
  const audience = 'mathmeander-api';
  // Issuer must equal the bound URL, so listen first, then build with the real origin.
  const idpDraft = await buildDevIdp({ issuer: 'http://placeholder', audience });
  await idpDraft.listen({ port: 0, host: '127.0.0.1' });
  const port = (idpDraft.addresses()[0] as { port: number }).port;
  await idpDraft.close();
  const idpUrl = `http://127.0.0.1:${port}`;
  const idp = await buildDevIdp({ issuer: idpUrl, audience });
  await idp.listen({ port, host: '127.0.0.1' });

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    WEB_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'error',
    AUTH_ISSUER: idpUrl,
    AUTH_JWKS_URL: `${idpUrl}/jwks.json`,
    AUTH_AUDIENCE: audience,
  });

  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  try {
    await db.query('SELECT 1 FROM objects LIMIT 0');
  } catch {
    throw new Error(
      `test database is missing the schema — run \`just db-migrate\` first (${TEST_DATABASE_URL})`,
    );
  }

  const app = buildApp({
    env,
    db,
    idpVerifier: createIdpVerifier({
      issuer: env.AUTH_ISSUER,
      jwksUrl: env.AUTH_JWKS_URL,
      audience: env.AUTH_AUDIENCE,
    }),
    now: () => new Date(),
  });
  await app.ready();

  async function mintIdpToken(email: string, ttlSeconds = 3600): Promise<string> {
    const res = await idp.inject({
      method: 'POST',
      url: '/token',
      payload: { email, ttl_seconds: ttlSeconds },
    });
    return (res.json() as { token: string }).token;
  }

  async function login(email: string): Promise<string> {
    const idpToken = await mintIdpToken(email);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sessions',
      payload: { idp_token: idpToken },
    });
    if (res.statusCode !== 201) {
      throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    }
    return (res.json() as { token: string }).token;
  }

  return {
    app,
    idp,
    idpUrl,
    db,
    mintIdpToken,
    login,
    close: async () => {
      await app.close();
      await idp.close();
      await db.end();
    },
  };
}

/** Wipe all data between test files (schema stays; CASCADE + all base tables = order-independent). */
export async function truncateAll(db: pg.Pool): Promise<void> {
  await db.query(
    `TRUNCATE objects, provenance, sessions, spaces, users, content_units, links, aliases,
              handles, tags, taggings, object_versions, definition_detail, journal_day_detail,
              provenance_derivations CASCADE`,
  );
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Seed one object (a `note`, the only directly-creatable type) with a single prose unit, via the
 * REAL persistence path. SLICE-2: stands in for the editor's authoring — no 1c op creates a unit
 * from nothing, so tests seed the content the ops then transform.
 */
export async function seedObjectWithProse(
  stack: TestStack,
  token: string,
  opts: { text: string },
): Promise<{ objectId: string; unitId: string; provenanceId: string }> {
  const objectId = uuidv7();
  const created = await stack.app.inject({
    method: 'POST',
    url: '/api/objects',
    headers: bearer(token),
    payload: { id: objectId, type: 'note', title: 'seed', raw_source: opts.text },
  });
  if (created.statusCode !== 201) {
    throw new Error(`seed create failed: ${created.statusCode} ${created.body}`);
  }

  const unitId = uuidv7();
  const provenanceId = uuidv7();
  const provenance: Provenance = {
    id: provenanceId,
    origin: 'system',
    occurred_at: new Date().toISOString(),
  };
  const unit: Unit = {
    id: unitId,
    object_id: objectId,
    position: 0,
    status: 'rough',
    declared_by: 'user',
    content: { kind: 'prose', text: opts.text, inline: [] },
    provenance_id: provenanceId,
  };
  await seedContent(stack.db, objectId, [unit], provenance);
  return { objectId, unitId, provenanceId };
}

export interface TheoremHost {
  hostId: string;
  rootId: string; // the theorem Group (the subtree root)
  stmtId: string; // the statement prose (child of root) — carries one inline-math atom
  mathId: string; // a display-math child of root
  exprId: string; // the display-math child's expression id
  inlineExprId: string; // the statement's INLINE-math expression id (the prose-carrier case)
  beforeId: string; // a plain prose unit before the theorem
  afterId: string; // a plain prose unit after the theorem
  provenanceId: string;
}

/**
 * Seed a host `note` with a realistic multi-unit theorem subtree — a `Group` root (`type=theorem`)
 * over a statement prose child + a display-math child, flanked by plain prose before/after. The
 * §9.y re-home fixture: positions are gap-free, the host is at revision 1 (create stamps 1;
 * seedContent adds content without bumping). Auxiliary rows (taggings/links/handles) are inserted by
 * the test via SQL, since no endpoint authors them yet.
 */
export async function seedTheoremHost(stack: TestStack, token: string): Promise<TheoremHost> {
  const hostId = uuidv7();
  const created = await stack.app.inject({
    method: 'POST',
    url: '/api/objects',
    headers: bearer(token),
    payload: { id: hostId, type: 'note', title: 'host', raw_source: '' },
  });
  if (created.statusCode !== 201) {
    throw new Error(`seed create failed: ${created.statusCode} ${created.body}`);
  }
  return { hostId, ...(await seedTheoremSubtreeInto(stack, hostId)) };
}

/**
 * Seed the theorem subtree into an ALREADY-EXISTING host (a `note`, or a `journal_day` surface — the
 * core treats the host as raw `MathContent`, so re-home works into either). Splitting this out of
 * `seedTheoremHost` lets the journal suite prove re-home INTO a journal_day host end-to-end. The host
 * stays at its current revision (seedContent adds content without bumping).
 */
export async function seedTheoremSubtreeInto(
  stack: TestStack,
  hostId: string,
): Promise<Omit<TheoremHost, 'hostId'>> {
  const rootId = uuidv7();
  const stmtId = uuidv7();
  const mathId = uuidv7();
  const exprId = uuidv7();
  const inlineExprId = uuidv7();
  const beforeId = uuidv7();
  const afterId = uuidv7();
  const provenanceId = uuidv7();
  const provenance: Provenance = {
    id: provenanceId,
    origin: 'system',
    occurred_at: new Date().toISOString(),
  };
  const base = (
    id: string,
  ): Pick<Unit, 'id' | 'object_id' | 'status' | 'declared_by' | 'provenance_id'> => ({
    id,
    object_id: hostId,
    status: 'rough',
    declared_by: 'user',
    provenance_id: provenanceId,
  });
  const units: Unit[] = [
    { ...base(beforeId), position: 0, content: { kind: 'prose', text: 'Before.', inline: [] } },
    { ...base(rootId), position: 1, type: 'theorem', content: { kind: 'group' } },
    {
      ...base(stmtId),
      parent_unit_id: rootId,
      position: 0,
      content: {
        kind: 'prose',
        text: 'Every compact metric space is complete.',
        // one inline-math atom (zero-width, in-bounds) — the prose-carrier expression-id case
        inline: [
          {
            kind: 'math',
            span: { start: 0, end: 0 },
            expr: {
              id: inlineExprId,
              surface_text: 'd',
              surface_format: 'mathmeander',
              original_input: 'd',
              parse_status: 'renderable',
              occurrences: [],
            },
          },
        ],
      },
    },
    {
      ...base(mathId),
      parent_unit_id: rootId,
      position: 1,
      content: {
        kind: 'math',
        expr: {
          id: exprId,
          surface_text: 'x',
          surface_format: 'mathmeander',
          original_input: 'x',
          parse_status: 'renderable',
          occurrences: [],
        },
      },
    },
    { ...base(afterId), position: 2, content: { kind: 'prose', text: 'After.', inline: [] } },
  ];
  await seedContent(stack.db, hostId, units, provenance);
  return { rootId, stmtId, mathId, exprId, inlineExprId, beforeId, afterId, provenanceId };
}
