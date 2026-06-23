// Slice 1d end-to-end (API level — no editor UI): create a note → seed a prose unit → drive the
// canonical-op endpoints (load → core → persist) → numbering + mathpack export → import echo.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  bearer,
  createStack,
  seedObjectWithProse,
  truncateAll,
  type TestStack,
} from './helpers.js';

let stack: TestStack;
let token: string;

beforeAll(async () => {
  stack = await createStack();
});
afterAll(async () => {
  await stack.close();
});
beforeEach(async () => {
  await truncateAll(stack.db);
  token = await stack.login('mathematician@example.com');
});

describe('canonical operation endpoints', () => {
  test('split-unit loads → ops → persists: two units, expression ids preserved, revision bumped', async () => {
    const { objectId, unitId } = await seedObjectWithProse(stack, token, { text: 'hello world' });

    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${objectId}/ops/split-unit`,
      headers: bearer(token),
      payload: {
        expected_revision: 1, // create stamped revision 1; seed adds content without bumping it
        unit_id: unitId,
        at: 5,
        new_unit_id: uuidv7(), // overwritten server-side
        propagate_taggings: [],
        new_tagging_ids: [],
      },
    });
    expect(res.statusCode).toBe(200);
    const outcome = (res.json() as { outcome: { content: { revision: number; units: unknown[] } } })
      .outcome;
    expect(outcome.content.units).toHaveLength(2);
    expect(outcome.content.revision).toBe(2);

    // Persisted: the export reflects two units at the bumped revision.
    const pack = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}/mathpack`,
      headers: bearer(token),
    });
    expect(pack.statusCode).toBe(200);
    const graph = pack.json() as {
      manifest: { counts: { units: number } };
      graph: { objects: { revision: number }[] };
    };
    expect(graph.manifest.counts.units).toBe(2);
    expect(graph.graph.objects[0]?.revision).toBe(2);
  });

  test('a stale expected_revision loses the conditional write → 409', async () => {
    const { objectId, unitId } = await seedObjectWithProse(stack, token, { text: 'hello world' });
    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${objectId}/ops/split-unit`,
      headers: bearer(token),
      payload: {
        expected_revision: 99, // not the current revision (1)
        unit_id: unitId,
        at: 5,
        new_unit_id: uuidv7(),
        propagate_taggings: [],
        new_tagging_ids: [],
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
  });

  test('set-unit-type then labels: the numbering projection numbers the typed unit', async () => {
    const { objectId, unitId } = await seedObjectWithProse(stack, token, { text: 'A theorem.' });

    const typed = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${objectId}/ops/set-unit-type`,
      headers: bearer(token),
      payload: { expected_revision: 1, unit_id: unitId, unit_type: 'theorem' },
    });
    expect(typed.statusCode).toBe(200);

    const labels = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}/labels`,
      headers: bearer(token),
    });
    expect(labels.statusCode).toBe(200);
    const { labels: list } = labels.json() as {
      labels: { unit_id: string; unit_type: string | null; number: number | null }[];
    };
    const theLabel = list.find((l) => l.unit_id === unitId);
    expect(theLabel?.unit_type).toBe('theorem');
    expect(theLabel?.number).toBe(1);
  });

  test('mathpack export → import echo: the canonical graph round-trips identically', async () => {
    const { objectId } = await seedObjectWithProse(stack, token, { text: 'round trip' });

    const exported = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}/mathpack`,
      headers: bearer(token),
    });
    expect(exported.statusCode).toBe(200);
    const exportedPack = exported.json() as { manifest: unknown; graph: unknown };

    const imported = await stack.app.inject({
      method: 'POST',
      url: '/api/mathpack/import',
      headers: bearer(token),
      payload: exportedPack,
    });
    expect(imported.statusCode).toBe(200);
    const importedPack = imported.json() as { manifest: unknown; graph: unknown };
    expect(importedPack.graph).toEqual(exportedPack.graph);
    expect(importedPack.manifest).toEqual(exportedPack.manifest);
  });

  test('import is the untrusted gate: a pack with an out-of-bounds inline span is refused (422)', async () => {
    const { objectId } = await seedObjectWithProse(stack, token, { text: 'xy' });
    const exported = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}/mathpack`,
      headers: bearer(token),
    });
    const pack = exported.json() as {
      graph: { content: { units: { content: unknown }[] }[] };
    };
    // Inject a width-bearing/out-of-bounds inline atom into the (otherwise valid) pack.
    pack.graph.content[0]!.units[0]!.content = {
      kind: 'prose',
      text: 'xy',
      inline: [
        {
          kind: 'math',
          span: { start: 9, end: 9 }, // past the end of "xy"
          expr: {
            id: uuidv7(),
            surface_text: 'x',
            surface_format: 'mathmeander',
            original_input: 'x',
            parse_status: 'renderable',
            occurrences: [],
          },
        },
      ],
    };

    const imported = await stack.app.inject({
      method: 'POST',
      url: '/api/mathpack/import',
      headers: bearer(token),
      payload: pack,
    });
    expect(imported.statusCode).toBe(422);
    expect((imported.json() as { error: { code: string } }).error.code).toBe(
      'inline_span_out_of_bounds',
    );
  });

  test('a garbled import body is a client error (422 malformed_input), not a 500', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/api/mathpack/import',
      headers: bearer(token),
      payload: { not: 'a pack' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('malformed_input');
  });

  test('a future-schema pack upload is a client error (422), not a 500', async () => {
    const { objectId } = await seedObjectWithProse(stack, token, { text: 'future' });
    const exported = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}/mathpack`,
      headers: bearer(token),
    });
    const pack = exported.json() as { manifest: { schema_version: number } };
    pack.manifest.schema_version = 999; // claims a schema newer than this core understands

    const res = await stack.app.inject({
      method: 'POST',
      url: '/api/mathpack/import',
      headers: bearer(token),
      payload: pack,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'schema_version_from_the_future',
    );
  });
});

