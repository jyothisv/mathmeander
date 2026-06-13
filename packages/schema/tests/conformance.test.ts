// The TS half of the cross-validation suite: the GENERATED zod schemas must give
// verdicts identical to serde's on the shared conformance corpus (the Rust half lives
// in crates/core/src/schema_artifact.rs). Identical verdicts on both sides of the FFI
// is what "drift is a build error" means beyond type names.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemas } from '../src/generated/schemas';
import { ARTIFACT_HASH } from '../src/generated/artifact-hash';

const artifactDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifact');

interface Case {
  type: keyof typeof schemas;
  value: unknown;
  valid: boolean;
  note?: string;
}

const cases: Case[] = JSON.parse(readFileSync(join(artifactDir, 'conformance.json'), 'utf8'));

describe('generated zod schemas match serde verdicts', () => {
  for (const c of cases) {
    const label = `${c.type} ${JSON.stringify(c.value)?.slice(0, 70)} → ${
      c.valid ? 'valid' : 'invalid'
    }${c.note ? ` (${c.note})` : ''}`;
    it(label, () => {
      const schema = schemas[c.type];
      expect(schema, `no generated schema for ${c.type}`).toBeDefined();
      const result = schema.safeParse(c.value);
      if (result.success !== c.valid) {
        expect.fail(
          `zod disagrees with serde: expected ${c.valid ? 'valid' : 'invalid'}` +
            (result.success ? '' : `\nzod error: ${result.error.message}`),
        );
      }
    });
  }
});

describe('artifact hash lockstep', () => {
  it('ARTIFACT_HASH matches the committed artifact bytes', () => {
    const bytes = readFileSync(join(artifactDir, 'mathmeander-schema.json'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ARTIFACT_HASH);
  });
});
