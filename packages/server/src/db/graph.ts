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
  JournalDayDetail,
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

/** A light object-row read (no subgraph) — e.g. re-home needs the host's `space_id` to stamp T. */
export async function loadObject(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<CanonicalObject | null> {
  const res = await db.query<ObjectRow>(
    `SELECT id, type, title, raw_source, status, schema_version, revision, provenance_id, space_id,
            created_at, updated_at
     FROM objects WHERE id = $1 AND space_id = $2`,
    [objectId, spaceId],
  );
  const row = res.rows[0];
  return row ? rowToObject(row) : null;
}

/** The object_ids an `Embed{target: Object}` in this graph's content points at. */
function embedTargetIds(graph: MathpackGraph): string[] {
  const ids: string[] = [];
  for (const content of graph.content) {
    for (const unit of content.units) {
      const c = unit.content;
      if (c.kind === 'embed' && c.target.kind === 'object') ids.push(c.target.object_id);
    }
  }
  return ids;
}

/**
 * The `.mathpack` subgraph for an object, following `Embed{target: Object}` units TRANSITIVELY so a
 * host's pack includes every embedded object (re-home leaves embeds, §9.y) — the core's
 * `embed_target_missing` import gate is then satisfiable. A visited set guards malformed embed
 * cycles; the per-object pieces are merged and the trust-spine (provenance/derivations) + tags are
 * deduped by id. Written generally so deeper nesting (Pass C) needs no rewrite.
 */
export async function loadObjectSubgraph(
  db: Queryable,
  spaceId: string,
  objectId: string,
): Promise<MathpackGraph | null> {
  const root = await loadOneSubgraph(db, spaceId, objectId);
  if (!root) return null;

  const merged = root;
  const seen = new Set<string>([objectId]);
  const queue = embedTargetIds(root).filter((id) => !seen.has(id));
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const sub = await loadOneSubgraph(db, spaceId, next);
    if (!sub) continue; // a missing target is the core's import gate to flag, not a load error
    mergeSubgraph(merged, sub);
    for (const id of embedTargetIds(sub)) if (!seen.has(id)) queue.push(id);
  }
  return merged;
}

/** Merge `sub` into `into`, deduping by id where two objects can cite the same row (the trust spine). */
function mergeSubgraph(into: MathpackGraph, sub: MathpackGraph): void {
  into.objects.push(...sub.objects);
  into.content.push(...sub.content);
  into.links.push(...sub.links);
  into.aliases.push(...sub.aliases);
  into.handles.push(...sub.handles);
  into.object_versions.push(...sub.object_versions);
  into.definition_details.push(...sub.definition_details);
  into.journal_day_details.push(...sub.journal_day_details);
  const tagIds = new Set(into.tags.map((t) => t.id));
  for (const t of sub.tags) if (!tagIds.has(t.id)) into.tags.push(t);
  const taggingIds = new Set(into.taggings.map((t) => t.id));
  for (const t of sub.taggings) if (!taggingIds.has(t.id)) into.taggings.push(t);
  const provIds = new Set(into.provenance.map((p) => p.id));
  for (const p of sub.provenance) if (!provIds.has(p.id)) into.provenance.push(p);
  const derivKeys = new Set(
    into.provenance_derivations.map((d) => `${d.provenance_id}|${d.derived_from_provenance_id}`),
  );
  for (const d of sub.provenance_derivations) {
    const k = `${d.provenance_id}|${d.derived_from_provenance_id}`;
    if (!derivKeys.has(k)) into.provenance_derivations.push(d);
  }
}

