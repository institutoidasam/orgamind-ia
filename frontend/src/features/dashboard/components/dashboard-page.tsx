import { DashboardHeader, DashboardKpis, RecentCampaigns } from '@/components/dashboard-sections';
import { LiveFlow } from '@/components/live-flow';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { useCampaigns } from '@/features/campaigns/api';
import type { DashboardMetrics } from '@/features/dashboard/api';
import { useDashboardMetrics } from '@/features/dashboard/api';

const EMPTY_LIVE_FLOW = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
} as const;

function metricValue(
  block: DashboardMetrics[keyof DashboardMetrics] | undefined,
): number {
  return block && 'count' in block ? (block.count ?? 0) : 0;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function DashboardPage() {
  const metrics = useDashboardMetrics();
  const campaigns = useCampaigns();
  const today = new Date().toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  if (metrics.isError) {
    return <QueryErrorFallback error={metrics.error} onRetry={() => metrics.refetch()} />;
  }

  if (campaigns.isError) {
    return <QueryErrorFallback error={campaigns.error} onRetry={() => campaigns.refetch()} />;
  }

  return (
    <div className="space-y-5">
      <DashboardHeader
        today={today}
        campaignCount={campaigns.data?.length ?? 0}
        activeCampaignCount={metricValue(metrics.data?.activeCampaigns)}
        greeting={greeting()}
      />
      <DashboardKpis metrics={metrics.data} />
      <LiveFlow counts={metrics.data?.liveFlow ?? EMPTY_LIVE_FLOW} />
      <RecentCampaigns campaigns={(campaigns.data ?? []).slice(0, 5)} />
    </div>
  );
}
