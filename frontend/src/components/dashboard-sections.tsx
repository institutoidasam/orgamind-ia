import { Link } from '@tanstack/react-router';
import { History, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KPIHero } from '@/components/kpi-hero';
import type { DashboardMetrics } from '@/features/dashboard/api';
import type { CampaignSummary } from '@/features/campaigns/schemas';
import { CAMPAIGN_STATUS_LABEL } from '@/features/campaigns/schemas';

function metricValue(block: DashboardMetrics[keyof DashboardMetrics] | undefined): number {
  return block && 'count' in block ? (block.count ?? 0) : 0;
}

export function DashboardKpis({ metrics }: { metrics?: DashboardMetrics }) {
  const cards = [
    { tone: 'brand' as const, label: 'Campanhas em curso', key: 'activeCampaigns' as const },
    { label: 'Contatos ativos', key: 'activeContacts' as const },
    { label: 'Templates aprovados', key: 'approvedTemplates' as const },
    { label: 'Entrega 7d', key: 'deliveryRate7d' as const, suffix: '%' },
  ];
  return (
    <div data-testid="dashboard-kpis" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {cards.map((card) => {
        const metric = metrics?.[card.key];
        return <KPIHero key={card.key} tone={card.tone} label={card.label} value={metricValue(metric)} suffix={card.suffix} meta={metric?.meta} sparkline={metric?.sparkline} />;
      })}
    </div>
  );
}

function formatRowDate(createdAt: CampaignSummary['createdAt']) {
  return new Date(createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function RecentCampaignRow({ campaign }: { campaign: CampaignSummary }) {
  const counts = (campaign.statusCounts ?? []).reduce((acc, item) => ({ ...acc, [item.status]: item._count }), {} as Record<string, number>);
  const total = campaign.totalRecipients || 1;
  const delivered = ((counts.DELIVERED ?? 0) + (counts.READ ?? 0)) / total;
  const read = (counts.READ ?? 0) / total;
  const date = formatRowDate(campaign.createdAt);
  return (
    <Link to="/campaigns/$campaignId" params={{ campaignId: campaign.id }} className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-[var(--surface-hover)] sm:px-5 md:grid md:grid-cols-[2fr_1.2fr_0.8fr_1.2fr_0.8fr] md:items-center md:gap-3">
      <div className="min-w-0"><div className="truncate text-sm font-medium">{campaign.name}</div><div className="ds-mono truncate text-xs" style={{ color: 'var(--foreground-muted)' }}>{campaign.template?.metaName}</div></div>
      <div className="flex items-center justify-between gap-3 md:contents"><div className="text-xs" style={{ color: 'var(--foreground-muted)' }}>{campaign.totalRecipients} destinatários</div><div className="ds-mono text-xs md:hidden" style={{ color: 'var(--foreground-muted)' }}>{date}</div></div>
      <div className="min-w-0"><div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-sunken)' }}><div className="h-full" style={{ width: `${Math.min(100, delivered * 100)}%`, background: 'var(--brand-orange)' }} /></div><div className="ds-mono mt-1 text-[11px]" style={{ color: 'var(--foreground-muted)' }}>{(delivered * 100).toFixed(0)}% entregue · {(read * 100).toFixed(0)}% lida</div></div>
      <div className="text-xs" style={{ color: 'var(--foreground-muted)' }}>{CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}</div>
      <div className="ds-mono hidden text-xs md:block" style={{ color: 'var(--foreground-muted)' }}>{date}</div>
    </Link>
  );
}

export function DashboardHeader({ today, campaignCount, activeCampaignCount, greeting }: { today: string; campaignCount: number; activeCampaignCount: number; greeting: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><div className="ds-eyebrow" style={{ color: 'var(--foreground-muted)' }}>painel · {today}</div><h1 className="mt-1 font-sans text-2xl font-bold tracking-tight sm:text-[26px]" style={{ color: 'var(--brand-primary)' }}>{greeting}, operador.</h1><p className="mt-1 text-[13px]" style={{ color: 'var(--foreground-muted)' }}>{campaignCount} campanhas registradas · {activeCampaignCount} em curso.</p></div>
      <div className="flex gap-2"><Button variant="outline" asChild><Link to="/campaigns"><History className="size-4" />Histórico</Link></Button><Button asChild><Link to="/campaigns/new"><Send className="size-4" />Nova campanha</Link></Button></div>
    </header>
  );
}

export function RecentCampaigns({ campaigns }: { campaigns: CampaignSummary[] }) {
  return (
    <div className="overflow-hidden rounded-[10px] border" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}><div><h3 className="text-sm font-semibold" style={{ color: 'var(--brand-primary)' }}>Campanhas recentes</h3><p className="mt-0.5 text-xs" style={{ color: 'var(--foreground-muted)' }}>Acompanhe as últimas campanhas criadas</p></div><Link to="/campaigns" className="text-xs font-medium" style={{ color: 'var(--brand-primary)' }}>Ver tudo →</Link></div>
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {campaigns.map((campaign) => <RecentCampaignRow key={campaign.id} campaign={campaign} />)}
        {campaigns.length === 0 && <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--foreground-muted)' }}>Nenhuma campanha ainda. Crie a primeira em <strong>Nova campanha</strong>.</div>}
      </div>
    </div>
  );
}
