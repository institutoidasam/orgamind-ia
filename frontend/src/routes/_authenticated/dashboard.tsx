import { createFileRoute, Link } from '@tanstack/react-router';
import { History, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KPIHero } from '@/components/kpi-hero';
import { LiveFlow } from '@/components/live-flow';
import { useDashboardMetrics } from '@/features/dashboard/api';
import type { DashboardMetrics } from '@/features/dashboard/api';
import { useCampaigns } from '@/features/campaigns/api';
import type { CampaignSummary } from '@/features/campaigns/schemas';
import { CAMPAIGN_STATUS_LABEL } from '@/features/campaigns/schemas';
import { QueryErrorFallback } from '@/components/query-error-fallback';

export const Route = createFileRoute('/_authenticated/dashboard')({
  component: DashboardPage,
});

/** Reads a metric block's count, collapsing the `?? 0` fallback in one place. */
function kpiValue(block: DashboardMetrics[keyof DashboardMetrics] | undefined): number {
  if (block && 'count' in block) return block.count ?? 0;
  return 0;
}

const EMPTY_LIVE_FLOW = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
} as const;

function DashboardKpis({ metrics }: { metrics?: DashboardMetrics }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <KPIHero
        tone="brand"
        label="Campanhas em curso"
        value={kpiValue(metrics?.activeCampaigns)}
        meta={metrics?.activeCampaigns.meta}
        sparkline={metrics?.activeCampaigns.sparkline}
      />
      <KPIHero
        label="Contatos ativos"
        value={kpiValue(metrics?.activeContacts)}
        meta={metrics?.activeContacts.meta}
        sparkline={metrics?.activeContacts.sparkline}
      />
      <KPIHero
        label="Templates aprovados"
        value={kpiValue(metrics?.approvedTemplates)}
        meta={metrics?.approvedTemplates.meta}
        sparkline={metrics?.approvedTemplates.sparkline}
      />
      <KPIHero
        label="Entrega 7d"
        value={kpiValue(metrics?.deliveryRate7d)}
        suffix="%"
        meta={metrics?.deliveryRate7d.meta}
        sparkline={metrics?.deliveryRate7d.sparkline}
      />
    </div>
  );
}

function formatRowDate(createdAt: CampaignSummary['createdAt']): string {
  return new Date(createdAt).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
  });
}

function RecentCampaignRow({ campaign: c }: { campaign: CampaignSummary }) {
  const counts = (c.statusCounts ?? []).reduce(
    (acc, x) => ({ ...acc, [x.status]: x._count }),
    {} as Record<string, number>,
  );
  const total = c.totalRecipients || 1;
  const delivered = ((counts.DELIVERED ?? 0) + (counts.READ ?? 0)) / total;
  const read = (counts.READ ?? 0) / total;
  const date = formatRowDate(c.createdAt);

  return (
    <Link
      to="/campaigns/$campaignId"
      params={{ campaignId: c.id }}
      className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-[var(--surface-hover)] sm:px-5 md:grid md:grid-cols-[2fr_1.2fr_0.8fr_1.2fr_0.8fr] md:items-center md:gap-3"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{c.name}</div>
        <div
          className="ds-mono truncate text-xs"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {c.template?.metaName}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 md:contents">
        <div
          className="text-xs"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {c.totalRecipients} destinatários
        </div>
        <div
          className="ds-mono text-xs md:hidden"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {date}
        </div>
      </div>
      <div className="min-w-0">
        <div
          className="h-1.5 overflow-hidden rounded-full"
          style={{ background: 'var(--surface-sunken)' }}
        >
          <div
            className="h-full"
            style={{
              width: `${Math.min(100, delivered * 100)}%`,
              background: 'var(--gradient-brand)',
            }}
          />
        </div>
        <div
          className="ds-mono mt-1 text-[11px]"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {(delivered * 100).toFixed(0)}% entregue ·{' '}
          {(read * 100).toFixed(0)}% lida
        </div>
      </div>
      <div
        className="text-xs"
        style={{ color: 'var(--foreground-muted)' }}
      >
        {CAMPAIGN_STATUS_LABEL[c.status] ?? c.status}
      </div>
      <div
        className="ds-mono hidden text-xs md:block"
        style={{ color: 'var(--foreground-muted)' }}
      >
        {date}
      </div>
    </Link>
  );
}

function DashboardPage() {
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

  const recent = (campaigns.data ?? []).slice(0, 5);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="ds-eyebrow">painel · {today}</div>
          <h1 className="ds-display-lg mt-1">{greet()}, operador.</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--foreground-muted)' }}>
            {campaigns.data?.length ?? 0} campanhas registradas · {kpiValue(metrics.data?.activeCampaigns)} em curso.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/campaigns">
              <History className="size-4" />
              Histórico
            </Link>
          </Button>
          <Button asChild>
            <Link to="/campaigns/new">
              <Send className="size-4" />
              Nova campanha
            </Link>
          </Button>
        </div>
      </header>

      <DashboardKpis metrics={metrics.data} />

      <LiveFlow counts={metrics.data?.liveFlow ?? EMPTY_LIVE_FLOW} />

      <div
        className="rounded-xl border"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="text-base font-semibold">Campanhas recentes</h3>
          <Link
            to="/campaigns"
            className="text-xs"
            style={{ color: 'var(--foreground-muted)' }}
          >
            Ver tudo →
          </Link>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {recent.map((c) => (
            <RecentCampaignRow key={c.id} campaign={c} />
          ))}
          {recent.length === 0 && (
            <div
              className="px-5 py-8 text-center text-sm"
              style={{ color: 'var(--foreground-muted)' }}
            >
              Nenhuma campanha ainda. Crie a primeira em{' '}
              <strong>Nova campanha</strong>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function greet() {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}
