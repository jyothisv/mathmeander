// The calm desk (arch doc §5.11), skeleton edition: recent notes + surfaces. Inbox, review queue,
// trails, return-later arrive with their slices. Each entry links to ITS OWN surface — a notebook to its
// notebook page (by slug), a journal day to its day (by date), everything else to the note view (the
// shipped bug linked every type to the note route, so "Artificial Life" opened a dead note view).
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { listObjects, type ListedObject } from '../api/client';

function entryLink(object: ListedObject, label: ReactNode): ReactNode {
  if (object.type === 'notebook' && object.slug) {
    return (
      <Link to="/notebooks/$slug" params={{ slug: object.slug }}>
        {label}
      </Link>
    );
  }
  if (object.type === 'journal_day' && object.date) {
    return (
      <Link to="/journal/$date" params={{ date: object.date }}>
        {label}
      </Link>
    );
  }
  return (
    <Link to="/objects/$objectId" params={{ objectId: object.id }}>
      {label}
    </Link>
  );
}

/** The display label: the title, else the surface identity (a journal day reads as its date, a notebook
 *  as its slug) — "(untitled)" only when there is genuinely nothing to show. */
function entryLabel(object: ListedObject): ReactNode {
  if (object.title?.trim()) return object.title;
  if (object.type === 'journal_day' && object.date) return object.date;
  if (object.type === 'notebook' && object.slug) return object.slug;
  return <em>(untitled)</em>;
}

export function DeskPage() {
  const query = useQuery({ queryKey: ['objects'], queryFn: listObjects });

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;

  return (
    <main>
      <h1>Desk</h1>
      {query.data.length === 0 ? (
        <p>
          Nothing here yet — <Link to="/objects/new">capture a first rough note</Link>.
        </p>
      ) : (
        <ul className="notes">
          {query.data.map((object) => (
            <li key={object.id}>
              {entryLink(object, entryLabel(object))}{' '}
              <span className="meta">
                {object.type} · {object.status} · rev {object.revision}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
