// The journal (arch doc §6.5), skeleton edition: the date-ordered list of `journal_day` surfaces +
// a "Today" get-or-create. Day content arrives via the 2c editor; for now days are opened and read.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { createJournalDay, listJournalDays } from '../api/client';

/** The user's LOCAL calendar day (not toISOString, which is UTC and would shift the day boundary). */
function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function JournalPage() {
  const query = useQuery({ queryKey: ['journal'], queryFn: listJournalDays });
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const today = useMutation({
    mutationFn: () => createJournalDay(todayLocalISO()),
    onSuccess: async (day) => {
      await queryClient.invalidateQueries({ queryKey: ['journal'] });
      await navigate({ to: '/journal/$date', params: { date: day.date } });
    },
  });

  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p className="error">{(query.error as Error).message}</p>;

  return (
    <main>
      <h1>Journal</h1>
      <p>
        <button disabled={today.isPending} onClick={() => today.mutate()}>
          {today.isPending ? 'Opening…' : 'Today'}
        </button>
      </p>
      {today.isError && <p className="error">{(today.error as Error).message}</p>}
      {query.data.length === 0 ? (
        <p>
          No days yet — open <strong>Today</strong> to start.
        </p>
      ) : (
        <ul className="journal-days">
          {query.data.map((d) => (
            <li key={d.object.id}>
              <Link to="/journal/$date" params={{ date: d.date }}>
                {d.date}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
