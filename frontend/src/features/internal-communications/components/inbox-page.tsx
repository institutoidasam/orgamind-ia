import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth.store';
import { useInbox, useMarkCommunicationRead } from '../api';
import type { CommunicationDetail } from '../schemas';
import { useReadGuard } from '../use-read-guard';
import { isViewer } from '../utils';
import { EmptyState, Header, PageError, StatusBadge } from './shared';
import { Pagination } from './pagination';
import { ReadConfirmationStatus } from './read-confirmation-status';

type Filter = 'all' | 'mine' | 'unassigned';

function selectItems(items: CommunicationDetail[], filter: Filter, sectorId?: string | null) {
  if (filter === 'unassigned') return items.filter((item) => !item.assignee);
  if (filter !== 'mine' || !sectorId) return filter === 'mine' ? [] : items;
  return items.filter((item) => item.destinationSector.id === sectorId || item.ccSectors.some((sector) => sector.id === sectorId));
}

function detailPath(item: CommunicationDetail) {
  return item.kind === 'ANNOUNCEMENT' ? '/comunicados/$communicationId' : '/demandas/$communicationId';
}

function useInboxFilters(filter: Filter, q: string, page: number, sectorId?: string | null) {
  return { q, page, unassigned: filter === 'unassigned' || undefined, sectorId: filter === 'mine' ? sectorId ?? undefined : undefined };
}

function useInboxState() {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string>();
  const resetSelection = () => setSelectedId(undefined);
  const resetPage = () => setPage(1);
  return { filter, page, q, selectedId, setFilter, setPage, setQ, resetPage, resetSelection, setSelectedId };
}

function useInboxModel({ filter, q, page, selectedId, sectorId }: { filter: Filter; q: string; page: number; selectedId?: string; sectorId?: string | null }) {
  const inbox = useInbox(useInboxFilters(filter, q, page, sectorId));
  const items = selectItems(inbox.data?.items ?? [], filter, sectorId);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const markRead = useMarkCommunicationRead(selected?.id ?? '');
  const readGuard = useReadGuard(selected, markRead.mutateAsync);
  return { inbox, items, selected, readGuard };
}

function InboxFilters({ filter, q, onFilter, onSearch }: { filter: Filter; q: string; onFilter: (filter: Filter) => void; onSearch: (value: string) => void }) {
  return <div className="flex gap-2"><Input value={q} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar por assunto ou setor" />{(['all', 'mine', 'unassigned'] as const).map((value) => <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => onFilter(value)}>{value === 'all' ? 'Todas' : value === 'mine' ? 'Meu setor' : 'Sem responsável'}</Button>)}</div>;
}

function InboxHeader({ readonly }: { readonly: boolean }) {
  const action = readonly ? undefined : <Button asChild><Link to="/nova-comunicacao" search={{ kind: undefined }}>Nova comunicação</Link></Button>;
  return <Header eyebrow="Comunicação interna" title="Caixa de entrada" description="Demandas e comunicados destinados ao seu setor." action={action} />;
}

function InboxContent({ items, selected, readGuard, onSelect }: { items: CommunicationDetail[]; selected?: CommunicationDetail; readGuard: ReturnType<typeof useReadGuard>; onSelect: (id: string) => void }) {
  if (!items.length) return <EmptyState><p>Nenhuma comunicação encontrada para este filtro.</p></EmptyState>;
  return <div className="grid gap-4 lg:grid-cols-[.8fr_1.2fr]"><InboxRows items={items} onSelect={onSelect} />{selected ? <SelectedCommunication item={selected} readGuard={readGuard} /> : null}</div>;
}

function InboxRows({ items, onSelect }: { items: CommunicationDetail[]; onSelect: (id: string) => void }) {
  return <div className="space-y-2">{items.map((item) => <button type="button" className="w-full rounded-lg border bg-card p-3 text-left" onClick={() => onSelect(item.id)} key={item.id}><strong>{item.subject}</strong><p className="text-xs">{item.originSector.name} → {item.destinationSector.name}</p><StatusBadge status={item.status} priority={item.priority} /></button>)}</div>;
}

function SelectedCommunication({ item, readGuard }: { item: CommunicationDetail; readGuard: ReturnType<typeof useReadGuard> }) {
  return <section className="rounded-xl border bg-card p-5"><h2>{item.subject}</h2><p className="mt-3 whitespace-pre-wrap">{item.message}</p><div className="mt-3"><ReadConfirmationStatus {...readGuard} /></div><Button asChild className="mt-4" variant="outline"><Link to={detailPath(item) as never} params={{ communicationId: item.id } as never}>Abrir {item.kind === 'DEMAND' ? 'demanda' : 'comunicado'}</Link></Button></section>;
}

function InboxResult({ model, page, onPageChange, onSelect }: { model: ReturnType<typeof useInboxModel>; page: number; onPageChange: (page: number) => void; onSelect: (id: string) => void }) {
  if (model.inbox.isLoading) return <p>Carregando caixa de entrada…</p>;
  return <><InboxContent items={model.items} selected={model.selected} readGuard={model.readGuard} onSelect={onSelect} /><Pagination page={model.inbox.data?.page ?? page} pageSize={model.inbox.data?.pageSize ?? 25} total={model.inbox.data?.total ?? 0} onPageChange={onPageChange} /></>;
}

export function InboxPage() {
  const state = useInboxState();
  const user = useAuthStore((store) => store.user);
  const model = useInboxModel({ filter: state.filter, q: state.q, page: state.page, selectedId: state.selectedId, sectorId: user?.sectorId });
  if (model.inbox.isError) return <PageError retry={() => model.inbox.refetch()} />;
  const changeFilter = (filter: Filter) => { state.setFilter(filter); state.resetPage(); state.resetSelection(); };
  const changeSearch = (q: string) => { state.setQ(q); state.resetPage(); state.resetSelection(); };
  const changePage = (page: number) => { state.setPage(page); state.resetSelection(); };
  return <div className="space-y-5"><InboxHeader readonly={isViewer(user?.role)} /><InboxFilters filter={state.filter} q={state.q} onFilter={changeFilter} onSearch={changeSearch} /><InboxResult model={model} page={state.page} onPageChange={changePage} onSelect={state.setSelectedId} /></div>;
}
