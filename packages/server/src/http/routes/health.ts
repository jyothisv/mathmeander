import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { coreVersion, currentSchemaVersion, assertCoreLockstep } from '../../core/index.js';

/** Health proves the FFI seam at runtime, not just DB connectivity. */
export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/healthz', async () => {
    await deps.db.query('SELECT 1');
    return {
      ok: true,
      coreVersion: coreVersion(),
      artifactHash: assertCoreLockstep().artifactHash,
      schemaVersion: currentSchemaVersion(),
    };
  });
}
