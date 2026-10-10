import { createFileRoute } from '@tanstack/react-router';
import { DemandsPage } from '@/features/internal-communications/components/demand-pages';

export const Route = createFileRoute('/_authenticated/demandas/')({ component: DemandsPage });
