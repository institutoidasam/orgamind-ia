import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore } from '@/stores/auth.store';
import { authenticationDestination } from '@/lib/auth-navigation';
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ location }) => {
    const { accessToken, mustChangePassword } = useAuthStore.getState();
    const destination = authenticationDestination(accessToken, mustChangePassword, location);
    if (destination) throw redirect(destination);
  },
  component: AuthenticatedLayout,
});
