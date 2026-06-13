// @mathmeander/server boot. Refuses to start unless the native core and @mathmeander/schema
// are in lockstep (debt guard #7) — a stale addon is no server, not subtle bugs.
import { loadEnv } from './config/env.js';
import { assertCoreLockstep } from './core/index.js';
import { createPool } from './db/pool.js';
import { createIdpVerifier } from './auth/verify.js';
import { buildApp } from './http/app.js';

const env = loadEnv();
const lockstep = assertCoreLockstep(); // throws on mismatch — boot stops here

const app = buildApp({
  env,
  db: createPool(env.DATABASE_URL),
  idpVerifier: createIdpVerifier({
    issuer: env.AUTH_ISSUER,
    jwksUrl: env.AUTH_JWKS_URL,
    audience: env.AUTH_AUDIENCE,
  }),
  now: () => new Date(),
});

app.log.info(
  { coreVersion: lockstep.coreVersion, artifactHash: lockstep.artifactHash.slice(0, 12) },
  'core lockstep verified',
);

app.listen({ port: env.SERVER_PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
