import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/features/internal-communications/components/pagination';
import { useDispatchRecipients, useRetryRecipients } from '../api';
import {
  apiErrorCode, channelLabel, RECIPIENT_STATUS_LABEL, recipientStatusLabel, retryErrorMessage, UNCERTAIN_EXPLANATION,
} from '../error-messages';
import type { DispatchRecipient, RecipientStatus, RetryInput } from '../schemas';
import { useBackToLastPage } from '../use-back-to-last-page';
import { PagedError } from './paged-error';

const ALL = 'all';
const STATUSES = Object.keys(RECIPIENT_STATUS_LABEL) as RecipientStatus[];

/** Detalhe além do rótulo: a explicação da incerta e o código da falha (auditoria); o resto não tem. */
function reasonText({ status, reason }: DispatchRecipient): string {
  if (status === 'UNCERTAIN') return UNCERTAIN_EXPLANATION;
  return (status === 'FAILED' && reason) || '—';
}

type RowProps = { item: DispatchRecipient; busy: boolean; onRetry: (item: DispatchRecipient) => void };

function RecipientRow({ item, busy, onRetry }: RowProps) {
  return (
    <TableRow>
      <TableCell>{item.userName}</TableCell>
      <TableCell>{recipientStatusLabel(item.status, item.reason)}</TableCell>
      <TableCell>{item.channel ? channelLabel(item.channel) : '—'}</TableCell>
      <TableCell>{item.attempts > 0 ? item.attempts : '—'}</TableCell>
      <TableCell className="text-sm">{reasonText(item)}</TableCell>
      <TableCell>
        {item.repeatable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onRetry(item)}>Repetir</Button>
        )}
      </TableCell>
    </TableRow>
  );
}

type FilterProps = { value: RecipientStatus | undefined; onChange: (status: RecipientStatus | undefined) => void };

function StatusFilter({ value, onChange }: FilterProps) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : (v as RecipientStatus))}>
      <SelectTrigger aria-label="Situação" className="w-56"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>Todas</SelectItem>
        {STATUSES.map((s) => <SelectItem key={s} value={s}>{RECIPIENT_STATUS_LABEL[s]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Repete e avisa no toast; o erro usa a mensagem do servidor (403, 404) ou a de repetição. */
function useRetryAction(dispatchId: string) {
  const retry = useRetryRecipients(dispatchId);
  const run = async (input: RetryInput) => {
    try {
      const { requeued } = await retry.mutateAsync(input);
      if (requeued > 0) toast.success(`${requeued} mensagem(ns) na fila de novo`);
      else toast.info('Nada para repetir');
    } catch (err) {
      toast.error(retryErrorMessage(await apiErrorCode(err)));
    }
  };
  return { run, busy: retry.isPending };
}

type Props = { dispatchId: string; failedCount: number };

/** Destinatários do envio, por nome, com filtro de situação, paginação e `Repetir` nas falhas certas. */
export function RecipientTable({ dispatchId, failedCount }: Props) {
  const [status, setStatus] = useState<RecipientStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const recipients = useDispatchRecipients(dispatchId, { status, page });
  const { run, busy } = useRetryAction(dispatchId);
  const { data } = recipients;
  useBackToLastPage(page, setPage, data);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusFilter value={status} onChange={(next) => { setStatus(next); setPage(1); }} />
        {failedCount > 0 && (
          <Button variant="outline" disabled={busy} onClick={() => run({ all: true })}>
            Repetir todas as falhas ({failedCount})
          </Button>
        )}
      </div>
      {recipients.isLoading && <Skeleton className="h-40 w-full" />}
      {recipients.isError && (
        <PagedError error={recipients.error} onRetry={recipients.refetch} page={page} onFirstPage={() => setPage(1)} />
      )}
      {data && (
        <RecipientRows
          items={data.items}
          busy={busy}
          onRetry={(item) => run({ recipientIds: [item.id] })}
          paging={{ page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }}
        />
      )}
    </section>
  );
}

type RowsProps = {
  items: DispatchRecipient[];
  busy: boolean;
  onRetry: (item: DispatchRecipient) => void;
  paging: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void };
};

function RecipientRows({ items, busy, onRetry, paging }: RowsProps) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum destinatário nesta situação.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead><TableHead>Situação</TableHead><TableHead>Número</TableHead>
              <TableHead>Tentativas</TableHead><TableHead>Motivo</TableHead>
              <TableHead><span className="sr-only">Ações</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => <RecipientRow key={item.id} item={item} busy={busy} onRetry={onRetry} />)}
          </TableBody>
        </Table>
      </div>
      {paging.total > paging.pageSize && <Pagination {...paging} />}
    </div>
  );
}