/** One object's subgraph (no embed-following) — the building block of the transitive loader. */
async function loadOneSubgraph(
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
  // §6.5: a journal_day's date travels with its subgraph (symmetry with definition_detail; the
  // core's import gate type-checks it, arch §827). `date` is stored as a Postgres `date` → ISO string.
  const journalDayDetails = (
    await db.query<{ object_id: string; date: string }>(
      `SELECT object_id, to_char(date, 'YYYY-MM-DD') AS date FROM journal_day_detail WHERE object_id = $1`,
      [objectId],
    )
  ).rows.map((r) => ({ object_id: r.object_id, date: r.date }) satisfies JournalDayDetail);

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
    journal_day_details: journalDayDetails,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Thrown to roll back a lost optimistic-concurrency race; caught → `{ won: false }` (→ 409). */
class RevisionConflict extends Error {}

/**
 * Thrown when dissolve's IN-TRANSACTION re-check finds an external inbound reference that appeared
 * after the route's pre-read (the §9.y TOCTOU). Caught → `{ won: false, blockedReferences }` → 422.
 */
class DissolutionRaced extends Error {
  constructor(readonly references: string[]) {
    super('dissolution blocked by a concurrently-added reference');
  }
}

type PersistOpts = {
  provenance: Provenance;
  expectedRevision: number;
  /** The DESTROYED object's gate — required for dissolve (the second of its two CAS gates). */
  expectedDissolvedRevision?: number | undefined;
  now: Date;
};

/**
 * Persist an op's `OpOutcome` in ONE transaction, FK-safe, dispatching on outcome SHAPE:
 *   • `host_content` present        → re-home (two-object move; §9.y greedy capture)
 *   • `objects_removed` non-empty   → dissolve (fold back + destroy)
 *   • `new_objects` non-empty       → materialize-copy (fresh object, no gate)
 *   • else                          → single-object gated write
 * The two cross-object shapes `SET CONSTRAINTS ALL DEFERRED` so a unit can change `object_id` while
 * its composite-FK edges + (id-keyed) taggings stay valid AT COMMIT (0003 made those FKs deferrable).
 * GENERATED columns (`content_kind`/`in_expression`) are never written.
 */
export async function persistObjectGraph(
  db: pg.Pool,
  objectId: string,
  outcome: OpOutcome,
  opts: PersistOpts,
): Promise<{ won: boolean; blockedReferences?: string[] }> {
  try {
    await withTransaction(db, async (client) => {
      await upsertProvenance(client, opts.provenance);

      if (outcome.host_content != null) {
        await persistRehome(client, objectId, outcome, opts);
        return;
      }
      if (outcome.objects_removed.length > 0) {
        await persistDissolve(client, objectId, outcome, opts);
        return;
      }

      // ── materialize-copy (fresh object, no gate) | single-object gated write ──
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
    if (err instanceof DissolutionRaced) return { won: false, blockedReferences: err.references };
    if (err instanceof RevisionConflict) return { won: false };
    throw err;
  }
  return { won: true };
}

/** Every `ExpressionId` inside one unit's content (a math unit's expr, or prose inline math). */
function expressionIdsOfUnit(unit: Unit): string[] {
  const c = unit.content;
  if (c.kind === 'math') return [c.expr.id];
  if (c.kind === 'prose') return c.inline.flatMap((el) => (el.kind === 'math' ? [el.expr.id] : []));
  return [];
}

/**
 * Re-home (two-object move). Gate the HOST on `host_content.revision` (NOT `content.revision`, which
 * is the new object's = 1); insert the new object; delete-all+reinsert the host layer (incl. the
 * embed, minus the moved rows) and the new object's layer (the moved units, ids preserved); re-point
 * the composite-FK edges (links source+target, handles unit- AND expression-anchored) that followed
 * the moved units. Constraints are deferred, so the move is consistent only at COMMIT. Unit-level
 * taggings need no re-point — their FK is on the (preserved) id alone.
 */
async function persistRehome(
  client: pg.PoolClient,
  hostId: string,
  outcome: OpOutcome,
  opts: PersistOpts,
): Promise<void> {
  const newObject = outcome.new_objects[0];
  const hostContent = outcome.host_content;
  const hostSnapshot = outcome.host_version_snapshot;
  if (!newObject || !hostContent || !hostSnapshot) {
    throw new Error('rehome outcome missing new object / host content / host snapshot');
  }
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  const gated = await client.query(
    `UPDATE objects SET revision = $1, updated_at = $2 WHERE id = $3 AND revision = $4`,
    [hostContent.revision, opts.now.toISOString(), hostId, opts.expectedRevision],
  );
  if (gated.rowCount !== 1) throw new RevisionConflict();

  await insertObjectRow(client, newObject);
  await replaceContentUnits(client, hostId, hostContent.units);
  await replaceContentUnits(client, newObject.id, outcome.content.units);

  const movedIds = outcome.content.units.map((u) => u.id);
  if (movedIds.length > 0) {
    const movedExprIds = outcome.content.units.flatMap(expressionIdsOfUnit);
    await client.query(
      `UPDATE links SET source_object_id = $1 WHERE source_unit_id = ANY($2) AND source_object_id = $3`,
      [newObject.id, movedIds, hostId],
    );
    await client.query(
      `UPDATE links SET target_object_id = $1 WHERE target_unit_id = ANY($2) AND target_object_id = $3`,
      [newObject.id, movedIds, hostId],
    );
    await client.query(
      `UPDATE handles SET target_object_id = $1
         WHERE (target_unit_id = ANY($2) OR target_expression_id = ANY($3::uuid[])) AND target_object_id = $4`,
      [newObject.id, movedIds, movedExprIds, hostId],
    );
  }

  await insertObjectVersion(client, hostSnapshot);
  await insertObjectVersion(client, outcome.version_snapshot);
}

/**
 * Dissolve (fold back + destroy). DUAL gate (host on `content.revision`, dissolved on
 * `expectedDissolvedRevision`) before any destructive write — either lost race rolls the whole tx
 * back (no partial destruction). Then RE-CHECK the reviewable-refusal gate IN-TRANSACTION (the
 * route's pre-read is a TOCTOU window): an external inbound link added concurrently → `DissolutionRaced`
 * (→ 422), never a silent re-point. Free the dissolved object's content rows, fold the units back under
 * the host (delete-all+reinsert, dropping the embed), re-point only the object's OWN (self) edges to
 * the host — an external inbound that slips in after the re-check is left pointing at the doomed
 * object so the final `DELETE` hits its immediate FK and rolls back (never silent corruption).
 * Checkpoint the host, then destroy the dissolved object in child-FK order (incl. its object-level
 * taggings — not dependency-blockers).
 */
async function persistDissolve(
  client: pg.PoolClient,
  hostId: string,
  outcome: OpOutcome,
  opts: PersistOpts,
): Promise<void> {
  const dissolvedId = outcome.objects_removed[0];
  if (!dissolvedId || opts.expectedDissolvedRevision == null) {
    throw new Error('dissolve outcome/opts missing dissolved id or its expected revision');
  }
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  // Lock the dissolved object's row (serializes two concurrent dissolves of it).
  await client.query(`SELECT id FROM objects WHERE id = $1 FOR UPDATE`, [dissolvedId]);
  const hostGate = await client.query(
    `UPDATE objects SET revision = $1, updated_at = $2 WHERE id = $3 AND revision = $4`,
    [outcome.content.revision, opts.now.toISOString(), hostId, opts.expectedRevision],
  );
  if (hostGate.rowCount !== 1) throw new RevisionConflict();
  const dissolvedGate = await client.query(
    `UPDATE objects SET updated_at = $1 WHERE id = $2 AND revision = $3`,
    [opts.now.toISOString(), dissolvedId, opts.expectedDissolvedRevision],
  );
  if (dissolvedGate.rowCount !== 1) throw new RevisionConflict();

  // The authoritative §9.y gate: re-read external inbound references INSIDE the tx (closes the
  // route-pre-read TOCTOU). A reference committed between the pre-read and now → refuse, don't move.
  const inbound = await client.query<{ id: string }>(
    `SELECT id FROM links WHERE target_object_id = $1 AND source_object_id <> $1 FOR UPDATE`,
    [dissolvedId],
  );
  if (inbound.rowCount && inbound.rowCount > 0) {
    throw new DissolutionRaced(inbound.rows.map((r) => r.id));
  }

  await client.query(`DELETE FROM content_units WHERE object_id = $1`, [dissolvedId]);
  await replaceContentUnits(client, hostId, outcome.content.units);

  // Re-point only the dissolved object's OWN edges. Source first → its self-edges now read source =
  // host; the target re-point then matches ONLY those (source = host), so a concurrently-inserted
  // external inbound (source = someone else) is deliberately left untouched (→ FK-fail at destroy).
  await client.query(`UPDATE links SET source_object_id = $1 WHERE source_object_id = $2`, [
    hostId,
    dissolvedId,
  ]);
  await client.query(
    `UPDATE links SET target_object_id = $1 WHERE target_object_id = $2 AND source_object_id = $1`,
    [hostId, dissolvedId],
  );
  await client.query(`UPDATE handles SET target_object_id = $1 WHERE target_object_id = $2`, [
    hostId,
    dissolvedId,
  ]);

  await insertObjectVersion(client, outcome.version_snapshot);

  await client.query(`DELETE FROM object_versions WHERE object_id = $1`, [dissolvedId]);
  await client.query(`DELETE FROM aliases WHERE object_id = $1`, [dissolvedId]);
  await client.query(`DELETE FROM definition_detail WHERE object_id = $1`, [dissolvedId]);
  await client.query(`DELETE FROM taggings WHERE tagged_object_id = $1`, [dissolvedId]);
  await client.query(`DELETE FROM objects WHERE id = $1`, [dissolvedId]);
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
