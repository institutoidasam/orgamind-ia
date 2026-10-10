import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth.store';
import { useCommunication, useCommunications, useMarkCommunicationRead } from '../api';
import type { CommunicationDetail } from '../schemas';
import { useReadGuard } from '../use-read-guard';
import { dateTime, isViewer, personName } from '../utils';
import { CommunicationRow, EmptyState, Header, PageError, ReadOnlyNotice } from './shared';
import { CommentThread } from './comment-thread';
import { Pagination } from './pagination';
import { ReadConfirmationStatus } from './read-confirmation-status';

function NoticesHeader({ readonly }: { readonly: boolean }) {
  const action = readonly ? undefined : <Button asChild><Link to="/nova-comunicacao" search={{ kind: 'ANNOUNCEMENT' }}><Plus />Novo comunicado</Link></Button>;
  return <Header eyebrow="Informação compartilhada" title="Comunicados" description="Avisos publicados para os setores envolvidos." action={action} />;
}

function NoticeList({ items }: { items: CommunicationDetail[] }) {
  if (!items.length) return <EmptyState><p>Nenhum comunicado publicado para seu setor.</p></EmptyState>;
  return <div className="grid gap-2">{items.map((item) => <CommunicationRow key={item.id} item={item} to="/comunicados/$communicationId" />)}</div>;
}

function NoticePageContent({ page, onPageChange }: { page: ReturnType<typeof useCommunications>; onPageChange: (page: number) => void }) {
  if (page.isLoading) return <p className="text-sm text-muted-foreground">Carregando comunicados…</p>;
  return <><NoticeList items={page.data?.items ?? []} /><Pagination page={page.data?.page ?? 1} pageSize={page.data?.pageSize ?? 25} total={page.data?.total ?? 0} onPageChange={onPageChange} /></>;
}

export function NoticesPage() {
  const [pageNumber, setPageNumber] = useState(1);
  const notices = useCommunications({ kind: 'ANNOUNCEMENT', page: pageNumber });
  const readonly = isViewer(useAuthStore((state) => state.user?.role));
  if (notices.isError) return <PageError retry={() => notices.refetch()} />;
  return <div className="space-y-5"><NoticesHeader readonly={readonly} /><NoticePageContent page={notices} onPageChange={setPageNumber} /></div>;
}

function WrongNoticeKind({ item }: { item: CommunicationDetail }) {
  return <div><p>Este registro é uma demanda.</p><Button asChild><Link to="/demandas/$communicationId" params={{ communicationId: item.id }}>Abrir demanda</Link></Button></div>;
}

function NoticeContent({ item, readonly }: { item: CommunicationDetail; readonly: boolean }) {
  const recipients = [item.destinationSector.name, ...item.ccSectors.map((sector) => sector.name)].join(', ');
  return <div className="mx-auto max-w-3xl space-y-5"><Header eyebrow={`Comunicado / ${item.reference}`} title={item.subject} description={`${item.originSector.name} → ${recipients}`} action={<Button asChild variant="outline"><Link to="/comunicados">Voltar aos comunicados</Link></Button>} /><article className="rounded-xl border bg-card p-6"><p className="whitespace-pre-wrap leading-7">{item.message}</p><footer className="mt-6 border-t pt-4 text-sm text-muted-foreground">Publicado por {personName(item.author)} em {dateTime(item.createdAt)}</footer>{readonly ? <div className="mt-5"><ReadOnlyNotice /></div> : null}<CommentThread communicationId={item.id} events={item.events} readonly={readonly} /></article></div>;
}

export function NoticeDetailPage({ communicationId }: { communicationId: string }) {
  const notice = useCommunication(communicationId);
  const markRead = useMarkCommunicationRead(communicationId);
  const readonly = isViewer(useAuthStore((state) => state.user?.role));
  const readGuard = useReadGuard(notice.data, markRead.mutateAsync);
  if (notice.isLoading) return <p className="text-sm text-muted-foreground">Carregando comunicado…</p>;
  if (notice.isError || !notice.data) return <PageError title="Não foi possível abrir este comunicado." retry={() => notice.refetch()} />;
  return notice.data.kind === 'ANNOUNCEMENT' ? <><ReadConfirmationStatus {...readGuard} /><NoticeContent item={notice.data} readonly={readonly} /></> : <WrongNoticeKind item={notice.data} />;
}

export function NoticeDetailRoutePage() {
  const { communicationId } = useParams({ from: '/_authenticated/comunicados/$communicationId' });
  return <NoticeDetailPage communicationId={communicationId} />;
}
