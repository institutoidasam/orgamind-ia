import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuthStore } from '@/stores/auth.store';
import { useCommunication, useCommunications, useEligibleMembers, useMarkCommunicationRead, useUpdateDemand } from '../api';
import type { CommunicationDetail, DemandStatus } from '../schemas';
import { useReadGuard } from '../use-read-guard';
import { civilDate, dateTime, demandUpdateErrorMessage, isViewer, personName } from '../utils';
import { EmptyState, Header, PageError, ReadOnlyNotice, StatusBadge } from './shared';
import { CommentThread } from './comment-thread';
import { Pagination } from './pagination';
import { ReadConfirmationStatus } from './read-confirmation-status';

function assigneeName(assignee: CommunicationDetail['assignee']) { return assignee ? personName(assignee) : 'Sem responsável'; }

function DemandFilters({ q, status, unassigned, onSearch, onStatus, onUnassigned }: { q: string; status: DemandStatus | ''; unassigned: boolean; onSearch: (value: string) => void; onStatus: (value: DemandStatus | '') => void; onUnassigned: (value: boolean) => void }) {
  return <div className="flex flex-wrap gap-2"><Input className="max-w-sm" value={q} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar por assunto ou setor" /><select aria-label="Filtrar demandas por estado" className="h-9 rounded-lg border bg-card px-2" value={status} onChange={(event) => onStatus(event.target.value as DemandStatus | '')}><option value="">Todas as situações</option><option value="OPEN">Abertas</option><option value="IN_PROGRESS">Em andamento</option><option value="WAITING">Aguardando outro setor</option><option value="COMPLETED">Concluídas</option></select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unassigned} onChange={(event) => onUnassigned(event.target.checked)} />Sem responsável</label></div>;
}

function DemandTable({ items }: { items: CommunicationDetail[] }) {
  if (!items.length) return <EmptyState><p>Nenhuma demanda encontrada para este filtro.</p></EmptyState>;
  return <Table><TableHeader><TableRow><TableHead>Demanda</TableHead><TableHead>Situação</TableHead><TableHead>Responsável</TableHead><TableHead>Prazo</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><Link to="/demandas/$communicationId" params={{ communicationId: item.id }}>{item.subject}</Link><p className="text-xs">{item.originSector.name} → {item.destinationSector.name} · {item.reference}</p></TableCell><TableCell><StatusBadge status={item.status} priority={item.priority} /></TableCell><TableCell>{assigneeName(item.assignee)}</TableCell><TableCell>{civilDate(item.dueDate)}</TableCell></TableRow>)}</TableBody></Table>;
}

function DemandListContent({ data, page, onPageChange }: { data: ReturnType<typeof useCommunications>; page: number; onPageChange: (page: number) => void }) {
  if (data.isLoading) return <p className="text-sm text-muted-foreground">Carregando demandas…</p>;
  return <><DemandTable items={data.data?.items ?? []} /><Pagination page={data.data?.page ?? page} pageSize={data.data?.pageSize ?? 25} total={data.data?.total ?? 0} onPageChange={onPageChange} /></>;
}

export function DemandsPage() {
  const [q, setQ] = useState(''); const [status, setStatus] = useState<DemandStatus | ''>(''); const [unassigned, setUnassigned] = useState(false); const [page, setPage] = useState(1);
  const data = useCommunications({ q, kind: 'DEMAND', status: status || undefined, unassigned: unassigned || undefined, page });
  const readonly = isViewer(useAuthStore((state) => state.user?.role));
  if (data.isError) return <PageError retry={() => data.refetch()} />;
  const resetPage = () => setPage(1);
  const action = readonly ? undefined : <Button asChild><Link to="/nova-comunicacao" search={{ kind: undefined }}><Plus />Nova demanda</Link></Button>;
  return <div className="space-y-5"><Header eyebrow="Acompanhamento" title="Demandas" description="Solicitações entre setores, com responsáveis, prazos e andamento." action={action} /><DemandFilters q={q} status={status} unassigned={unassigned} onSearch={(value) => { setQ(value); resetPage(); }} onStatus={(value) => { setStatus(value); resetPage(); }} onUnassigned={(value) => { setUnassigned(value); resetPage(); }} /><DemandListContent data={data} page={page} onPageChange={setPage} /></div>;
}

