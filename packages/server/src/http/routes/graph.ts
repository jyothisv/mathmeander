// The canonical-operation API (slice 1d): per-op endpoints + labels/mathpack/import. Each op:
// load the working content from SQL → call the core via the FFI chokepoint (server-minted ids in
// the input, OpContext) → on success persist the OpOutcome in one transaction (409 on a lost
// optimistic-concurrency race). No editor UI — these are exercised at the API layer (slice 2 authors).
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import {
  SetUnitTypeInputSchema,
  SplitUnitInputSchema,
  MergeUnitsInputSchema,
  ToggleExpressionPlacementInputSchema,
  RewriteSurfaceInputSchema,
  InsertReferenceInputSchema,
  ResolveOccurrenceInputSchema,
  UnitSchema,
  type ExpressionIdRemap,
  type InsertReferenceInput,
  type MaterializeObjectInput,
  type MathpackMeta,
  type MergeUnitsInput,
  type RehomeSubtreeInput,
  type DissolveObjectInput,
  type NumberingPolicy,
  type OpContext,
  type OpOutcome,
  type Provenance,
  type ResolveOccurrenceInput,
  type RewriteSurfaceInput,
  type SetUnitTypeInput,
  type SplitUnitInput,
  type ToggleExpressionPlacementInput,
  type Unit,
  type UnitIdRemap,
} from '@mathmeander/schema';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { AppError, coreErrorToHttp, coreErrorToHttpUntrusted, type ErrorBody } from '../errors.js';
import {
  insertReference,
  materializeObject,
  rehomeSubtree,
  dissolveObject,
  mergeUnits,
  projectNumbering,
  resolveOccurrence,
  rewriteSurface,
  saveContent,
  setUnitType,
  splitUnit,
  toggleExpressionPlacement,
  exportMathpack,
  importMathpack,
} from '../../core/index.js';
import { currentRevision } from '../../db/objects.js';
import {
  ContentConstraintError,
  loadContent,
  loadCurrentLinks,
  loadInboundLinks,
  loadCurrentTaggings,
  loadObject,
  loadObjectSubgraph,
  persistContentDelta,
  persistObjectGraph,
} from '../../db/graph.js';
import { requireSession } from './auth.js';

/** Default numbering policy for `GET …/labels` (no policy UI in slice 1d). */
const DEFAULT_POLICY: NumberingPolicy = {
  numbered_types: ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'example'],
  shared_counter: false,
};

const MaterializeBodySchema = z.object({ expected_revision: z.number().int().nonnegative() });

const RehomeBodySchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  subtree_root: z.string().uuid(),
  type: z.string(), // the materialized object's type; the core validates producibility (→ 422)
});

const DissolveBodySchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  expected_dissolved_revision: z.number().int().nonnegative(),
  dissolved_object_id: z.string().uuid(),
});

// The §6.0a coarse prose-authoring delta (slice 2c): only changed/new units + removed ids. Unit ids
// are client-minted UUIDv7 (the §6.3 reservation); the core reconcile-gates against `prior`.
const SaveContentBodySchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  upserts: z.array(UnitSchema),
  deletes: z.array(z.string().uuid()),
});

