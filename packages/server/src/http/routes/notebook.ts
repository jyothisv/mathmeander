// The notebook API (slice 2 / §B): the §6.5 `notebook` writing-surface — a structured document authored
// into directly with B `group` sections. POST mints a notebook (idempotent get-or-create; the slug is
// derived from the title and normalized in the core), GET lists notebooks, GET :slug loads one eagerly
// with its embed-resolving subgraph. Mirrors the journal route with `slug` in place of `date`. Canonical
// decisions stay in the core; reads flow through the migrate-on-read path.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { CanonicalObject } from '@mathmeander/schema';
import type { AppDeps } from '../app.js';
import { AppError, coreErrorToHttp } from '../errors.js';
import { createNotebook, parseAndMigrateObject } from '../../core/index.js';
import { findObjectInSpace, rowToStoredJson, type ObjectRow } from '../../db/objects.js';
import { loadObjectSubgraph } from '../../db/graph.js';
import { findNotebookBySlug, getOrCreateNotebook, listNotebooks } from '../../db/notebook.js';
import { requireSession } from './auth.js';

// The title is the only client scalar on create; the slug is DERIVED from it (normalized in the core).
const CreateNotebookBodySchema = z.object({ title: z.string().min(1).max(1024) });

// A normalized slug (the core's `normalize_slug` output): lowercase alphanumerics, single interior `-`.
// Used as the GET LOOKUP KEY so a malformed slug is a 400 at the edge, never a SQL/500.
const SlugParam = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function readThroughCore(row: ObjectRow): CanonicalObject {
  const result = parseAndMigrateObject(rowToStoredJson(row));
  if (!result.ok) {
    const { status, body } = coreErrorToHttp(result.error);
    throw Object.assign(new Error(body.error.message), { appHttp: { status, body } });
  }
  return result.value;
}

export function registerNotebookRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/notebooks', { schema: { body: CreateNotebookBodySchema } }, async (req, reply) => {
    const ctx = await requireSession(deps, req);
    const { title } = req.body as { title: string };

    // The slug is derived from the title (the core normalizes it); a title that normalizes to an
    // empty slug (e.g. punctuation only) is a client-attributable 422 via `content_save_invalid`.
    const result = createNotebook(
      { id: uuidv7(), type: 'notebook', title },
      { provenance_id: uuidv7(), origin: 'user', created_by: ctx.userId },
      ctx.spaceId,
      title,
      deps.now(),
    );
    if (!result.ok) {
      const { status, body } = coreErrorToHttp(result.error);
      return reply.status(status).send(body);
    }

    const { object, provenance, detail } = result.value;
    const { created, objectId, slug } = await getOrCreateNotebook(
      deps.db,
      object,
      provenance,
      detail,
      ctx.spaceId,
    );
    const row = await findObjectInSpace(deps.db, ctx.spaceId, objectId);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'notebook vanished'); // unreachable
    return reply.status(created ? 201 : 200).send({ object: readThroughCore(row), slug });
  });

  app.get('/api/notebooks', async (req) => {
    const ctx = await requireSession(deps, req);
    const notebooks = await listNotebooks(deps.db, ctx.spaceId);
    return { items: notebooks.map((n) => ({ object: readThroughCore(n.row), slug: n.slug })) };
  });

  app.get(
    '/api/notebooks/:slug',
    { schema: { params: z.object({ slug: SlugParam }) } },
    async (req) => {
      const ctx = await requireSession(deps, req);
      const { slug } = req.params as { slug: string };
      const found = await findNotebookBySlug(deps.db, ctx.spaceId, slug);
      if (!found) throw new AppError(404, 'NOT_FOUND', 'no notebook with that slug');
      const graph = await loadObjectSubgraph(deps.db, ctx.spaceId, found.object_id);
      if (!graph) throw new AppError(404, 'NOT_FOUND', 'no such object');
      const row = await findObjectInSpace(deps.db, ctx.spaceId, found.object_id);
      if (!row) throw new AppError(404, 'NOT_FOUND', 'no such object');
      return { object: readThroughCore(row), slug: found.slug, graph };
    },
  );
}
