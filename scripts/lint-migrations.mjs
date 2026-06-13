#!/usr/bin/env node
// Migration linter — structural guards over db/migrations/*.sql (mechanisms, not advice):
//   1. No native PG enums on evolving kinds: forbids CREATE TYPE ... AS ENUM
//      (vocabularies live in the Rust core ONLY — arch doc §6 enum-vs-text).
//   2. No JSONB dumping grounds: every jsonb column must be registered in
//      docs/jsonb-registry.md, mapping it to a named core tagged union (arch doc §6.1d).
//   3. No DB-minted ids: forbids DEFAULT gen_random_uuid()/uuidv7() on id columns
//      (ids are client/core-minted UUIDv7 — the offline/multi-device reservation).
//   4. provenance_id must never be made nullable (arch doc §6: NOT NULL spine).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const registryPath = join(root, 'docs', 'jsonb-registry.md');

if (!existsSync(migrationsDir)) {
  console.log('OK: no migrations yet');
  process.exit(0);
}

const registry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const errors = [];

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const lines = sql.split('\n');

  lines.forEach((line, i) => {
    const loc = `${file}:${i + 1}`;
    const stripped = line.replace(/--.*$/, '');

    if (/\bAS\s+ENUM\b/i.test(stripped)) {
      errors.push(
        `${loc}: native PG enum — evolving kinds are text validated by the core only (arch doc §6)`,
      );
    }

    // jsonb columns in CREATE TABLE bodies ("col jsonb …") and ALTER TABLE ADD COLUMN.
    const jsonbCol =
      stripped.match(/^\s*"?([a-z_]+)"?\s+jsonb\b/i) ??
      stripped.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?\s+jsonb\b/i);
    if (jsonbCol) {
      const col = jsonbCol[1];
      if (!registry.includes(col)) {
        errors.push(
          `${loc}: jsonb column "${col}" not registered in docs/jsonb-registry.md — ` +
            `every jsonb column maps to a named core tagged union (arch doc §6.1d)`,
        );
      }
    }

    if (/\bid\b[^,]*DEFAULT\s+(gen_random_uuid|uuidv7|uuid_generate)/i.test(stripped)) {
      errors.push(`${loc}: DB-minted id default — ids are client/core-minted UUIDv7`);
    }

    if (/ALTER\s+(TABLE\s+\S+\s+)?.*provenance_id\s+DROP\s+NOT\s+NULL/i.test(stripped)) {
      errors.push(`${loc}: provenance_id must stay NOT NULL (arch doc §6)`);
    }
  });
}

if (errors.length > 0) {
  console.error(`FAIL: migration lint (${errors.length} violation${errors.length > 1 ? 's' : ''})`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(`OK: ${files.length} migration file(s) clean`);
