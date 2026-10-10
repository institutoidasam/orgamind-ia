import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import { useInternalDashboard } from '../api';
import type { CommunicationKind, InternalDashboard } from '../schemas';
import { dateTime, isViewer, personName } from '../utils';
import { CommunicationRow, EmptyState, Header, PageError } from './shared';

type KpiKey = 'needsAction' | 'waitingOthers' | 'unassigned' | 'completedThisWeek';
const labels: Record<KpiKey, string> = { needsAction: 'Precisam de ação do meu setor', waitingOthers: 'Aguardando outros setores', unassigned: 'Sem responsável', completedThisWeek: 'Concluídas nesta semana' };

function eventLabel(kind: string, message?: string | null) { return message || ({ CREATED: 'abriu a comunicação', COMMENTED: 'adicionou uma atualização', STATUS_CHANGED: 'alterou a situação', ASSIGNED: 'atribuiu um responsável', UNASSIGNED: 'removeu o responsável', PRIORITY_CHANGED: 'alterou a prioridade', DUE_DATE_CHANGED: 'alterou o prazo' }[kind] ?? 'atualizou a comunicação'); }
function communicationPath(kind: CommunicationKind | undefined, reference: string) { return kind === 'ANNOUNCEMENT' || reference.startsWith('CM-') ? '/comunicados/$communicationId' : '/demandas/$communicationId'; }

function OverviewActions({ readonly }: { readonly: boolean }) { return <div className="flex gap-2"><Button asChild variant="outline"><Link to="/caixa-de-entrada">Ver caixa de entrada</Link></Button>{readonly ? null : <Button asChild><Link to="/nova-comunicacao" search={{ kind: undefined }}>Nova comunicação</Link></Button>}</div>; }

function KpiGrid({ data }: { data: InternalDashboard }) {
  const values: Record<KpiKey, number> = { needsAction: data.needsAction, waitingOthers: data.waitingOthers, unassigned: data.unassigned, completedThisWeek: data.completedThisWeek };
  return <section data-testid="internal-dashboard-kpis" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{(Object.keys(labels) as KpiKey[]).map((key) => <article className="rounded-[10px] border bg-card p-4" key={key}><p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{labels[key]}</p><p className="mt-1 text-3xl font-semibold text-foreground">{values[key]}</p>{key === 'needsAction' ? <p className="mt-2 text-xs text-muted-foreground">{data.nearDeadline} com prazo próximo</p> : null}</article>)}</section>;
}

function RecentUpdates({ data }: { data: InternalDashboard }) {
  if (!data.recentUpdates.length) return <EmptyState><p>Não há atualizações recentes.</p></EmptyState>;
  return <div className="space-y-3 rounded-[10px] border bg-card p-4">{data.recentUpdates.map((event) => <article key={event.id} className="border-l-2 border-[var(--brand-orange)] pl-3"><p className="text-sm"><strong>{personName(event.actor)}</strong> {eventLabel(event.kind, event.message)} em <Link className="underline" to={communicationPath(event.communication.kind, event.communication.reference) as never} params={{ communicationId: event.communication.id } as never}>{event.communication.subject}</Link></p><p className="text-xs text-muted-foreground">{dateTime(event.createdAt)}</p></article>)}</div>;
}

function DashboardContent({ data }: { data: InternalDashboard }) { return <><KpiGrid data={data} /><div className="grid gap-5 lg:grid-cols-[1.65fr_1fr]"><section><div className="mb-3 flex items-center justify-between"><h2 className="font-heading text-lg">Prioridades</h2><Button asChild variant="link" size="sm"><Link to="/demandas">Ver demandas</Link></Button></div>{data.priorities.length ? <div className="space-y-2">{data.priorities.map((item) => <CommunicationRow item={item} to="/demandas/$communicationId" key={item.id} />)}</div> : <EmptyState><p>Não há demandas prioritárias.</p></EmptyState>}</section><section><h2 className="mb-3 font-heading text-lg">Atualizações recentes</h2><RecentUpdates data={data} /></section></div></>; }

function getOverviewContext(user: { role?: string; sectorId?: string | null } | null | undefined, data: InternalDashboard) {
  const unconfigured = Boolean(user && user.role !== 'ADMIN' && !user.sectorId);
  const sector = typeof data.sector === 'object' ? data.sector?.name : undefined;
  const description = unconfigured ? 'Seu usuário precisa ser associado a um setor para acompanhar comunicações.' : sector ? `Setor ${sector}` : 'Visão das comunicações autorizadas.';
  return { unconfigured, description, readonly: isViewer(user?.role) || unconfigured };
}

function OverviewContent({ data, user }: { data: InternalDashboard; user: { role?: string; sectorId?: string | null } | null | undefined }) {
  const context = getOverviewContext(user, data);
  return <div className="space-y-6"><Header eyebrow="Trabalho interno" title="Visão geral" description={context.description} action={<OverviewActions readonly={context.readonly} />} />{context.unconfigured ? <EmptyState><p>Peça a um administrador para definir seu setor antes de usar os módulos internos.</p></EmptyState> : <DashboardContent data={data} />}</div>;
}

export function InternalDashboardPage() {
  const dashboard = useInternalDashboard(); const user = useAuthStore((state) => state.user);
  if (dashboard.isError) return <PageError title="Não foi possível carregar a visão geral." retry={() => dashboard.refetch()} />;
  if (dashboard.isLoading) return <p className="text-sm text-muted-foreground">Carregando visão geral…</p>;
  if (!dashboard.data) return null;
  return <OverviewContent data={dashboard.data} user={user} />;
}