export function registerGraphRoutes(app: FastifyInstance, deps: AppDeps): void {
  // ── set_unit_type ──
  app.post(
    '/api/objects/:id/ops/set-unit-type',
    { schema: { body: SetUnitTypeInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const input = req.body as SetUnitTypeInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = setUnitType(content, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── save_content (the §6.0a coarse prose-authoring DELTA, slice 2c editor) ──
  app.put(
    '/api/objects/:id/content',
    { schema: { body: SaveContentBodySchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as { expected_revision: number; upserts: Unit[]; deletes: string[] };
      const prior = await loadContent(deps.db, ctx.spaceId, id);
      if (!prior) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      // New (from-nothing) units carry the authoring action's provenance; edits keep theirs (the
      // core's reconcile gate requires every non-prose-content field unchanged on an existing unit).
      const priorIds = new Set(prior.units.map((u) => u.id));
      const upserts: Unit[] = body.upserts.map((u) =>
        priorIds.has(u.id) ? u : { ...u, provenance_id: provenance.id },
      );

      // The §6.3a display-math keystone (like rewrite_surface): the core needs the current edges to reject
      // re-authoring/deleting a CITED equation via the coarse delta. BOTH directions matter — this object's
      // OUTBOUND ExpressionSpan anchors AND INBOUND cross-object ExpressionRef citations into its expressions
      // (else a cited equation could be silently re-authored, orphaning the citation's span). Two indexed
      // reads; the common no-edges case yields empty lists → every Math edit is keystone-safe.
      const currentLinks = [
        ...(await loadCurrentLinks(deps.db, id)),
        ...(await loadInboundLinks(deps.db, id)),
      ];
      const result = saveContent(prior, currentLinks, upserts, body.deletes, opCtx, now);
      if (!result.ok) return sendCoreError(reply, result.error);

      let won: boolean;
      try {
        ({ won } = await persistContentDelta(
          deps.db,
          id,
          { upserts, deletes: body.deletes },
          {
            provenance,
            expectedRevision: body.expected_revision,
            newRevision: result.value.content.revision,
            versionSnapshot: result.value.version_snapshot,
            now,
          },
        ));
      } catch (err) {
        // A DB integrity constraint (e.g. deleting a still-referenced unit) → client error, not 500.
        if (err instanceof ContentConstraintError) {
          return sendCoreError(reply, {
            kind: 'validation',
            code: 'content_save_invalid',
            reason: err.message,
          } as import('@mathmeander/schema').CoreError);
        }
        throw err;
      }
      if (!won) {
        const revision = await currentRevision(deps.db, ctx.spaceId, id);
        throw new AppError(409, 'REVISION_CONFLICT', 'object changed since you read it', {
          current_revision: revision,
        });
      }
      return reply.send({ outcome: result.value });
    },
  );

  // ── split_unit (glue mints the new unit id; propagate the split unit's taggings) ──
  app.post(
    '/api/objects/:id/ops/split-unit',
    { schema: { body: SplitUnitInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as SplitUnitInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const onUnit = (await loadCurrentTaggings(deps.db, id)).filter(
        (t) => t.tagged_unit_id === body.unit_id,
      );
      const input: SplitUnitInput = {
        ...body,
        new_unit_id: uuidv7(),
        propagate_taggings: onUnit,
        new_tagging_ids: onUnit.map(() => uuidv7()),
      };
      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = splitUnit(content, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── merge_units (current taggings re-pointed) ──
  app.post(
    '/api/objects/:id/ops/merge-units',
    { schema: { body: MergeUnitsInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const input = req.body as MergeUnitsInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const currentTaggings = await loadCurrentTaggings(deps.db, id);
      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = mergeUnits(content, currentTaggings, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── toggle_expression_placement (glue mints the display + trailing unit ids) ──
  app.post(
    '/api/objects/:id/ops/toggle-placement',
    { schema: { body: ToggleExpressionPlacementInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as ToggleExpressionPlacementInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const input: ToggleExpressionPlacementInput = {
        ...body,
        display_unit_id: uuidv7(),
        trailing_unit_id: uuidv7(),
      };
      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = toggleExpressionPlacement(content, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── rewrite_surface (current links re-anchored) ──
  app.post(
    '/api/objects/:id/ops/rewrite-surface',
    { schema: { body: RewriteSurfaceInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const input = req.body as RewriteSurfaceInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      // Outbound `ExpressionSpan` anchors (re-anchored) + inbound cross-object `ExpressionRef` citations
      // (which rewrite_surface refuses to rename until target-side re-anchoring lands) — same edge set the
      // save_content keystone inspects, so the two paths agree on what a cited expression is.
      const currentLinks = [
        ...(await loadCurrentLinks(deps.db, id)),
        ...(await loadInboundLinks(deps.db, id)),
      ];
      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = rewriteSurface(content, currentLinks, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── insert_reference (glue mints the edge id) ──
  app.post(
    '/api/objects/:id/ops/insert-reference',
    { schema: { body: InsertReferenceInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as InsertReferenceInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const input: InsertReferenceInput = { ...body, link: { ...body.link, id: uuidv7() } };
      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = insertReference(content, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── resolve_occurrence (glue mints the edge id) ──
  app.post(
    '/api/objects/:id/ops/resolve-occurrence',
    { schema: { body: ResolveOccurrenceInputSchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as ResolveOccurrenceInput;
      const content = await loadContent(deps.db, ctx.spaceId, id);
      if (!content) throw new AppError(404, 'NOT_FOUND', 'no such object');

      const input: ResolveOccurrenceInput = { ...body, link_id: uuidv7() };
      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const result = resolveOccurrence(content, input, opCtx, now);
      return finish(deps, reply, id, ctx.spaceId, result, provenance, input.expected_revision, now);
    },
  );

  // ── materialize_object (source loaded from :id; glue mints all ids + the total id maps) ──
  app.post(
    '/api/objects/:id/ops/materialize',
    { schema: { body: MaterializeBodySchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const { expected_revision } = req.body as { expected_revision: number };
      const source = await loadObjectSubgraph(deps.db, ctx.spaceId, id);
      const sourceObject = source?.objects[0];
      if (!sourceObject) throw new AppError(404, 'NOT_FOUND', 'no such object');
      const sourceContent = source.content[0] ?? {
        object_id: id,
        revision: sourceObject.revision,
        units: [],
      };

      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const input: MaterializeObjectInput = {
        expected_revision,
        source_object: sourceObject,
        source_content: sourceContent,
        new_object_id: uuidv7(),
        new_provenance_id: provenance.id, // the new object's provenance IS this op's provenance
        edge_link_id: uuidv7(),
        expr_id_map: sourceContent.units
          .flatMap(expressionIdsOf)
          .map((from): ExpressionIdRemap => ({ from, to: uuidv7() })),
        unit_id_map: sourceContent.units.map((u): UnitIdRemap => ({ from: u.id, to: uuidv7() })),
      };
      const result = materializeObject(input, opCtx, now);
      // The new object is fresh — persist keys off outcome.content.object_id, no revision gate.
      const objectId = result.ok ? result.value.content.object_id : id;
      return finish(deps, reply, objectId, ctx.spaceId, result, provenance, expected_revision, now);
    },
  );

  // ── rehome_subtree (the §9.y greedy-capture materialize; :id = the host) ──
  app.post(
    '/api/objects/:id/ops/rehome',
    { schema: { body: RehomeBodySchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof RehomeBodySchema>;
      const hostObject = await loadObject(deps.db, ctx.spaceId, id);
      if (!hostObject) throw new AppError(404, 'NOT_FOUND', 'no such object');
      const hostContent = (await loadContent(deps.db, ctx.spaceId, id)) ?? {
        object_id: id,
        revision: hostObject.revision,
        units: [],
      };

      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const input: RehomeSubtreeInput = {
        expected_revision: body.expected_revision,
        host_object: hostObject,
        host_content: hostContent,
        subtree_root: body.subtree_root,
        new_object_id: uuidv7(),
        type: body.type as RehomeSubtreeInput['type'], // core validates producibility
        embed_unit_id: uuidv7(),
        new_version_id: uuidv7(),
      };
      const result = rehomeSubtree(input, opCtx, now);
      // The HOST is the gated object (host_content carries its bumped revision).
      return finish(deps, reply, id, ctx.spaceId, result, provenance, body.expected_revision, now);
    },
  );

  // ── dissolve_object (the inverse; :id = the host, dissolved id in the body) ──
  app.post(
    '/api/objects/:id/ops/dissolve',
    { schema: { body: DissolveBodySchema } },
    async (req, reply) => {
      const ctx = await requireSession(deps, req);
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DissolveBodySchema>;
      const hostContent = await loadContent(deps.db, ctx.spaceId, id);
      if (!hostContent) throw new AppError(404, 'NOT_FOUND', 'no such object');
      const dissolvedContent = await loadContent(deps.db, ctx.spaceId, body.dissolved_object_id);
      if (!dissolvedContent) throw new AppError(404, 'NOT_FOUND', 'no such dissolved object');

      // Infer the embed unit — the unique Embed{Object{dissolved}} in the host (the client need not
      // know an internal structural id; a wrong/absent one is the core's DissolveInputInconsistent).
      const embedUnit = hostContent.units.find(
        (u) =>
          u.content.kind === 'embed' &&
          u.content.target.kind === 'object' &&
          u.content.target.object_id === body.dissolved_object_id,
      );
      if (!embedUnit) throw new AppError(404, 'NOT_FOUND', 'no embed of that object in the host');

      // External inbound edges depend on the object's identity → the reviewable-refusal gate (§9.y).
      // Self-edges (source within the dissolved object) travel with the content and are NOT blockers.
      const inbound = await deps.db.query<{ id: string }>(
        `SELECT id FROM links WHERE target_object_id = $1 AND source_object_id <> $1`,
        [body.dissolved_object_id],
      );

      const { opCtx, provenance, now } = mintOp(deps, ctx.userId);
      const input: DissolveObjectInput = {
        expected_revision: body.expected_revision,
        expected_dissolved_revision: body.expected_dissolved_revision,
        host_content: hostContent,
        embed_unit_id: embedUnit.id,
        dissolved_object_id: body.dissolved_object_id,
        dissolved_content: dissolvedContent,
        inbound_references: inbound.rows.map((r) => r.id),
      };
      const result = dissolveObject(input, opCtx, now);
      return finish(
        deps,
        reply,
        id,
        ctx.spaceId,
        result,
        provenance,
        body.expected_revision,
        now,
        body.expected_dissolved_revision,
      );
    },
  );

  // ── GET labels (the §6.3b numbering projection over a default policy) ──
  app.get('/api/objects/:id/labels', async (req, reply) => {
    const ctx = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const graph = await loadObjectSubgraph(deps.db, ctx.spaceId, id);
    if (!graph) throw new AppError(404, 'NOT_FOUND', 'no such object');
    const units = graph.content[0]?.units ?? [];
    const result = projectNumbering(units, graph.aliases, graph.handles, DEFAULT_POLICY);
    if (!result.ok) return sendCoreError(reply, result.error);
    return reply.send(result.value);
  });

  // ── GET mathpack (export this object's subgraph) ──
  app.get('/api/objects/:id/mathpack', async (req, reply) => {
    const ctx = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const graph = await loadObjectSubgraph(deps.db, ctx.spaceId, id);
    if (!graph) throw new AppError(404, 'NOT_FOUND', 'no such object');
    const meta: MathpackMeta = { space_id: ctx.spaceId, asset_checksums: [] };
    const result = exportMathpack(meta, graph, deps.now());
    if (!result.ok) return sendCoreError(reply, result.error);
    return reply.send(result.value);
  });

  // ── POST import (validate + migrate + ECHO the untrusted pack; no persist in slice 1d) ──
  app.post('/api/mathpack/import', async (req, reply) => {
    await requireSession(deps, req);
    const result = importMathpack(req.body);
    // Untrusted body: malformed/future-schema packs are client errors (4xx), not server bugs.
    if (!result.ok) return sendCoreError(reply, result.error, { untrusted: true });
    return reply.send(result.value);
  });
}

/** Mint an op's OpContext + provenance row + read `now` once. */
function mintOp(
  deps: AppDeps,
  userId: string,
): { opCtx: OpContext; provenance: Provenance; now: Date } {
  const now = deps.now();
  const provenanceId = uuidv7();
  return {
    opCtx: { provenance_id: provenanceId, version_id: uuidv7() },
    provenance: {
      id: provenanceId,
      origin: 'user',
      created_by: userId,
      occurred_at: now.toISOString(),
    },
    now,
  };
}

/** Shared op tail: core error → status; else persist (409 on lost race); else 200 + outcome. */
async function finish(
  deps: AppDeps,
  reply: import('fastify').FastifyReply,
  objectId: string,
  spaceId: string,
  result:
    | { ok: true; value: OpOutcome }
    | { ok: false; error: import('@mathmeander/schema').CoreError },
  provenance: Provenance,
  expectedRevision: number,
  now: Date,
  expectedDissolvedRevision?: number,
): Promise<unknown> {
  if (!result.ok) return sendCoreError(reply, result.error);
  const { won, blockedReferences } = await persistObjectGraph(deps.db, objectId, result.value, {
    provenance,
    expectedRevision,
    now,
    expectedDissolvedRevision,
  });
  // The in-transaction dissolution re-check found a concurrently-added reference (TOCTOU) — surface
  // the SAME 422 the core's reviewable refusal produces.
  if (blockedReferences) {
    return sendCoreError(reply, {
      kind: 'validation',
      code: 'dissolution_blocked',
      references: blockedReferences,
    } as import('@mathmeander/schema').CoreError);
  }
  if (!won) {
    const revision = await currentRevision(deps.db, spaceId, objectId);
    throw new AppError(409, 'REVISION_CONFLICT', 'object changed since you read it', {
      current_revision: revision,
    });
  }
  return reply.send({ outcome: result.value });
}

function sendCoreError(
  reply: import('fastify').FastifyReply,
  error: import('@mathmeander/schema').CoreError,
  opts: { untrusted?: boolean } = {},
): unknown {
  const { status, body }: { status: number; body: ErrorBody } = opts.untrusted
    ? coreErrorToHttpUntrusted(error)
    : coreErrorToHttp(error);
  return reply.status(status).send(body);
}

/** Every `ExpressionId` inside one unit's content (a math unit's expr, or prose inline math). */
function expressionIdsOf(unit: Unit): string[] {
  const content = unit.content;
  if (content.kind === 'math') return [content.expr.id];
  if (content.kind === 'prose') {
    return content.inline.flatMap((el) => (el.kind === 'math' ? [el.expr.id] : []));
  }
  return [];
}
