// THE FFI CHOKEPOINT — the only module in the workspace allowed to import
// @mathmeander/core-node (ESLint-enforced everywhere else). Every envelope coming back
// across the FFI is zod-parsed with the GENERATED schemas, so addon↔schema drift
// fails loudly at the boundary, never silently downstream.
import {
  artifactHash as addonArtifactHash,
  coreVersion as addonCoreVersion,
  createObject as addonCreateObject,
  createJournalDay as addonCreateJournalDay,
  applyTitlePatch as addonApplyTitlePatch,
  parseAndMigrateObject as addonParseAndMigrateObject,
  currentSchemaVersion as addonCurrentSchemaVersion,
  setUnitType as addonSetUnitType,
  splitUnit as addonSplitUnit,
  mergeUnits as addonMergeUnits,
  toggleExpressionPlacement as addonToggleExpressionPlacement,
  rewriteSurface as addonRewriteSurface,
  insertReference as addonInsertReference,
  resolveOccurrence as addonResolveOccurrence,
  materializeObject as addonMaterializeObject,
  rehomeSubtree as addonRehomeSubtree,
  dissolveObject as addonDissolveObject,
  projectNumbering as addonProjectNumbering,
  exportMathpack as addonExportMathpack,
  importMathpack as addonImportMathpack,
} from '@mathmeander/core-node';
import {
  ARTIFACT_HASH,
  CreateObjectResultSchema,
  CreateJournalDayResultSchema,
  ObjectResultSchema,
  OpOutcomeResultSchema,
  NumberingResultSchema,
  MathpackResultSchema,
  MathpackImportResultSchema,
  type CanonicalObject,
  type CreateContext,
  type CreateObjectInput,
  type CreateObjectResult,
  type CreateJournalDayResult,
  type ObjectPatch,
  type ObjectResult,
  type MathContent,
  type OpContext,
  type OpOutcomeResult,
  type SetUnitTypeInput,
  type SplitUnitInput,
  type MergeUnitsInput,
  type ToggleExpressionPlacementInput,
  type RewriteSurfaceInput,
  type InsertReferenceInput,
  type ResolveOccurrenceInput,
  type MaterializeObjectInput,
  type RehomeSubtreeInput,
  type DissolveObjectInput,
  type Tagging,
  type Link,
  type Unit,
  type Alias,
  type Handle,
  type NumberingPolicy,
  type NumberingResult,
  type MathpackMeta,
  type MathpackGraph,
  type MathpackResult,
  type MathpackImportResult,
} from '@mathmeander/schema';

/// Boot handshake (debt guard #7): a stale addon is no server, not subtle bugs.
export function assertCoreLockstep(): { coreVersion: string; artifactHash: string } {
  const hash = addonArtifactHash();
  if (hash !== ARTIFACT_HASH) {
    throw new Error(
      `core/schema lockstep violation: the native addon was compiled against artifact ` +
        `${hash.slice(0, 12)}… but @mathmeander/schema carries ${ARTIFACT_HASH.slice(0, 12)}…. ` +
        `Run \`just codegen && just build-addon\` — someone changed core types without ` +
        `regenerating, or without rebuilding the addon.`,
    );
  }
  return { coreVersion: addonCoreVersion(), artifactHash: hash };
}

export function coreVersion(): string {
  return addonCoreVersion();
}

export function currentSchemaVersion(): number {
  return addonCurrentSchemaVersion();
}

export function createObject(
  input: CreateObjectInput,
  ctx: CreateContext,
  spaceId: string,
  now: Date,
): CreateObjectResult {
  const envelope = addonCreateObject(
    JSON.stringify(input),
    JSON.stringify(ctx),
    spaceId,
    now.toISOString(),
  );
  return CreateObjectResultSchema.parse(JSON.parse(envelope));
}

/**
 * Create a `journal_day` surface (§6.5): the date is parsed at the FFI boundary (ISO `YYYY-MM-DD`).
 * Yields the (object, provenance, detail) triplet the route persists in one transaction.
 */
