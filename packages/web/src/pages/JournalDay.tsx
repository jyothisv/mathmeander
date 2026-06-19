// One journal day, READ-ONLY (slice 2b). Renders the day's content units and resolves each
// Embed{Object} inline from the eagerly-loaded subgraph — the §9.y boundary-invisible contract,
// observable. The leaf rendering is deliberately minimal (prose text, math surface_text in <code>);
// 2c's ProseMirror replaces it. `MathContentView` stays a pure fn of (content, subgraph) so the
// embed resolution survives that swap.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { MathContent, Unit } from '@mathmeander/schema';
import { getJournalDay } from '../api/client';
import { DayEditor } from '../editor/DayEditor';
import { isFlatProse } from '../editor/projection';

type ContentById = Map<string, MathContent>;

/** Group an object's units by parent (`null` = top level), each level in `position` order. */
function byParent(units: Unit[]): Map<string | null, Unit[]> {
  const m = new Map<string | null, Unit[]>();
  for (const u of units) {
    const key = u.parent_unit_id ?? null;
    const list = m.get(key);
    if (list) list.push(u);
    else m.set(key, [u]);
  }
  for (const list of m.values()) list.sort((a, b) => a.position - b.position);
  return m;
}

function renderLevel(
  parentId: string | null,
  parentMap: Map<string | null, Unit[]>,
  contentById: ContentById,
  seen: Set<string>,
): ReactNode[] {
  return (parentMap.get(parentId) ?? []).map((unit) => (
    <UnitView
      key={unit.id}
      unit={unit}
      parentMap={parentMap}
      contentById={contentById}
      seen={seen}
    />
  ));
}

function UnitView({
  unit,
  parentMap,
  contentById,
  seen,
}: {
  unit: Unit;
  parentMap: Map<string | null, Unit[]>;
  contentById: ContentById;
  seen: Set<string>;
}): ReactNode {
  const c = unit.content;
  switch (c.kind) {
    case 'prose':
      return (
        <p>
          {c.text}
          {c.inline.flatMap((i, n) =>
            i.kind === 'math'
              ? [<code key={n} className="math">{` ${i.expr.surface_text} `}</code>]
              : [],
          )}
        </p>
      );
    case 'math':
      return (
        <pre className="math-display">
          <code>{c.expr.surface_text}</code>
        </pre>
      );
    case 'group':
      return (
        <section className="group">
          {unit.type ? <h2>{unit.type}</h2> : null}
          {renderLevel(unit.id, parentMap, contentById, seen)}
        </section>
      );
    case 'embed': {
      if (c.target.kind !== 'object') return <em>(unsupported embed)</em>;
      const id = c.target.object_id;
      if (seen.has(id)) return <em>(embed cycle)</em>;
      const target = contentById.get(id);
      if (!target) return <em>(embedded object not loaded)</em>;
      const childSeen = new Set(seen);
      childSeen.add(id);
      // The embedded object's units render INLINE here — that is the observable §9.y contract.
      return (
        <div className="embed" data-embed-object={id}>
          {renderLevel(null, byParent(target.units), contentById, childSeen)}
        </div>
      );
    }
    default:
      return null;
  }
}

function MathContentView({
  content,
  contentById,
}: {
  content: MathContent;
  contentById: ContentById;
}): ReactNode {
  return (
    <>{renderLevel(null, byParent(content.units), contentById, new Set([content.object_id]))}</>
  );
}

export function JournalDayPage() {
  const { date } = useParams({ from: '/journal/$date' });
  const query = useQuery({ queryKey: ['journal', date], queryFn: () => getJournalDay(date) });

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;

  const { object, graph } = query.data;
  const contentById: ContentById = new Map(graph.content.map((c) => [c.object_id, c]));
  const dayContent = contentById.get(object.id);

  return (
    <main>
      <p>
        <Link to="/journal">← Journal</Link>
      </p>
      <h1>{date}</h1>
      {dayContent && isFlatProse(dayContent) ? (
        // Flat-prose (or empty) days are EDITABLE (slice 2c-1). Keyed by object id so a new day
        // remounts the editor cleanly.
        <DayEditor key={object.id} objectId={object.id} content={dayContent} />
      ) : dayContent ? (
        // Days with display math / embeds / groups render read-only until later passes.
        <MathContentView content={dayContent} contentById={contentById} />
      ) : (
        <p>
          <em>Empty day.</em>
        </p>
      )}
    </main>
  );
}
