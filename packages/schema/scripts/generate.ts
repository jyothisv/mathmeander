// Generates src/generated/* from the core-emitted schema artifact.
// The ARTIFACT is the interface (arch doc §7); this generator is swappable — if
// json-schema-to-zod proves unfaithful, replace it behind the same artifact contract
// (the conformance suite is what decides "faithful").
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemaToZod } from 'json-schema-to-zod';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(pkgRoot, 'artifact');
const outDir = join(pkgRoot, 'src', 'generated');
mkdirSync(outDir, { recursive: true });

interface Artifact {
  artifact_version: number;
  schema_version: number;
  $defs: Record<string, object>;
}

const artifact: Artifact = JSON.parse(
  readFileSync(join(artifactDir, 'mathmeander-schema.json'), 'utf8'),
);
const hash = readFileSync(join(artifactDir, 'artifact-hash.txt'), 'utf8').trim();

const HEADER = `// GENERATED from the core schema artifact (packages/schema/artifact/) by
// scripts/generate.ts — DO NOT EDIT. Regenerate with \`just codegen\`.
`;

// Generator transform (the artifact itself is untouched): oneOf → anyOf.
// serde's union semantics are try-in-order ("at least one", with tagged variants made
// mutually exclusive by their const discriminator) — anyOf is the FAITHFUL encoding,
// and json-schema-to-zod turns it into a properly typed z.union instead of
// z.any().superRefine (whose z.infer collapses to `any`).
function oneOfToAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(oneOfToAnyOf);
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [
        k === 'oneOf' ? 'anyOf' : k,
        oneOfToAnyOf(v),
      ]),
    );
  }
  return node;
}

const names = Object.keys(artifact.$defs).sort();

// schemas.ts — one zod schema per artifact definition + a name→schema registry.
const schemaParts: string[] = [HEADER, `import { z } from 'zod';`, ''];
for (const name of names) {
  const def = oneOfToAnyOf(artifact.$defs[name]) as object;
  const expr = jsonSchemaToZod(def, { module: 'none' });
  schemaParts.push(`export const ${name}Schema = ${expr};`, '');
}
schemaParts.push(
  `export const schemas = {`,
  ...names.map((n) => `  ${n}: ${n}Schema,`),
  `} as const;`,
  '',
);
writeFileSync(join(outDir, 'schemas.ts'), schemaParts.join('\n'));

// types.ts — TS types inferred from the generated schemas (never hand-written).
const typeParts: string[] = [
  HEADER,
  `import type { z } from 'zod';`,
  `import {`,
  ...names.map((n) => `  ${n}Schema,`),
  `} from './schemas';`,
  '',
  ...names.map((n) => `export type ${n} = z.infer<typeof ${n}Schema>;`),
  '',
];
writeFileSync(join(outDir, 'types.ts'), typeParts.join('\n'));

// artifact-hash.ts — the lockstep constant for the FFI boot handshake (the addon embeds
// the same hash at compile time; the server refuses to boot on mismatch).
writeFileSync(
  join(outDir, 'artifact-hash.ts'),
  [
    HEADER,
    `export const ARTIFACT_HASH = '${hash}';`,
    `export const ARTIFACT_VERSION = ${artifact.artifact_version};`,
    `export const SCHEMA_VERSION = ${artifact.schema_version};`,
    '',
  ].join('\n'),
);

// banned-names.json — consumed by the root eslint config: hand-declaring a type or
// interface with one of these names anywhere outside this package is a lint error
// (debt guard #1: no hand-written copies of core types, mechanically).
writeFileSync(join(outDir, 'banned-names.json'), JSON.stringify(names, null, 2) + '\n');

console.log(`generated ${names.length} schemas (artifact sha256 ${hash.slice(0, 12)}…)`);