function WrongDemandKind({ item }: { item: CommunicationDetail }) { return <div><p>Este registro é um comunicado.</p><Button asChild><Link to="/comunicados/$communicationId" params={{ communicationId: item.id }}>Abrir comunicado</Link></Button></div>; }

function DemandActions({ demand, members, pending, onUpdate }: { demand: CommunicationDetail; members: { id: string; name: string | null; email: string | null }[]; pending: boolean; onUpdate: (values: { status?: DemandStatus; assigneeId?: string | null }) => void }) { return <div className="mt-5 grid gap-3 border-y py-4 sm:grid-cols-2"><label className="grid gap-1 text-sm">Responsável<select disabled={pending} value={demand.assignee?.id ?? ''} className="h-9 rounded-lg border bg-card px-2" onChange={(event) => onUpdate({ assigneeId: event.target.value || null })}><option value="">Sem responsável</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name || member.email}</option>)}</select></label><label className="grid gap-1 text-sm">Situação<select disabled={pending} value={demand.status ?? 'OPEN'} className="h-9 rounded-lg border bg-card px-2" onChange={(event) => onUpdate({ status: event.target.value as DemandStatus })}><option value="OPEN">Aberta</option><option value="IN_PROGRESS">Em andamento</option><option value="WAITING">Aguardando outro setor</option><option value="COMPLETED">Concluída</option></select></label>{pending ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><RefreshCw className="size-3 animate-spin" />Salvando alteração…</span> : null}</div>; }

function DemandDetailContent({ demand, readonly, canManage }: { demand: CommunicationDetail; readonly: boolean; canManage: boolean }) {
  const members = useEligibleMembers(demand.destinationSector.id); const update = useUpdateDemand(demand.id);
  const onUpdate = (values: { status?: DemandStatus; assigneeId?: string | null }) => update.mutate({ expectedVersion: demand.version, ...values });
  return <div className="mx-auto max-w-4xl space-y-5"><Header eyebrow={`Demandas / ${demand.reference}`} title={demand.subject} description={`${demand.originSector.name} → ${demand.destinationSector.name} · Prazo: ${civilDate(demand.dueDate)}`} action={<Button asChild variant="outline"><Link to="/demandas">Voltar às demandas</Link></Button>} /><section className="rounded-xl border bg-card p-5"><div className="flex flex-wrap items-center gap-3"><StatusBadge status={demand.status} priority={demand.priority} /><span className="text-sm text-muted-foreground">Responsável: {assigneeName(demand.assignee)}</span></div><p className="mt-5 whitespace-pre-wrap">{demand.message}</p><p className="mt-3 text-xs text-muted-foreground">Aberta por {personName(demand.author)} em {dateTime(demand.createdAt)}</p>{readonly ? <div className="mt-5"><ReadOnlyNotice /></div> : canManage ? <DemandActions members={members.data ?? []} demand={demand} pending={update.isPending} onUpdate={onUpdate} /> : null}{update.isError ? <p role="alert" className="mt-3 text-sm text-destructive">{demandUpdateErrorMessage(update.error)}</p> : null}<CommentThread communicationId={demand.id} events={demand.events} readonly={readonly} /></section></div>;
}

export function DemandDetailPage({ communicationId }: { communicationId: string }) {
  const detail = useCommunication(communicationId); const user = useAuthStore((state) => state.user); const markRead = useMarkCommunicationRead(communicationId);
  const readGuard = useReadGuard(detail.data, markRead.mutateAsync);
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Carregando demanda…</p>;
  if (detail.isError || !detail.data) return <PageError title="Não foi possível abrir esta demanda." retry={() => detail.refetch()} />;
  if (detail.data.kind !== 'DEMAND') return <WrongDemandKind item={detail.data} />;
  return <><ReadConfirmationStatus {...readGuard} /><DemandDetailContent demand={detail.data} readonly={isViewer(user?.role)} canManage={user?.role === 'ADMIN' || user?.sectorId === detail.data.destinationSector.id} /></>;
}

export function DemandDetailRoutePage() { const { communicationId } = useParams({ from: '/_authenticated/demandas/$communicationId' }); return <DemandDetailPage communicationId={communicationId} />; }
