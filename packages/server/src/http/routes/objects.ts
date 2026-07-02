// The object API (setup step 9): create / read / list / patch. Requests validate at
// the edge with GENERATED zod; canonical decisions happen in the core; persistence is
// exactly-what-the-core-returned; reads flow through the core's migrate-on-read path.
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import {
  CreateObjectInputSchema,
  ObjectPatchSchema,
  type CanonicalObject,
  type CreateObjectInput,
  type ObjectPatch,
} from '@mathmeander/schema';
import type { AppDeps } from '../app.js';
import { AppError, coreErrorToHttp } from '../errors.js';
import { applyTitlePatch, createObject, parseAndMigrateObject } from '../../core/index.js';
import { withTransaction } from '../../db/pool.js';
import {
  currentRevision,
  findObjectInSpace,
  insertObjectWithProvenance,
  listObjectsInSpace,
  rowToStoredJson,
  updateObjectIfRevision,
  type ObjectRow,
} from '../../db/objects.js';
import { requireSession } from './auth.js';

function readThroughCore(row: ObjectRow): CanonicalObject {
  const result = parseAndMigrateObject(rowToStoredJson(row));
  if (!result.ok) {
    const { status, body } = coreErrorToHttp(result.error);
    throw Object.assign(new Error(body.error.message), { appHttp: { status, body } });
  }
  return result.value;
}

export function registerObjectRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/objects', { schema: { body: CreateObjectInputSchema } }, async (req, reply) => {
    const ctx = await requireSession(deps, req);
    const input = req.body as CreateObjectInput;

    const result = createObject(
      input,
      { provenance_id: uuidv7(), origin: 'user', created_by: ctx.userId },
      ctx.spaceId,
      deps.now(),
    );
    if (!result.ok) {
      const { status, body } = coreErrorToHttp(result.error);
      return reply.status(status).send(body);
    }

    try {
      await withTransaction(deps.db, (client) =>
        insertObjectWithProvenance(client, result.value.object, result.value.provenance),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'DUPLICATE_ID', `object ${input.id} already exists`);
      }
      throw err;
    }

    return reply.status(201).send({ object: result.value.object });
  });

  app.get('/api/objects', async (req) => {
    const ctx = await requireSession(deps, req);
    const limit = clampLimit((req.query as { limit?: string }).limit);
    const rows = await listObjectsInSpace(deps.db, ctx.spaceId, limit);
    // Each item is the core-validated object PLUS the identity its page route needs (a notebook's slug,
    // a journal day's date) — additive fields the Desk uses to link to the RIGHT surface.
    return {
      items: rows.map((row) => ({
        ...readThroughCore(row),
        ...(row.slug != null ? { slug: row.slug } : {}),
        ...(row.date != null ? { date: row.date } : {}),
      })),
    };
  });

  app.get('/api/objects/:id', async (req) => {
    const ctx = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const row = await findObjectInSpace(deps.db, ctx.spaceId, id);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'no such object'); // cross-space reads are 404
    return { object: readThroughCore(row) };
  });

  app.patch('/api/objects/:id', { schema: { body: ObjectPatchSchema } }, async (req, reply) => {
    const ctx = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const patch = req.body as ObjectPatch;

    const row = await findObjectInSpace(deps.db, ctx.spaceId, id);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'no such object');
    const current = readThroughCore(row);

    const result = applyTitlePatch(current, patch, deps.now());
    if (!result.ok) {
      const { status, body } = coreErrorToHttp(result.error);
      return reply.status(status).send(body);
    }

    // §6.4: DB-level conditional write, never read-check-write.
    const won = await updateObjectIfRevision(deps.db, result.value, patch.expected_revision);
    if (!won) {
      const revision = await currentRevision(deps.db, ctx.spaceId, id);
      throw new AppError(409, 'REVISION_CONFLICT', 'object changed since you read it', {
        current_revision: revision,
      });
    }
    return reply.send({ object: result.value });
  });
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw ?? '50');
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
