// Plain SQL graph layer (arch doc §4/§7 — no ORM) for the slice-1d canonical operations.
// The glue persists EXACTLY what the core's `OpOutcome` returned, in one transaction, in FK-safe
// order, with the §6.4 conditional-revision gate. GENERATED columns (`content_kind`,
// `in_expression`) are NEVER written. Reads assemble the working aggregates the ops need; they
// stay dumb (the core op re-validates whatever we load).
import type pg from 'pg';
import type {
  Alias,
  CanonicalObject,
  DefinitionDetail,
  Handle,
  Link,
  MathContent,
  MathpackGraph,
  ObjectVersion,
  OpOutcome,
  Provenance,
  Tag,
  Tagging,
  Unit,
} from '@mathmeander/schema';
import { withTransaction } from './pool.js';

type Queryable = pg.Pool | pg.PoolClient;

// ── Row → model mappers (tri-state: omit NULL columns; jsonb is pre-parsed; ts → ISO) ──

function omitNull<T>(key: string, value: T | null): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

interface UnitRow {
  id: string;
  object_id: string;
  parent_unit_id: string | null;
  position: number;
  slot: string | null;
  type: string | null;
  example_kind: string | null;
  status: string;
  declared_by: string;
  extracted_structure: unknown | null;
  content: unknown;
  provenance_id: string;
}

function rowToUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    object_id: row.object_id,
    position: row.position,
    status: row.status,
    declared_by: row.declared_by,
    content: row.content,
    provenance_id: row.provenance_id,
    ...omitNull('parent_unit_id', row.parent_unit_id),
    ...omitNull('slot', row.slot),
    ...omitNull('type', row.type),
    ...omitNull('example_kind', row.example_kind),
    ...omitNull('extracted_structure', row.extracted_structure),
  } as Unit;
}

const UNIT_COLUMNS = `id, object_id, parent_unit_id, position, slot, type, example_kind, status,
                      declared_by, extracted_structure, content, provenance_id`;

interface LinkRow {
  id: string;
  source_object_id: string;
  target_object_id: string | null;
  target_unit_id: string | null;
  unresolved_text: string | null;
  target_selector: unknown | null;
  type: string;
  status: string;
  from_content: boolean;
  source_unit_id: string | null;
  content_locator: unknown | null;
  provenance_id: string;
  created_at: Date;
}

function rowToLink(row: LinkRow): Link {
  return {
    id: row.id,
    source_object_id: row.source_object_id,
    type: row.type,
    status: row.status,
    from_content: row.from_content,
    provenance_id: row.provenance_id,
    created_at: row.created_at.toISOString(),
    ...omitNull('target_object_id', row.target_object_id),
    ...omitNull('target_unit_id', row.target_unit_id),
    ...omitNull('unresolved_text', row.unresolved_text),
    ...omitNull('target_selector', row.target_selector),
    ...omitNull('source_unit_id', row.source_unit_id),
    ...omitNull('content_locator', row.content_locator),
  } as Link;
}

const LINK_COLUMNS = `id, source_object_id, target_object_id, target_unit_id, unresolved_text,
                      target_selector, type, status, from_content, source_unit_id, content_locator,
                      provenance_id, created_at`;

interface TaggingRow {
  id: string;
  tag_id: string;
  tagged_object_id: string | null;
  tagged_unit_id: string | null;
  created_at: Date;
}

function rowToTagging(row: TaggingRow): Tagging {
  return {
    id: row.id,
    tag_id: row.tag_id,
    created_at: row.created_at.toISOString(),
    ...omitNull('tagged_object_id', row.tagged_object_id),
    ...omitNull('tagged_unit_id', row.tagged_unit_id),
  } as Tagging;
}

// ── Reads (ops) ──────────────────────────────────────────────────────────────

