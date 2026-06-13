// Rough capture (arch doc §5.1, skeleton form): a plain textarea writing raw_source —
// preserved VERBATIM, never rendered or normalized here. Slice 2 swaps this component
// for the ProseMirror editor behind the SAME mutation; the route and data layer stay.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { v7 as uuidv7 } from 'uuid';
import { createNote } from '../api/client';

export function NewNotePage() {
  const [title, setTitle] = useState('');
  const [rawSource, setRawSource] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      createNote({
        id: uuidv7(), // client-minted UUIDv7 — the §6.3 reservation, exercised
        ...(title === '' ? {} : { title }),
        ...(rawSource === '' ? {} : { raw_source: rawSource }),
      }),
    onSuccess: async (object) => {
      await queryClient.invalidateQueries({ queryKey: ['objects'] });
      await navigate({ to: '/objects/$objectId', params: { objectId: object.id } });
    },
  });

  return (
    <main>
      <h1>New note</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <p>
          <input
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="title"
            size={48}
          />
        </p>
        <textarea
          placeholder={'Rough math, preserved exactly as typed…\n$\\forall \\epsilon > 0$'}
          value={rawSource}
          onChange={(e) => setRawSource(e.target.value)}
          aria-label="rough text"
        />
        <p>
          <button disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save note'}
          </button>
        </p>
      </form>
      {mutation.isError && <p className="error">{(mutation.error as Error).message}</p>}
    </main>
  );
}
