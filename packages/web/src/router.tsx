// Route tree (code-based; moving to file-based routing later is mechanical). The
// desk (/) is the §5.11 calm-desk stub: recent notes, nothing noisy.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { logout } from './api/client';
import { useAuth } from './auth/store';
import { DeskPage } from './pages/Desk';
import { LoginPage } from './pages/Login';
import { NewNotePage } from './pages/NewNote';
import { NoteDetailPage } from './pages/NoteDetail';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <nav>
        <Link to="/">Desk</Link>
        <Link to="/objects/new">New note</Link>
        <LogoutLink />
      </nav>
      <Outlet />
    </>
  ),
});

function LogoutLink() {
  const { token, signOut } = useAuth();
  if (!token) return null;
  return (
    <a
      href="/login"
      onClick={() => {
        // Revoke server-side first (best effort), then clear local state.
        void logout().catch(() => undefined);
        signOut();
      }}
    >
      Sign out
    </a>
  );
}

function requireAuth() {
  if (!useAuth.getState().token) {
    throw redirect({ to: '/login' });
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const deskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: requireAuth,
  component: DeskPage,
});

const newNoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/objects/new',
  beforeLoad: requireAuth,
  component: NewNotePage,
});

export const noteDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/objects/$objectId',
  beforeLoad: requireAuth,
  component: NoteDetailPage,
});

const routeTree = rootRoute.addChildren([loginRoute, deskRoute, newNoteRoute, noteDetailRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
