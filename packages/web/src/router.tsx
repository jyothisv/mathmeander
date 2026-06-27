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
import { clearAllDrafts } from './editor/draftStore';
import { DeskPage } from './pages/Desk';
import { JournalPage } from './pages/Journal';
import { JournalDayPage } from './pages/JournalDay';
import { LoginPage } from './pages/Login';
import { NewNotePage } from './pages/NewNote';
import { NoteDetailPage } from './pages/NoteDetail';
import { NotebooksPage } from './pages/Notebooks';
import { NotebookDetailPage } from './pages/NotebookDetail';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <nav>
        <Link to="/">Desk</Link>
        <Link to="/journal">Journal</Link>
        <Link to="/notebooks">Notebooks</Link>
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
      onClick={(e) => {
        // Await the local-draft clear BEFORE navigating, or the full-page nav would cut off the async
        // IndexedDB delete and leave unsynced drafts behind (shared-browser privacy).
        e.preventDefault();
        void (async () => {
          signOut(); // clear the token FIRST → a racing unmount/exit writeDraft is suppressed (no session)
          await Promise.allSettled([logout(), clearAllDrafts()]);
          window.location.assign('/login');
        })();
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

const journalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/journal',
  beforeLoad: requireAuth,
  component: JournalPage,
});

const journalDayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/journal/$date',
  beforeLoad: requireAuth,
  component: JournalDayPage,
});

const notebooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notebooks',
  beforeLoad: requireAuth,
  component: NotebooksPage,
});

const notebookDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notebooks/$slug',
  beforeLoad: requireAuth,
  component: NotebookDetailPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  deskRoute,
  newNoteRoute,
  noteDetailRoute,
  journalRoute,
  journalDayRoute,
  notebooksRoute,
  notebookDetailRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
