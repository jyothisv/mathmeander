// Auth seam gates (setup step 8): JWKS verification, session exchange, the
// single-active-session policy, and the issuer-swap-is-config proof.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDevIdp } from '@mathmeander/dev-idp/idp';
import { bearer, createStack, truncateAll, type TestStack } from './helpers.js';

let stack: TestStack;

beforeAll(async () => {
  stack = await createStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await truncateAll(stack.db);
});

describe('JWT verification (the one path — no bypass exists)', () => {
  it('rejects garbage tokens', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/api/auth/sessions',
      payload: { idp_token: 'garbage.token.here' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects expired IdP tokens', async () => {
    const expired = await stack.mintIdpToken('dev@mathmeander.local', -60);
    const res = await stack.app.inject({
      method: 'POST',
      url: '/api/auth/sessions',
      payload: { idp_token: expired },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects tokens from a DIFFERENT issuer (foreign keys + issuer claim)', async () => {
    const foreign = await buildDevIdp({
      issuer: 'http://evil.example',
      audience: 'mathmeander-api',
    });
    const res = await foreign.inject({
      method: 'POST',
      url: '/token',
      payload: { email: 'dev@mathmeander.local' },
    });
    const foreignToken = (res.json() as { token: string }).token;
    const exchange = await stack.app.inject({
      method: 'POST',
      url: '/api/auth/sessions',
      payload: { idp_token: foreignToken },
    });
    expect(exchange.statusCode).toBe(401);
    await foreign.close();
  });

  it('accepts a valid token: creates user, personal space, session', async () => {
    const token = await stack.login('dev@mathmeander.local');
    expect(token).toBeTruthy();
    const users = await stack.db.query('SELECT idp_issuer, idp_subject FROM users');
    expect(users.rowCount).toBe(1);
    expect(users.rows[0].idp_issuer).toBe(stack.idpUrl);
    const spaces = await stack.db.query('SELECT id FROM spaces');
    expect(spaces.rowCount).toBe(1);
  });
});

describe('single-active-session policy (glue policy, not schema)', () => {
  it('login #2 revokes login #1', async () => {
    const first = await stack.login('dev@mathmeander.local');
    const ok = await stack.app.inject({
      method: 'GET',
      url: '/api/objects',
      headers: bearer(first),
    });
    expect(ok.statusCode).toBe(200);

    const second = await stack.login('dev@mathmeander.local');
    const revoked = await stack.app.inject({
      method: 'GET',
      url: '/api/objects',
      headers: bearer(first),
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe('SESSION_REVOKED');

    const stillOk = await stack.app.inject({
      method: 'GET',
      url: '/api/objects',
      headers: bearer(second),
    });
    expect(stillOk.statusCode).toBe(200);
  });

  it('logout revokes the current session', async () => {
    const token = await stack.login('dev@mathmeander.local');
    const del = await stack.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/current',
      headers: bearer(token),
    });
    expect(del.statusCode).toBe(204);
    const after = await stack.app.inject({
      method: 'GET',
      url: '/api/objects',
      headers: bearer(token),
    });
    expect(after.statusCode).toBe(401);
  });

  it('the same email is the same user across logins (stable uuidv5 subject)', async () => {
    await stack.login('dev@mathmeander.local');
    await stack.login('dev@mathmeander.local');
    const users = await stack.db.query('SELECT id FROM users');
    expect(users.rowCount).toBe(1);
    const spaces = await stack.db.query('SELECT id FROM spaces');
    expect(spaces.rowCount).toBe(1);
  });
});

describe('issuer swap is configuration, not code', () => {
  it('a second stack against a second issuer passes the same flow untouched', async () => {
    const other = await createStack(); // fresh ephemeral issuer, different keys
    try {
      const token = await other.login('dev@mathmeander.local');
      const res = await other.app.inject({
        method: 'GET',
        url: '/api/objects',
        headers: bearer(token),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await other.close();
    }
  });
});

describe('healthz', () => {
  it('proves DB and the FFI seam at runtime', async () => {
    const res = await stack.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.schemaVersion).toBe(1);
  });
});
