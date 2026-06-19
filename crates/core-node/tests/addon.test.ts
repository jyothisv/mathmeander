// FFI smoke test — the step-2 probe gate plus the step-3 lockstep proof:
// the addon builds, loads, answers from Rust, and the artifact hash it embedded at
// compile time equals the one @mathmeander/schema's codegen recorded. If these diverge,
// someone changed core types without running `just codegen` (or without rebuilding
// the addon) — the same check the server enforces at boot.
import { describe, expect, it } from 'vitest';
import {
  artifactHash,
  coreVersion,
  createObject,
  currentSchemaVersion,
  exportMathpack,
  importMathpack,
  parseAndMigrateObject,
  projectNumbering,
  setUnitType,
} from '../index.js';
import {
  ARTIFACT_HASH,
  CreateObjectResultSchema,
  MathpackImportResultSchema,
  MathpackResultSchema,
  NumberingResultSchema,
  ObjectResultSchema,
  OpOutcomeResultSchema,
  SCHEMA_VERSION,
} from '@mathmeander/schema';
import pkg from '../package.json' with { type: 'json' };

const EMPTY_GRAPH = {
  objects: [],
  provenance: [],
  provenance_derivations: [],
  content: [],
  links: [],
  aliases: [],
  handles: [],
  tags: [],
  taggings: [],
  object_versions: [],
  definition_details: [],
  journal_day_details: [],
};

describe('napi addon handshake', () => {
  it('coreVersion() answers from Rust and matches the workspace version', () => {
    expect(coreVersion()).toBe(pkg.version);
  });

  it('compile-time artifact hash is in lockstep with @mathmeander/schema', () => {
    expect(artifactHash()).toBe(ARTIFACT_HASH);
  });

  it('schema version crosses the FFI', () => {
    expect(currentSchemaVersion()).toBe(SCHEMA_VERSION);
  });
});

describe('result envelopes parse under the GENERATED zod schemas', () => {
  // This is the drift guard exercising on a real FFI call: whatever the core returns
  // must parse under the schema the artifact promised.
  it('a valid create round-trips: Rust constructs, generated zod accepts', () => {
    const envelope = createObject(
      JSON.stringify({ id: '0197675f-71f4-7000-8000-000000000001', type: 'note', title: 'ε-δ' }),
      JSON.stringify({
        provenance_id: '0197675f-71f4-7000-8000-000000000002',
        origin: 'user',
        created_by: 'user-1',
      }),
      '0197675f-71f4-7000-8000-000000000003',
      '2026-06-12T00:00:00Z',
    );
    const result = CreateObjectResultSchema.parse(JSON.parse(envelope));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.object.status).toBe('draft');
      expect(result.value.object.revision).toBe(1);
      expect(result.value.provenance.origin).toBe('user');
    }
  });

  it('a domain failure comes back as a typed error value, never a throw', () => {
    const envelope = createObject(
      JSON.stringify({ id: 'not-a-uuid', type: 'note' }),
      JSON.stringify({
        provenance_id: '0197675f-71f4-7000-8000-000000000002',
        origin: 'user',
        created_by: 'user-1',
      }),
      '0197675f-71f4-7000-8000-000000000003',
      '2026-06-12T00:00:00Z',
    );
    const result = CreateObjectResultSchema.parse(JSON.parse(envelope));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'validation', code: 'invalid_id' });
    }
  });

  it('the read path migrates and parses a stored object', () => {
    const stored = {
      id: '0197675f-71f4-7000-8000-000000000001',
      type: 'note',
      status: 'draft',
      schema_version: SCHEMA_VERSION,
      revision: 1,
      provenance_id: '0197675f-71f4-7000-8000-000000000002',
      space_id: '0197675f-71f4-7000-8000-000000000003',
      created_at: '2026-06-12T00:00:00Z',
      updated_at: '2026-06-12T00:00:00Z',
    };
    const result = ObjectResultSchema.parse(
      JSON.parse(parseAndMigrateObject(JSON.stringify(stored))),
    );
    expect(result.ok).toBe(true);
  });
});

describe('slice-1d FFI exports cross the real addon under the generated schemas', () => {
  it('projectNumbering returns a DisplayLabels envelope', () => {
    const envelope = projectNumbering(
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify({ numbered_types: [], shared_counter: false }),
    );
    const result = NumberingResultSchema.parse(JSON.parse(envelope));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.labels).toEqual([]);
  });

  it('an op surfaces a typed error envelope across the FFI (unit_not_found)', () => {
    const envelope = setUnitType(
      JSON.stringify({ object_id: '0197675f-71f4-7000-8000-0000000000a1', revision: 1, units: [] }),
      JSON.stringify({ expected_revision: 1, unit_id: '0197675f-71f4-7000-8000-0000000000b1' }),
      JSON.stringify({
        provenance_id: '0197675f-71f4-7000-8000-0000000000d1',
        version_id: '0197675f-71f4-7000-8000-00000000000a',
      }),
      '2026-06-12T00:00:00Z',
    );
    const result = OpOutcomeResultSchema.parse(JSON.parse(envelope));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({ kind: 'validation', code: 'unit_not_found' });
  });

  it('export → import round-trips an (empty) graph across the FFI', () => {
    const exportEnv = exportMathpack(
      JSON.stringify({ space_id: '0197675f-71f4-7000-8000-000000000003', asset_checksums: [] }),
      JSON.stringify(EMPTY_GRAPH),
      '2026-06-12T00:00:00Z',
    );
    const exported = MathpackResultSchema.parse(JSON.parse(exportEnv));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const importEnv = importMathpack(JSON.stringify(exported.value));
    const imported = MathpackImportResultSchema.parse(JSON.parse(importEnv));
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.graph).toEqual(exported.value.graph);
  });
});
