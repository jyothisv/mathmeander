// Dev sign-in. When a hosted IdP arrives, THIS PAGE is what gets swapped — the auth
// store interface and everything behind it stay put (setup decision 3).
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { devLogin } from '../api/client';
import { useAuth } from '../auth/store';

export function LoginPage() {
  const [email, setEmail] = useState('dev@mathmeander.local');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = useAuth((s) => s.signIn);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await devLogin(email.trim());
      signIn(session.token);
      await navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign in</h1>
      <p className="meta">Development sign-in via the local dev issuer.</p>
      <form onSubmit={submit}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="email"
          required
        />
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
