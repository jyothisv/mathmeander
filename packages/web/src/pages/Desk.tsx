// The calm desk (arch doc §5.11), skeleton edition: recent notes. Inbox, review queue,
// trails, return-later arrive with their slices.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { listObjects } from '../api/client';

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
              <Link to="/objects/$objectId" params={{ objectId: object.id }}>
                {object.title?.trim() ? object.title : <em>(untitled)</em>}
              </Link>{' '}
              <span className="meta">
                {object.status} · rev {object.revision}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
