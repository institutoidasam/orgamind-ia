import { createFileRoute } from '@tanstack/react-router';
import { DemandDetailRoutePage } from '@/features/internal-communications/components/demand-pages';

export const Route = createFileRoute('/_authenticated/demandas/$communicationId')({
  component: DemandDetailRoutePage,
});
