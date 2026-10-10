import { createFileRoute } from '@tanstack/react-router';
import { InternalDashboardPage } from '@/features/internal-communications/components/internal-dashboard-page';

export const Route = createFileRoute('/_authenticated/dashboard')({
  component: InternalDashboardPage,
});
