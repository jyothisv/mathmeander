// The Fastify glue app (arch doc §7). Owns nothing canonical: requests are zod-validated
// at the edge with GENERATED schemas, canonical decisions happen in the Rust core via
// the FFI chokepoint, and rows are persisted exactly as the core returned them.
import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { Env } from '../config/env.js';
import type { IdpVerifier } from '../auth/verify.js';
import { AppError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJournalRoutes } from './routes/journal.js';
import { registerNotebookRoutes } from './routes/notebook.js';
import { registerObjectRoutes } from './routes/objects.js';

export interface AppDeps {
  env: Env;
  db: pg.Pool;
  idpVerifier: IdpVerifier;
  /** Injectable clock so tests control time; production passes () => new Date(). */
  now: () => Date;
}

export type App = FastifyInstance;

export function buildApp(deps: AppDeps): App {
  const app = fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      // Structured JSON logs from day one (arch doc §15); request ids are fastify's.
      redact: ['req.headers.authorization'],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(helmet);
  app.register(cors, {
    origin: deps.env.WEB_ORIGIN,
    // @fastify/cors defaults to GET,HEAD,POST only — PATCH (rename), PUT (the slice-2c content
    // editor's save_content), and DELETE (logout) must be explicitly preflightable.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(err.toBody());
    }
    // Edge validation failures (generated zod via the type provider).
    const fastifyErr = err as { validation?: unknown; message?: string };
    if (fastifyErr.validation) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: fastifyErr.message ?? 'invalid request',
          details: fastifyErr.validation,
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  app.register(registerHealthRoutes, deps);
  app.register(registerAuthRoutes, deps);
  app.register(registerObjectRoutes, deps);
  app.register(registerGraphRoutes, deps);
  app.register(registerJournalRoutes, deps);
  app.register(registerNotebookRoutes, deps);

  return app;
}