describe('insert-equations (slice 2-A math-row model)', () => {
  const mathExpr = (surface: string) => ({
    id: uuidv7(),
    surface_text: surface,
    surface_format: 'mathmeander',
    original_input: surface,
    parse_status: 'renderable',
    occurrences: [],
  });

  type UnitShape = {
    id: string;
    parent_unit_id?: string;
    row_relation?: string;
    content: { kind: string };
  };

  test('mints an Equations container + co-equal rows; parent_unit_id + row_relation persist', async () => {
    const { objectId, unitId } = await seedObjectWithProse(stack, token, { text: 'A system:' });

    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${objectId}/ops/insert-equations`,
      headers: bearer(token),
      payload: {
        expected_revision: 1,
        anchor_unit_id: unitId,
        container_unit_id: uuidv7(), // overwritten server-side
        rows: [
          {
            unit_id: uuidv7(),
            content: { kind: 'math', expr: mathExpr('2x+y=1') },
            row_relation: 'eq',
          },
          { unit_id: uuidv7(), content: { kind: 'math', expr: mathExpr('x-y=4') } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const outcome = (
      res.json() as { outcome: { content: { revision: number; units: UnitShape[] } } }
    ).outcome;
    expect(outcome.content.revision).toBe(2);
    const container = outcome.content.units.find((u) => u.content.kind === 'equations');
    expect(container).toBeDefined();
    const rows = outcome.content.units.filter((u) => u.parent_unit_id === container!.id);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.row_relation === 'eq')).toBe(true);

    // Persisted: reload via mathpack export — container + 2 rows + the seeded prose = 4 units,
    // and row_relation round-trips through the new column.
    const pack = await stack.app.inject({
      method: 'GET',
      url: `/api/objects/${objectId}/mathpack`,
      headers: bearer(token),
    });
    expect(pack.statusCode).toBe(200);
    const graph = pack.json() as {
      manifest: { counts: { units: number } };
      graph: { content: { units: UnitShape[] }[] };
    };
    expect(graph.manifest.counts.units).toBe(4);
    const persisted = graph.graph.content.flatMap((c) => c.units);
    const persistedContainer = persisted.find((u) => u.content.kind === 'equations');
    expect(persistedContainer).toBeDefined();
    const persistedRows = persisted.filter((u) => u.parent_unit_id === persistedContainer!.id);
    expect(persistedRows).toHaveLength(2);
    expect(persistedRows.some((r) => r.row_relation === 'eq')).toBe(true);
  });

  test('a non-math/prose row is refused → 422 (one level only, §F2)', async () => {
    const { objectId, unitId } = await seedObjectWithProse(stack, token, { text: 'x' });
    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${objectId}/ops/insert-equations`,
      headers: bearer(token),
      payload: {
        expected_revision: 1,
        anchor_unit_id: unitId,
        container_unit_id: uuidv7(),
        rows: [{ unit_id: uuidv7(), content: { kind: 'group' } }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'equations_row_not_permitted',
    );
  });

  test('a stale expected_revision loses the conditional write → 409', async () => {
    const { objectId, unitId } = await seedObjectWithProse(stack, token, { text: 'x' });
    const res = await stack.app.inject({
      method: 'POST',
      url: `/api/objects/${objectId}/ops/insert-equations`,
      headers: bearer(token),
      payload: {
        expected_revision: 99,
        anchor_unit_id: unitId,
        container_unit_id: uuidv7(),
        rows: [{ unit_id: uuidv7(), content: { kind: 'math', expr: mathExpr('a=b') } }],
      },
    });
    expect(res.statusCode).toBe(409);
  });
});
