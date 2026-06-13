// Note detail: verbatim raw_source, object metadata, inline rename under optimistic
// concurrency — a 409 surfaces as "changed elsewhere, reload" (the §6.4 client
// pattern, established once and reused forever).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ApiError, getObject, patchObject } from '../api/client';

export function NoteDetailPage() {
  const { objectId } = useParams({ from: '/objects/$objectId' });
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['objects', objectId], queryFn: () => getObject(objectId) });
  const [editing, setEditing] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const rename = useMutation({
    mutationFn: (title: string) =>
      patchObject(objectId, {
        expected_revision: query.data?.revision ?? 0,
        title: title === '' ? null : title, // empty input clears the title (tri-state)
      }),
    onSuccess: async () => {
      setEditing(null);
      setConflict(false);
      await queryClient.invalidateQueries({ queryKey: ['objects'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
        setConflict(true);
      }
    },
  });

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;
  const object = query.data;

  return (
    <main>
      {editing === null ? (
        <h1 onDoubleClick={() => setEditing(object.title ?? '')} title="Double-click to rename">
          {object.title?.trim() ? object.title : <em>(untitled)</em>}{' '}
          <button onClick={() => setEditing(object.title ?? '')}>Rename</button>
        </h1>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate(editing);
          }}
        >
          <input
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            aria-label="new title"
            autoFocus
            size={48}
          />
          <button disabled={rename.isPending}>Save</button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      )}

      {conflict && (
        <p className="error">
          This note changed elsewhere — the rename was not applied.{' '}
          <button
            onClick={() => {
              setConflict(false);
              void query.refetch();
            }}
          >
            Reload
          </button>
        </p>
      )}
      {rename.isError && !conflict && <p className="error">{(rename.error as Error).message}</p>}

      {object.raw_source !== undefined && object.raw_source !== null && (
        <pre aria-label="raw source">{object.raw_source}</pre>
      )}

      <p className="meta">
        {object.type} · {object.status} · rev {object.revision} · schema v{object.schema_version}
        <br />
        created {new Date(object.created_at).toLocaleString()} · updated{' '}
        {new Date(object.updated_at).toLocaleString()}
      </p>
    </main>
  );
}
