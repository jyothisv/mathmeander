// THE FFI CHOKEPOINT — the only module in the workspace allowed to import
// @mathmeander/core-node (ESLint-enforced everywhere else). Every envelope coming back
// across the FFI is zod-parsed with the GENERATED schemas, so addon↔schema drift
// fails loudly at the boundary, never silently downstream.
import {
  artifactHash as addonArtifactHash,
  coreVersion as addonCoreVersion,
  createObject as addonCreateObject,
  applyTitlePatch as addonApplyTitlePatch,
  parseAndMigrateObject as addonParseAndMigrateObject,
  currentSchemaVersion as addonCurrentSchemaVersion,
} from '@mathmeander/core-node';
import {
  ARTIFACT_HASH,
  CreateObjectResultSchema,
  ObjectResultSchema,
  type CanonicalObject,
  type CreateContext,
  type CreateObjectInput,
  type CreateObjectResult,
  type ObjectPatch,
  type ObjectResult,
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
