import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN;

// Without VITE_SENTRY_DSN, Sentry stays uninitialised — every Sentry.* call
// becomes a no-op, so the rest of the app does not need to guard imports.
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_GIT_SHA,
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
  });
}

export { Sentry };
