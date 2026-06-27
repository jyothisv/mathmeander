import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import 'katex/dist/katex.min.css';
import './editor/editor.css';
import { router } from './router';
import { initMathRuntime } from './editor/mathRuntime';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
});

function mount(): void {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// Instantiate the WASM math runtime before mount so the editor can parse/render math synchronously. On
// FAILURE, mount anyway: prose editing is unaffected and math degrades to source-only (renderMath/
// mathRecognize guard on isMathRuntimeReady) — never a silently-broken editor that crashes on first math use.
void initMathRuntime().then(mount, (err: unknown) => {
  console.error('Math runtime failed to load — math will display as source only.', err);
  mount();
});