/** The working content aggregate an op transforms. Null if the object is missing/cross-space. */
export async function loadContent(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<MathContent | null> {
  const head = await db.query<{ revision: number }>(
    `SELECT revision FROM objects WHERE id = $1 AND space_id = $2`,
    [objectId, spaceId],
  );
  const headRow = head.rows[0];
  if (!headRow) return null;
  const units = await db.query<UnitRow>(
    `SELECT ${UNIT_COLUMNS} FROM content_units WHERE object_id = $1
     ORDER BY parent_unit_id NULLS FIRST, position`,
    [objectId],
  );
  return { object_id: objectId, revision: headRow.revision, units: units.rows.map(rowToUnit) };
}

/** Inbound edges anchored in this object's content (rewrite_surface re-anchors these). */
export async function loadCurrentLinks(db: Queryable, objectId: string): Promise<Link[]> {
  const res = await db.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM links WHERE source_object_id = $1`,
    [objectId],
  );
  return res.rows.map(rowToLink);
}

/** Taggings on this object's units (merge_units re-points / dedups these). */
export async function loadCurrentTaggings(db: Queryable, objectId: string): Promise<Tagging[]> {
  const res = await db.query<TaggingRow>(
    `SELECT id, tag_id, tagged_object_id, tagged_unit_id, created_at FROM taggings
     WHERE tagged_unit_id IN (SELECT id FROM content_units WHERE object_id = $1)`,
    [objectId],
  );
  return res.rows.map(rowToTagging);
}

/** The single-object subgraph for `.mathpack` export (one MathpackGraph; empty for absent kinds). */
export async function loadObjectSubgraph(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<MathpackGraph | null> {
  const objRes = await db.query<ObjectRow>(
    `SELECT id, type, title, raw_source, status, schema_version, revision, provenance_id, space_id,
            created_at, updated_at
     FROM objects WHERE id = $1 AND space_id = $2`,
    [objectId, spaceId],
  );
  const objRow = objRes.rows[0];
  if (!objRow) return null;
  const object = rowToObject(objRow);
  const content = await loadContent(db, spaceId, objectId);
  const links = await loadCurrentLinks(db, objectId);

  const aliases = (
    await db.query<AliasRow>(
      `SELECT id, object_id, name, kind, scope, scope_ref FROM aliases WHERE object_id = $1`,
      [objectId],
    )
  ).rows.map(rowToAlias);
  const handles = (
    await db.query<HandleRow>(
      `SELECT id, space_id, name, target_object_id, target_unit_id, target_expression_id, status, scope, provenance_id
       FROM handles WHERE target_object_id = $1`,
      [objectId],
    )
  ).rows.map(rowToHandle);
  const taggings = (
    await db.query<TaggingRow>(
      `SELECT id, tag_id, tagged_object_id, tagged_unit_id, created_at FROM taggings
       WHERE tagged_object_id = $1 OR tagged_unit_id IN (SELECT id FROM content_units WHERE object_id = $1)`,
      [objectId],
    )
  ).rows.map(rowToTagging);
  const tags = taggings.length
    ? (
        await db.query<TagRow>(`SELECT id, space_id, name FROM tags WHERE id = ANY($1)`, [
          taggings.map((t) => t.tag_id),
        ])
      ).rows.map(rowToTag)
    : [];
  const objectVersions = (
    await db.query<ObjectVersionRow>(
      `SELECT id, object_id, version_no, snapshot, provenance_id, created_at FROM object_versions WHERE object_id = $1`,
      [objectId],
    )
  ).rows.map(rowToObjectVersion);
  const definitionDetails = (
    await db.query<{ object_id: string; term: string }>(
      `SELECT object_id, term FROM definition_detail WHERE object_id = $1`,
      [objectId],
    )
  ).rows.map((r) => ({ object_id: r.object_id, term: r.term }) satisfies DefinitionDetail);

  // The trust spine: every provenance row the subgraph references travels too.
  const provenanceIds = new Set<string>([object.provenance_id]);
  for (const u of content?.units ?? []) provenanceIds.add(u.provenance_id);
  for (const l of links) provenanceIds.add(l.provenance_id);
  for (const h of handles) provenanceIds.add(h.provenance_id);
  for (const v of objectVersions) provenanceIds.add(v.provenance_id);
  const provenance = (
    await db.query<ProvenanceRow>(
      `SELECT id, origin, created_by, occurred_at FROM provenance WHERE id = ANY($1)`,
      [[...provenanceIds]],
    )
  ).rows.map(rowToProvenance);
  const provenanceDerivations = (
    await db.query<{ provenance_id: string; derived_from_provenance_id: string }>(
      `SELECT provenance_id, derived_from_provenance_id FROM provenance_derivations WHERE provenance_id = ANY($1)`,
      [[...provenanceIds]],
    )
  ).rows.map((r) => ({
    provenance_id: r.provenance_id,
    derived_from_provenance_id: r.derived_from_provenance_id,
  }));

  return {
    objects: [object],
    provenance,
    provenance_derivations: provenanceDerivations,
    content: content ? [content] : [],
    links,
    aliases,
    handles,
    tags,
    taggings,
    object_versions: objectVersions,
    definition_details: definitionDetails,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Thrown to roll back a lost optimistic-concurrency race; caught → `{ won: false }` (→ 409). */
class RevisionConflict extends Error {}

/**
 * Persist an op's `OpOutcome` in ONE transaction, FK-safe. Source-mutating ops gate on the
 * conditional revision UPDATE (lost race → rollback → `{ won: false }`); `materialize_object`
 * (outcome.new_objects non-empty) inserts a fresh object instead (no gate). GENERATED columns are
 * never written. `provenance` is the op's row (stamps emitted edges / version / new unit rows).
 */
export async function persistObjectGraph(
  db: pg.Pool,
  objectId: string,
  outcome: OpOutcome,
  opts: { provenance: Provenance; expectedRevision: number; now: Date },
): Promise<{ won: boolean }> {
  try {
    await withTransaction(db, async (client) => {
      await upsertProvenance(client, opts.provenance);

      if (outcome.new_objects.length > 0) {
        for (const created of outcome.new_objects) await insertObjectRow(client, created);
        await replaceContentUnits(client, outcome.content.object_id, outcome.content.units);
      } else {
        const bumped = await client.query(
          `UPDATE objects SET revision = $1, updated_at = $2 WHERE id = $3 AND revision = $4`,
          [outcome.content.revision, opts.now.toISOString(), objectId, opts.expectedRevision],
        );
        if (bumped.rowCount !== 1) throw new RevisionConflict();
        await replaceContentUnits(client, objectId, outcome.content.units);
      }

      for (const link of outcome.links_upserted) await upsertLink(client, link);
      if (outcome.links_staled.length > 0) {
        await client.query(`UPDATE links SET status = 'stale' WHERE id = ANY($1)`, [
          outcome.links_staled,
        ]);
      }
      for (const tagging of outcome.taggings_propagated) await upsertTagging(client, tagging);
      await insertObjectVersion(client, outcome.version_snapshot);
    });
  } catch (err) {
    if (err instanceof RevisionConflict) return { won: false };
    throw err;
  }
  return { won: true };
}

/**
 * Seed an object's initial content (one transaction). SLICE-2: this stands in for the editor's
 * authoring path — no 1c op creates a unit from nothing, so tests/dev seed through the real
 * persistence primitives.
 */
export async function seedContent(
  db: pg.Pool,
  objectId: string,
  units: Unit[],
  provenance: Provenance,
): Promise<void> {
  await withTransaction(db, async (client) => {
    await upsertProvenance(client, provenance);
    await replaceContentUnits(client, objectId, units);
  });
}

async function upsertProvenance(client: pg.PoolClient, p: Provenance): Promise<void> {
  await client.query(
    `INSERT INTO provenance (id, origin, created_by, occurred_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [p.id, p.origin, p.created_by ?? null, p.occurred_at],
  );
}

async function insertObjectRow(client: pg.PoolClient, o: CanonicalObject): Promise<void> {
  await client.query(
    `INSERT INTO objects (id, type, title, raw_source, status, schema_version, revision,
                          provenance_id, space_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      o.id,
      o.type,
      o.title ?? null,
      o.raw_source ?? null,
      o.status,
      o.schema_version,
      o.revision,
      o.provenance_id,
      o.space_id,
      o.created_at,
      o.updated_at,
    ],
  );
}

/**
 * Delete-all-then-insert the full units vec (the authoritative content the core returned). This
 * sidesteps the `UNIQUE NULLS NOT DISTINCT (object_id, parent_unit_id, position)` transient
 * collision a split's position shift would otherwise cause on a per-row upsert. Parents are
 * inserted before children. `content_kind` is GENERATED — never written.
 */
async function replaceContentUnits(
  client: pg.PoolClient,
  objectId: string,
  units: Unit[],
): Promise<void> {
  await client.query(`DELETE FROM content_units WHERE object_id = $1`, [objectId]);
  for (const u of parentsFirst(units)) {
    await client.query(
      `INSERT INTO content_units
         (id, object_id, parent_unit_id, position, slot, type, example_kind, status,
          declared_by, extracted_structure, content, provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        u.id,
        u.object_id,
        u.parent_unit_id ?? null,
        u.position,
        u.slot ?? null,
        u.type ?? null,
        u.example_kind ?? null,
        u.status,
        u.declared_by,
        u.extracted_structure == null ? null : JSON.stringify(u.extracted_structure),
        JSON.stringify(u.content),
        u.provenance_id,
      ],
    );
  }
}

