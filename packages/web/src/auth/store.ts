// Session state (Zustand is for UI/session state only; server data lives in TanStack
// Query). The interface — token / signIn / signOut — is the stable seam: when a hosted
// IdP replaces the dev login page, this store does not change.
import { create } from 'zustand';
import { clearAllDrafts } from '../editor/draftStore';

const STORAGE_KEY = 'mathmeander.session.token';

// Node/SSR-safe accessors — the module must not crash on import where `localStorage` is absent
// (e.g. vitest), so that pure tests can transitively import this store via the api client.
const ls = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);

interface AuthState {
  token: string | null;
  signIn(token: string): void;
  signOut(): void;
}

export const useAuth = create<AuthState>((set) => ({
  token: ls()?.getItem(STORAGE_KEY) ?? null,
  signIn: (token) => {
    ls()?.setItem(STORAGE_KEY, token);
    set({ token });
  },
  signOut: () => {
    ls()?.removeItem(STORAGE_KEY);
    set({ token: null });
    void clearAllDrafts(); // shared-browser privacy: drop all local journal drafts on logout / 401
  },
}));

export function currentToken(): string | null {
  return useAuth.getState().token;
}

export function clearSession(): void {
  useAuth.getState().signOut();
}
