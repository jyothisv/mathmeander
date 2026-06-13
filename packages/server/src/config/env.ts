// Typed, fail-fast env config. This is the ONE documented hand-written-zod exception
// (infra config is not core data — see eslint guard rationale in docs/setup.md);
// no `process.env` access exists anywhere else in the server.
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  SERVER_PORT: z.coerce.number().int().positive().default(8787),
  WEB_ORIGIN: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // The auth seam (arch doc §7): swapping dev-idp for a hosted IdP changes THESE
  // VALUES only — the verification code path is identical.
  AUTH_ISSUER: z.string().url(),
  AUTH_JWKS_URL: z.string().url(),
  AUTH_AUDIENCE: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`invalid environment:\n${issues}`);
  }
  return parsed.data;
}
