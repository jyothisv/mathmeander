// Notebooks (arch doc §6.5) — the §B section surface, sibling to the journal. The list of `notebook`
// surfaces + a create-by-title (the server normalizes the title to a per-space slug, idempotent
// get-or-create). A notebook is opened and authored via the same 2c/3c editor as a journal day.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { createNotebook, listNotebooks } from '../api/client';

export function NotebooksPage() {
  const query = useQuery({ queryKey: ['notebooks'], queryFn: listNotebooks });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');

  const create = useMutation({
    mutationFn: () => createNotebook(title.trim()),
    onSuccess: async (nb) => {
      setTitle('');
      await queryClient.invalidateQueries({ queryKey: ['notebooks'] });
      await navigate({ to: '/notebooks/$slug', params: { slug: nb.slug } });
    },
  });

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;

  return (
    <main>
      <h1>Notebooks</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <input
          aria-label="notebook title"
          placeholder="New notebook title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" disabled={create.isPending || title.trim() === ''}>
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </form>
      {create.isError && <p className="error">{(create.error as Error).message}</p>}
      {query.data.length === 0 ? (
        <p>No notebooks yet — create one above.</p>
      ) : (
        <ul className="notebooks">
          {query.data.map((nb) => (
            <li key={nb.object.id}>
              <Link to="/notebooks/$slug" params={{ slug: nb.slug }}>
                {nb.slug}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
