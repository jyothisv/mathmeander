// One journal day, READ-ONLY (slice 2b). Renders the day's content units and resolves each
// Embed{Object} inline from the eagerly-loaded subgraph — the §9.y boundary-invisible contract,
// observable. The leaf rendering is deliberately minimal (prose text, math surface_text in <code>);
// 2c's ProseMirror replaces it. `MathContentView` stays a pure fn of (content, subgraph) so the
// embed resolution survives that swap.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { Inline, MathContent, MathExpression, RowRelation, Unit } from '@mathmeander/schema';
import { getJournalDay } from '../api/client';
import { DayEditor, type EditorSurface } from '../editor/DayEditor';
import { isEditable } from '../editor/projection';
import { renderMathInto } from '../editor/renderMath';
import { notationDefsFromSource } from '../editor/notationScope';
import type { NotationDef } from '../editor/mathRuntime';

/** Glyph for a per-row connective (a derivation step's relation / an equation row's leading relation). */
const ROW_RELATION_SYMBOL: Record<RowRelation, string> = {
  eq: '=',
  lt: '<',
  gt: '>',
  le: '≤',
  ge: '≥',
  ne: '≠',
  defines: '≔',
  maps_to: '↦',
  implies: '⟹',
  in: '∈',
  not_in: '∉',
  subset: '⊂',
  subseteq: '⊆',
};

/** The notebook-wide notation registry for this read-only view (the `config` notation-home block's defs),
 *  applied at render so math resolves consistently with the editor (notation-as-register). */
const NotationScopeContext = createContext<NotationDef[]>([]);

/** Notation defs from a MathContent's `config` (family `notation`) units, in document order (= definition
 *  order). ONE notebook-wide layer — the per-region cascade is deferred, matching the editor. */
function notationScopeFromContent(content: MathContent): NotationDef[] {
  const defs: NotationDef[] = [];
  for (const u of content.units) {
    const c = u.content;
    if (c.kind === 'config' && c.family === 'notation')
      defs.push(...notationDefsFromSource(c.source));
  }
  return defs;
}

/** A KaTeX-rendered math expression (display block or inline), via the shared `renderMathInto`. */
function MathView({ expr, display }: { expr: MathExpression; display: boolean }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const scope = useContext(NotationScopeContext);
  useEffect(() => {
    if (ref.current) renderMathInto(expr, ref.current, { display, scope });
  }, [expr, display, scope]);
  return <span ref={ref} className={display ? 'math-render-display' : 'math-render'} />;
}

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
  depth = 0,
): ReactNode[] {
  return (parentMap.get(parentId) ?? []).map((unit) => (
    <UnitView
      key={unit.id}
      unit={unit}
      parentMap={parentMap}
      contentById={contentById}
      seen={seen}
      depth={depth}
    />
  ));
}

/** Render an inline-bearing run (prose text + inline `Math` as code) — shared by prose + heading titles. */
function inlineRun(text: string, inline: Inline[]): ReactNode[] {
  return [
    text,
    ...inline.flatMap((i, n) =>
      i.kind === 'math' ? [<code key={n} className="math">{` ${i.expr.surface_text} `}</code>] : [],
    ),
  ];
}

