// Session state (Zustand is for UI/session state only; server data lives in TanStack
// Query). The interface — token / signIn / signOut — is the stable seam: when a hosted
// IdP replaces the dev login page, this store does not change.
import { create } from 'zustand';

const STORAGE_KEY = 'mathmeander.session.token';

interface AuthState {
  token: string | null;
  signIn(token: string): void;
  signOut(): void;
}

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem(STORAGE_KEY),
  signIn: (token) => {
    localStorage.setItem(STORAGE_KEY, token);
    set({ token });
  },
  signOut: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ token: null });
  },
}));

export function currentToken(): string | null {
  return useAuth.getState().token;
}

export function clearSession(): void {
  useAuth.getState().signOut();
}
