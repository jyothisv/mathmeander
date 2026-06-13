import { defineConfig } from '@playwright/test';

// Whole-stack e2e: web → server → napi core → Postgres, plus the dev IdP.
// Prerequisites: compose up + migrations applied (`just e2e` wires both).
const CI = !!process.env.CI;

const serverEnv = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgres://mathmeander:mathmeander@localhost:5432/mathmeander_dev?sslmode=disable',
  SERVER_PORT: '8787',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'warn',
  AUTH_ISSUER: 'http://localhost:8788',
  AUTH_JWKS_URL: 'http://localhost:8788/jwks.json',
  AUTH_AUDIENCE: 'mathmeander-api',
  DEV_IDP_PORT: '8788',
};

export default defineConfig({
  testDir: './tests',
  forbidOnly: CI,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @mathmeander/dev-idp dev',
      url: 'http://localhost:8788/jwks.json',
      reuseExistingServer: !CI,
      env: serverEnv,
    },
    {
      command: 'pnpm --filter @mathmeander/server dev',
      url: 'http://localhost:8787/healthz',
      reuseExistingServer: !CI,
      env: serverEnv,
    },
    {
      command: 'pnpm --filter @mathmeander/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
      env: serverEnv,
    },
  ],
});
