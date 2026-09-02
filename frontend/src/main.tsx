// Sentry must be initialised before the rest of the app loads so its
// instrumentation can patch the global fetch / unhandled-error hooks.
import './lib/sentry';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import * as Sentry from '@sentry/react';
import { routeTree } from './routeTree.gen';
import { queryClient } from './lib/query-client';
import { restoreSession } from './lib/api-client';
import './index.css';
import { restoreTheme } from './lib/theme';
restoreTheme();

const router = createRouter({ routeTree });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

async function bootstrap() {
  // If a refresh cookie is present, recover the session silently before the
  // first render so authenticated routes don't bounce to /login on reload.
  await restoreSession();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Sentry.ErrorBoundary fallback={<p>Algo deu errado.</p>}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          {import.meta.env.DEV && <ReactQueryDevtools />}
        </QueryClientProvider>
      </Sentry.ErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
