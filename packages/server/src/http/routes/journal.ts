// The journal API (slice 2b): the §6.5 `journal_day` writing-surface. Day-existence authoring —
// POST mints a day (idempotent get-or-create), GET lists days date-ordered, GET :date loads the day
// eagerly with its embed-resolving subgraph. Per-unit content arrives later (the 2c editor / rehome).
// Canonical decisions stay in the core; reads flow through the migrate-on-read path.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { CanonicalObject, CoreError } from '@mathmeander/schema';
import type { AppDeps } from '../app.js';
import { AppError, coreErrorToHttp, type ErrorBody } from '../errors.js';
import { createJournalDay, parseAndMigrateObject } from '../../core/index.js';
import { findObjectInSpace, rowToStoredJson, type ObjectRow } from '../../db/objects.js';
import { loadObjectSubgraph } from '../../db/graph.js';
import { findJournalDayByDate, getOrCreateJournalDay, listJournalDays } from '../../db/journal.js';
import { requireSession } from './auth.js';

// Edge gate on shape only — the core's strict NaiveDate is the authority on calendar validity.
const CreateJournalDayBodySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// A real ISO calendar date: shape AND validity. Used for the GET :date LOOKUP KEY so a malformed or
// impossible date is a bad request (→ 400 at the edge) and never reaches the SQL `date` cast (which
// would otherwise surface as a generic 500). The POST BODY above deliberately gates shape ONLY — there
// the core adjudicates calendar validity as domain input (impossible date → 422); a lookup key is just
// edge-validated. (Do not switch POST to this, or its tested 2026-02-30 → 422 would become a 400.)
const IsoCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a valid calendar date');

function readThroughCore(row: ObjectRow): CanonicalObject {
  const result = parseAndMigrateObject(rowToStoredJson(row));
  if (!result.ok) {
    const { status, body } = coreErrorToHttp(result.error);
    throw Object.assign(new Error(body.error.message), { appHttp: { status, body } });
  }
  return result.value;
}

/**
 * The `date` is the only CLIENT-supplied scalar on the create route; its sole typed failure is
 * `malformed_input` (an impossible-but-regex-valid date the core's strict NaiveDate rejects, e.g.
 * 2026-02-30) → 422 (client-attributable). Every OTHER core error here is a glue bug → 500. Do NOT
 * use `coreErrorToHttpUntrusted` (it also remaps schema_version_*, masking real bugs).
 */
function journalCreateErrorToHttp(error: CoreError): { status: number; body: ErrorBody } {
  if (error.kind === 'malformed_input') {
    return { status: 422, body: { error: { code: 'malformed_input', message: error.message } } };
  }
  return coreErrorToHttp(error);
}

export function registerJournalRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    '/api/journal/days',
    { schema: { body: CreateJournalDayBodySchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { date } = req.body as { date: string };

      const result = createJournalDay(
        { id: uuidv7(), type: 'journal_day' },
        { provenance_id: uuidv7(), origin: 'user', created_by: ctx.userId },
        ctx.spaceId,
        date,
        deps.now(),
      );
      if (!result.ok) {
        const { status, body } = journalCreateErrorToHttp(result.error);
        return reply.status(status).send(body);
      }

      const { object, provenance, detail } = result.value;
      const {
        created,
        objectId,
        date: storedDate,
      } = await getOrCreateJournalDay(deps.db, object, provenance, detail, ctx.spaceId);
      const row = await findObjectInSpace(deps.db, ctx.spaceId, objectId);
      if (!row) throw new AppError(404, 'NOT_FOUND', 'journal day vanished'); // unreachable
      return reply
        .status(created ? 201 : 200)
        .send({ object: readThroughCore(row), date: storedDate });
    },
  );

  app.get('/api/journal', async (req) => {
    const ctx = await requireSession(deps, req);
    const days = await listJournalDays(deps.db, ctx.spaceId);
    return { items: days.map((d) => ({ object: readThroughCore(d.row), date: d.date })) };
  });

  app.get(
    '/api/journal/days/:date',
    { schema: { params: z.object({ date: IsoCalendarDate }) } },
    async (req) => {
      const ctx = await requireSession(deps, req);
      const { date } = req.params as { date: string };
      const found = await findJournalDayByDate(deps.db, ctx.spaceId, date);
      if (!found) throw new AppError(404, 'NOT_FOUND', 'no journal day for that date');
      // The subgraph follows Embed{Object} transitively, so the day's embedded objects' content
      // travels too — the web resolves embeds inline from `graph.content` (the §9.y contract).
      const graph = await loadObjectSubgraph(deps.db, ctx.spaceId, found.object_id);
      if (!graph) throw new AppError(404, 'NOT_FOUND', 'no such object');
      const row = await findObjectInSpace(deps.db, ctx.spaceId, found.object_id);
      if (!row) throw new AppError(404, 'NOT_FOUND', 'no such object');
      return { object: readThroughCore(row), date: found.date, graph };
    },
  );
}
