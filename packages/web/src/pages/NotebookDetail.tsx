// One notebook (arch doc §6.5) — the §B section surface. Loads the object + its transitive subgraph eagerly
// (so embeds resolve inline, like the journal day), then mounts the SAME editor (flat prose + display math +
// §B headings/outline) when the content is editable, else the read-only MathContentView. Identity is the
// per-space `slug`; the editor surface seeds the `['notebook', slug]` cache + refetches on a 409 conflict.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { MathContent } from '@mathmeander/schema';
import { getNotebook } from '../api/client';
import { DayEditor, type EditorSurface } from '../editor/DayEditor';
import { isEditable } from '../editor/projection';
import { MathContentView } from './JournalDay';

export function NotebookDetailPage() {
  const { slug } = useParams({ from: '/notebooks/$slug' });
  const query = useQuery({ queryKey: ['notebook', slug], queryFn: () => getNotebook(slug) });
  const surface = useMemo<EditorSurface>(
    () => ({ key: slug, cacheKey: ['notebook', slug], fetchEager: () => getNotebook(slug) }),
    [slug],
  );

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;

  const { object, graph } = query.data;
  const contentById = new Map<string, MathContent>(graph.content.map((c) => [c.object_id, c]));
  const notebookContent = contentById.get(object.id);

  return (
    <main>
      <p>
        <Link to="/notebooks">← Notebooks</Link>
      </p>
      <h1>{slug}</h1>
      {notebookContent && isEditable(notebookContent) ? (
        // The §B section home: the same editor as the journal, keyed by object id for a clean remount.
        <DayEditor
          key={object.id}
          objectId={object.id}
          content={notebookContent}
          surface={surface}
        />
      ) : notebookContent ? (
        <MathContentView content={notebookContent} contentById={contentById} />
      ) : (
        <p>
          <em>Empty notebook.</em>
        </p>
      )}
    </main>
  );
}
