// seedDayContent — the pure, immutable cache updater (no react-query needed).
import { describe, expect, it } from 'vitest';
import type { CanonicalObject, MathContent, MathpackGraph } from '@mathmeander/schema';
import type { JournalDayEager } from '../api/client';
import { seedDayContent } from './cacheSeed';

const OBJ = '0197675f-71f4-7000-8000-000000000001';
const OTHER = '0197675f-71f4-7000-8000-000000000002';
const PROV = '0197675f-71f4-7000-8000-0000000000d1';
const SPACE = '0197675f-71f4-7000-8000-0000000000f1';
const ISO = '2026-06-19T00:00:00.000Z';

const object: CanonicalObject = {
  id: OBJ,
  type: 'journal_day',
  status: 'draft',
  schema_version: 1,
  revision: 1,
  provenance_id: PROV,
  space_id: SPACE,
  created_at: ISO,
  updated_at: ISO,
};

const mc = (objectId: string, revision: number): MathContent => ({
  object_id: objectId,
  revision,
  units: [],
});

const graph = (content: MathContent[]): MathpackGraph => ({
  objects: [],
  provenance: [],
  provenance_derivations: [],
  content,
  links: [],
  aliases: [],
  handles: [],
  tags: [],
  taggings: [],
  object_versions: [],
  definition_details: [],
  journal_day_details: [],
  notebook_details: [],
});

const eager = (content: MathContent[]): JournalDayEager => ({
  object,
  date: '2026-06-19',
  graph: graph(content),
});

describe('seedDayContent', () => {
  it('no-ops (returns undefined) when nothing is cached', () => {
    expect(seedDayContent(undefined, OBJ, mc(OBJ, 2))).toBeUndefined();
  });

  it('replaces the matching day entry, leaves siblings untouched, and is immutable', () => {
    const prev = eager([mc(OBJ, 1), mc(OTHER, 1)]);
    const next = seedDayContent(prev, OBJ, mc(OBJ, 2));
    expect(next).not.toBe(prev); // new object
    expect(next!.graph.content[0]!.revision).toBe(2); // updated
    expect(next!.graph.content[1]!.object_id).toBe(OTHER); // sibling preserved
    expect(prev.graph.content[0]!.revision).toBe(1); // prev not mutated
  });

  it('appends when the day content is absent from the cached graph', () => {
    const prev = eager([mc(OTHER, 1)]);
    const next = seedDayContent(prev, OBJ, mc(OBJ, 2));
    expect(next!.graph.content).toHaveLength(2);
    expect(next!.graph.content.some((c) => c.object_id === OBJ)).toBe(true);
  });

  it('preserves object, date, and other graph fields', () => {
    const prev = eager([mc(OBJ, 1)]);
    const next = seedDayContent(prev, OBJ, mc(OBJ, 2))!;
    expect(next.object).toBe(prev.object);
    expect(next.date).toBe('2026-06-19');
    expect(next.graph.objects).toBe(prev.graph.objects);
  });
});