export function createJournalDay(
  input: CreateObjectInput,
  ctx: CreateContext,
  spaceId: string,
  date: string,
  now: Date,
): CreateJournalDayResult {
  const envelope = addonCreateJournalDay(
    JSON.stringify(input),
    JSON.stringify(ctx),
    spaceId,
    date,
    now.toISOString(),
  );
  return CreateJournalDayResultSchema.parse(JSON.parse(envelope));
}

export function applyTitlePatch(
  current: CanonicalObject,
  patch: ObjectPatch,
  now: Date,
): ObjectResult {
  const envelope = addonApplyTitlePatch(
    JSON.stringify(current),
    JSON.stringify(patch),
    now.toISOString(),
  );
  return ObjectResultSchema.parse(JSON.parse(envelope));
}

export function parseAndMigrateObject(stored: unknown): ObjectResult {
  return ObjectResultSchema.parse(JSON.parse(addonParseAndMigrateObject(JSON.stringify(stored))));
}

// ── Slice 1c canonical operations. Each: typed args → JSON over the FFI → zod-parsed envelope.
// `content` is assembled from the SQL load; `input` is the request body with fresh ids the route
// minted; `ctx` carries the glue-minted provenance/version ids. merge/rewrite pass current rows.

export function setUnitType(
  content: MathContent,
  input: SetUnitTypeInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonSetUnitType(
        JSON.stringify(content),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function splitUnit(
  content: MathContent,
  input: SplitUnitInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonSplitUnit(
        JSON.stringify(content),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function mergeUnits(
  content: MathContent,
  currentTaggings: Tagging[],
  input: MergeUnitsInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonMergeUnits(
        JSON.stringify(content),
        JSON.stringify(currentTaggings),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function toggleExpressionPlacement(
  content: MathContent,
  input: ToggleExpressionPlacementInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonToggleExpressionPlacement(
        JSON.stringify(content),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function rewriteSurface(
  content: MathContent,
  currentLinks: Link[],
  input: RewriteSurfaceInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonRewriteSurface(
        JSON.stringify(content),
        JSON.stringify(currentLinks),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function insertReference(
  content: MathContent,
  input: InsertReferenceInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonInsertReference(
        JSON.stringify(content),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function resolveOccurrence(
  content: MathContent,
  input: ResolveOccurrenceInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonResolveOccurrence(
        JSON.stringify(content),
        JSON.stringify(input),
        JSON.stringify(ctx),
        now.toISOString(),
      ),
    ),
  );
}

export function materializeObject(
  input: MaterializeObjectInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(
      addonMaterializeObject(JSON.stringify(input), JSON.stringify(ctx), now.toISOString()),
    ),
  );
}

/** Re-home a declared subtree into a new object — the §9.y greedy-capture materialize. */
export function rehomeSubtree(
  input: RehomeSubtreeInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(addonRehomeSubtree(JSON.stringify(input), JSON.stringify(ctx), now.toISOString())),
  );
}

/** Dissolve a materialized object back into its host — the inverse of `rehomeSubtree`. */
export function dissolveObject(
  input: DissolveObjectInput,
  ctx: OpContext,
  now: Date,
): OpOutcomeResult {
  return OpOutcomeResultSchema.parse(
    JSON.parse(addonDissolveObject(JSON.stringify(input), JSON.stringify(ctx), now.toISOString())),
  );
}

// ── Slice 1d projections + packaging. ──

export function projectNumbering(
  units: Unit[],
  aliases: Alias[],
  handles: Handle[],
  policy: NumberingPolicy,
): NumberingResult {
  return NumberingResultSchema.parse(
    JSON.parse(
      addonProjectNumbering(
        JSON.stringify(units),
        JSON.stringify(aliases),
        JSON.stringify(handles),
        JSON.stringify(policy),
      ),
    ),
  );
}

export function exportMathpack(
  meta: MathpackMeta,
  graph: MathpackGraph,
  now: Date,
): MathpackResult {
  return MathpackResultSchema.parse(
    JSON.parse(addonExportMathpack(JSON.stringify(meta), JSON.stringify(graph), now.toISOString())),
  );
}

export function importMathpack(bundle: unknown): MathpackImportResult {
  return MathpackImportResultSchema.parse(JSON.parse(addonImportMathpack(JSON.stringify(bundle))));
}
