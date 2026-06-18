// Exhaustiveness gate: every core `ValidationError` code must have an HTTP-status mapping, so a
// future core variant can't ship unmapped (silently defaulting to 500). The code set is derived
// from the generated schema artifact ($defs.ValidationError) — the same source the FFI uses.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CORE_CODE_STATUS } from '../../src/http/errors.js';

interface VariantSchema {
  properties?: { code?: { const?: string } };
}
interface Artifact {
  $defs: { ValidationError: { anyOf?: VariantSchema[]; oneOf?: VariantSchema[] } };
}

const artifactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../schema/artifact/mathmeander-schema.json',
);
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Artifact;
const variants = artifact.$defs.ValidationError.anyOf ?? artifact.$defs.ValidationError.oneOf ?? [];
const codes = variants.map((v) => v.properties?.code?.const).filter((c): c is string => Boolean(c));

describe('CORE_CODE_STATUS', () => {
  test('every ValidationError code in the artifact has a status mapping', () => {
    expect(codes.length).toBeGreaterThan(0);
    const unmapped = codes.filter((code) => !(code in CORE_CODE_STATUS));
    expect(unmapped).toEqual([]);
  });

  test('every mapping is a 4xx or 5xx status', () => {
    for (const [code, status] of Object.entries(CORE_CODE_STATUS)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  test('no stale keys: every mapped code still exists in the artifact', () => {
    const artifactCodes = new Set(codes);
    const stale = Object.keys(CORE_CODE_STATUS).filter((code) => !artifactCodes.has(code));
    expect(stale).toEqual([]);
  });
});
