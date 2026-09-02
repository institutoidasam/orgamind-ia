import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/broadcasts')({
  beforeLoad: () => {
    throw redirect({ to: '/campaigns' });
  },
});