/** Topological order so a unit's parent is inserted before it (the composite FK requires it). */
function parentsFirst(units: Unit[]): Unit[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const done = new Set<string>();
  const out: Unit[] = [];
  const visit = (u: Unit, seen: Set<string>) => {
    if (done.has(u.id) || seen.has(u.id)) return;
    seen.add(u.id);
    const parentId = u.parent_unit_id;
    if (parentId != null && byId.has(parentId)) visit(byId.get(parentId)!, seen);
    done.add(u.id);
    out.push(u);
  };
  for (const u of units) visit(u, new Set());
  return out;
}

async function upsertLink(client: pg.PoolClient, l: Link): Promise<void> {
  await client.query(
    `INSERT INTO links
       (id, source_object_id, target_object_id, target_unit_id, unresolved_text, target_selector,
        type, status, from_content, source_unit_id, content_locator, provenance_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       target_object_id = EXCLUDED.target_object_id, target_unit_id = EXCLUDED.target_unit_id,
       unresolved_text = EXCLUDED.unresolved_text, target_selector = EXCLUDED.target_selector,
       type = EXCLUDED.type, status = EXCLUDED.status, from_content = EXCLUDED.from_content,
       source_unit_id = EXCLUDED.source_unit_id, content_locator = EXCLUDED.content_locator,
       provenance_id = EXCLUDED.provenance_id`,
    [
      l.id,
      l.source_object_id,
      l.target_object_id ?? null,
      l.target_unit_id ?? null,
      l.unresolved_text ?? null,
      l.target_selector == null ? null : JSON.stringify(l.target_selector),
      l.type,
      l.status,
      l.from_content,
      l.source_unit_id ?? null,
      l.content_locator == null ? null : JSON.stringify(l.content_locator),
      l.provenance_id,
      l.created_at,
    ],
  );
}

