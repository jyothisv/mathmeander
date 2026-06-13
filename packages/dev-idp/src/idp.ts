// A local OIDC-shaped token issuer — DEV ONLY, but shaped exactly like a hosted IdP
// from the verifier's point of view: RS256 JWTs, a JWKS endpoint, issuer/audience
// claims. The server's verification path cannot tell the difference, which is the
// issuer-swap-only guarantee (arch doc §7) made mechanical.
//
// Keys are EPHEMERAL (generated at boot, never written to disk): there is no dev key
// material to leak or commit.
import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { v5 as uuidv5 } from 'uuid';

// Fixed namespace so the same email yields the same subject across restarts —
// user rows stay stable even though signing keys rotate every boot.
const SUBJECT_NAMESPACE = '6f7cf3f4-32a8-44a5-9b8b-0e6a3a3d9d10';

export interface DevIdpOptions {
  issuer: string;
  audience: string;
  /** Origins allowed to call POST /token from a browser (the web login page). */
  corsOrigin?: string | string[];
}

export async function buildDevIdp(opts: DevIdpOptions): Promise<FastifyInstance> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('@mathmeander/dev-idp must never run in production');
  }

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), use: 'sig', alg: 'RS256', kid: 'dev-1' };

  const app = fastify({ logger: { level: 'warn' } });
  if (opts.corsOrigin) {
    app.register(cors, { origin: opts.corsOrigin });
  }

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: opts.issuer,
    jwks_uri: `${opts.issuer}/jwks.json`,
    token_endpoint: `${opts.issuer}/token`,
  }));

  app.get('/jwks.json', async () => ({ keys: [jwk] }));

  app.post('/token', async (req, reply) => {
    const body = req.body as { email?: string; ttl_seconds?: number } | null;
    const email = body?.email?.trim();
    if (!email) {
      return reply.status(400).send({ error: 'email required' });
    }
    const ttl = body?.ttl_seconds ?? 3600;
    const token = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
      .setIssuer(opts.issuer)
      .setAudience(opts.audience)
      .setSubject(uuidv5(email, SUBJECT_NAMESPACE))
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .sign(privateKey);
    return { token };
  });

  // Minimal HTML form for manual poking; the web app calls POST /token directly.
  app.get('/', async (_req, reply) => {
    reply.type('text/html');
    return `<!doctype html><title>mathmeander dev-idp</title>
<h1>mathmeander dev-idp</h1>
<form onsubmit="event.preventDefault();
  fetch('/token',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:document.querySelector('input').value})})
  .then(r=>r.json()).then(j=>{document.querySelector('pre').textContent=j.token});">
  <input type="email" placeholder="dev@mathmeander.local" value="dev@mathmeander.local">
  <button>Mint token</button></form><pre></pre>`;
  });

  return app;
}