function UnitView({
  unit,
  parentMap,
  contentById,
  seen,
  depth,
}: {
  unit: Unit;
  parentMap: Map<string | null, Unit[]>;
  contentById: ContentById;
  seen: Set<string>;
  depth: number;
}): ReactNode {
  const c = unit.content;
  switch (c.kind) {
    case 'prose':
      return <p>{inlineRun(c.text, c.inline)}</p>;
    case 'heading': {
      // §B section: the title (its own inline-bearing content) at a depth-derived level, then its body +
      // subsections recurse one level deeper. Read-only mirror of the editor's flat projection.
      const title = inlineRun(c.text, c.inline);
      const level = Math.min(depth + 1, 6);
      return (
        <section className="mm-section" data-section={unit.id}>
          {level === 1 ? (
            <h1>{title}</h1>
          ) : level === 2 ? (
            <h2>{title}</h2>
          ) : level === 3 ? (
            <h3>{title}</h3>
          ) : level === 4 ? (
            <h4>{title}</h4>
          ) : level === 5 ? (
            <h5>{title}</h5>
          ) : (
            <h6>{title}</h6>
          )}
          {renderLevel(unit.id, parentMap, contentById, seen, depth + 1)}
        </section>
      );
    }
    case 'math':
      return <MathView expr={c.expr} display />;
    case 'equations':
    case 'derivation':
      // Co-equal system / sequential chain: each child row is a Math/Prose line with an optional
      // leading relation in a gutter (2-A renders a stacked system; true column alignment at the
      // relation is the 2-B KaTeX-`aligned` upgrade, docs/structured-math.md §F3 follow-on).
      return (
        <div className={c.kind} data-container={unit.id}>
          {(parentMap.get(unit.id) ?? []).map((row) => (
            <div key={row.id} className="row">
              <span className="row-relation">
                {row.row_relation ? ROW_RELATION_SYMBOL[row.row_relation] : ''}
              </span>
              <div className="row-body">
                <UnitView
                  unit={row}
                  parentMap={parentMap}
                  contentById={contentById}
                  seen={seen}
                  depth={depth}
                />
              </div>
            </div>
          ))}
        </div>
      );
    case 'case_split':
      return (
        <section className="case-split">
          {(parentMap.get(unit.id) ?? []).map((child) => (
            <div
              key={child.id}
              className={child.slot === 'assumption' ? 'case-assumption' : 'case-body'}
            >
              {child.slot === 'assumption' ? <span className="case-label">assume </span> : null}
              <UnitView
                unit={child}
                parentMap={parentMap}
                contentById={contentById}
                seen={seen}
                depth={depth}
              />
            </div>
          ))}
        </section>
      );
    case 'group':
      return (
        <section className="group">
          {unit.type ? <h2>{unit.type}</h2> : null}
          {renderLevel(unit.id, parentMap, contentById, seen, depth)}
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
          {renderLevel(null, byParent(target.units), contentById, childSeen, depth)}
        </div>
      );
    }
    default:
      return null;
  }
}

export function MathContentView({
  content,
  contentById,
}: {
  content: MathContent;
  contentById: ContentById;
}): ReactNode {
  const scope = useMemo(() => notationScopeFromContent(content), [content]);
  return (
    <NotationScopeContext.Provider value={scope}>
      {renderLevel(null, byParent(content.units), contentById, new Set([content.object_id]))}
    </NotationScopeContext.Provider>
  );
}

export function JournalDayPage() {
  const { date } = useParams({ from: '/journal/$date' });
  const query = useQuery({ queryKey: ['journal', date], queryFn: () => getJournalDay(date) });
  const surface = useMemo<EditorSurface>(
    () => ({ key: date, cacheKey: ['journal', date], fetchEager: () => getJournalDay(date) }),
    [date],
  );

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;

  const { object, graph } = query.data;
  const contentById: ContentById = new Map(graph.content.map((c) => [c.object_id, c]));
  const dayContent = contentById.get(object.id);
  // §6.3b authored names → the title chrome on their typed blocks (unit-target handles only).
  const dayHandles = graph.handles.flatMap((h) =>
    h.target_unit_id ? [{ target_unit_id: h.target_unit_id, id: h.id, name: h.name }] : [],
  );

  return (
    <main>
      <p>
        <Link to="/journal">← Journal</Link>
      </p>
      <h1>{date}</h1>
      {dayContent && isEditable(dayContent) ? (
        // Flat prose + top-level display-math days are EDITABLE (slice 2c-1 + structured-math increment 1).
        // Keyed by object id so a new day remounts the editor cleanly.
        <DayEditor
          key={object.id}
          objectId={object.id}
          content={dayContent}
          handles={dayHandles}
          surface={surface}
        />
      ) : dayContent ? (
        // Days with nested structure / embeds / groups still render read-only until later increments.
        <MathContentView content={dayContent} contentById={contentById} />
      ) : (
        <p>
          <em>Empty day.</em>
        </p>
      )}
    </main>
  );
}