async function upsertTagging(client: pg.PoolClient, t: Tagging): Promise<void> {
  await client.query(
    `INSERT INTO taggings (id, tag_id, tagged_object_id, tagged_unit_id, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       tagged_object_id = EXCLUDED.tagged_object_id, tagged_unit_id = EXCLUDED.tagged_unit_id`,
    [t.id, t.tag_id, t.tagged_object_id ?? null, t.tagged_unit_id ?? null, t.created_at],
  );
}

async function insertObjectVersion(client: pg.PoolClient, v: ObjectVersion): Promise<void> {
  await client.query(
    `INSERT INTO object_versions (id, object_id, version_no, snapshot, provenance_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [v.id, v.object_id, v.version_no, JSON.stringify(v.snapshot), v.provenance_id, v.created_at],
  );
}

// ── Subgraph row mappers (export) ──────────────────────────────────────────────

interface ObjectRow {
  id: string;
  type: string;
  title: string | null;
  raw_source: string | null;
  status: string;
  schema_version: number;
  revision: number;
  provenance_id: string;
  space_id: string;
  created_at: Date;
  updated_at: Date;
}

function rowToObject(row: ObjectRow): CanonicalObject {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    schema_version: row.schema_version,
    revision: row.revision,
    provenance_id: row.provenance_id,
    space_id: row.space_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    ...omitNull('title', row.title),
    ...omitNull('raw_source', row.raw_source),
  } as CanonicalObject;
}

interface ProvenanceRow {
  id: string;
  origin: string;
  created_by: string | null;
  occurred_at: Date;
}

function rowToProvenance(row: ProvenanceRow): Provenance {
  return {
    id: row.id,
    origin: row.origin,
    occurred_at: row.occurred_at.toISOString(),
    ...omitNull('created_by', row.created_by),
  } as Provenance;
}

interface AliasRow {
  id: string;
  object_id: string;
  name: string;
  kind: string;
  scope: string;
  scope_ref: string | null;
}

function rowToAlias(row: AliasRow): Alias {
  return {
    id: row.id,
    object_id: row.object_id,
    name: row.name,
    kind: row.kind,
    scope: row.scope,
    ...omitNull('scope_ref', row.scope_ref),
  } as Alias;
}

interface HandleRow {
  id: string;
  space_id: string;
  name: string;
  target_object_id: string;
  target_unit_id: string | null;
  target_expression_id: string | null;
  status: string;
  scope: string;
  provenance_id: string;
}

function rowToHandle(row: HandleRow): Handle {
  return {
    id: row.id,
    space_id: row.space_id,
    name: row.name,
    target_object_id: row.target_object_id,
    status: row.status,
    scope: row.scope,
    provenance_id: row.provenance_id,
    ...omitNull('target_unit_id', row.target_unit_id),
    ...omitNull('target_expression_id', row.target_expression_id),
  } as Handle;
}

interface TagRow {
  id: string;
  space_id: string;
  name: string;
}

function rowToTag(row: TagRow): Tag {
  return { id: row.id, space_id: row.space_id, name: row.name };
}

interface ObjectVersionRow {
  id: string;
  object_id: string;
  version_no: number;
  snapshot: unknown;
  provenance_id: string;
  created_at: Date;
}

function rowToObjectVersion(row: ObjectVersionRow): ObjectVersion {
  return {
    id: row.id,
    object_id: row.object_id,
    version_no: row.version_no,
    snapshot: row.snapshot,
    provenance_id: row.provenance_id,
    created_at: row.created_at.toISOString(),
  };
}
