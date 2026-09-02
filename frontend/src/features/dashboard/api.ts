import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export type MetricBlock = { count: number; meta: string; sparkline: number[] };
export type DashboardMetrics = {
  activeCampaigns: MetricBlock;
  activeContacts: MetricBlock;
  approvedTemplates: MetricBlock;
  deliveryRate7d: MetricBlock;
  liveFlow: { queued: number; sent: number; delivered: number; read: number; failed: number };
};

export function useDashboardMetrics() {
  return useQuery({
    queryKey: ['metrics', 'dashboard'] as const,
    queryFn: () => api.get('metrics/dashboard').json<DashboardMetrics>(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}
