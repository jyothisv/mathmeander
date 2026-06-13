// Standalone entrypoint: `pnpm --filter @mathmeander/dev-idp dev`. The builder lives in
// idp.ts so server integration tests can boot ephemeral instances in-process.
import { buildDevIdp } from './idp.js';

const port = Number(process.env.DEV_IDP_PORT ?? 8788);
const issuer = process.env.AUTH_ISSUER ?? `http://localhost:${port}`;
const audience = process.env.AUTH_AUDIENCE ?? 'mathmeander-api';
const corsOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

const app = await buildDevIdp({ issuer, audience, corsOrigin });
await app.listen({ port, host: '127.0.0.1' });
console.log(`dev-idp listening on ${issuer} (audience: ${audience})`);
