import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import 'katex/dist/katex.min.css';
import './editor/editor.css';
import { router } from './router';
import { initMathRuntime } from './editor/mathRuntime';
import { initNumberingRuntime } from './editor/numberingRuntime';

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

// Instantiate both WASM runtimes before mount: MATH (parse/render) + NUMBERING (live block designations
// for citations). On failure of either, mount anyway — each degrades gracefully (math → source-only;
// citations → their stored fallback text) rather than crashing the editor.
void Promise.allSettled([initMathRuntime(), initNumberingRuntime()]).then((results) => {
  results.forEach((r) => {
    if (r.status === 'rejected') console.error('A WASM runtime failed to load — degrading.', r.reason);
  });
  mount();
});
