import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/features/internal-communications/components/pagination';
import { usePermission } from '@/features/permissions/use-permission';
import { useDispatchRecipients, useRetryRecipients } from '../api';
import {
  apiErrorText, channelLabel, RECIPIENT_STATUS_LABEL, recipientStatusLabel, retryErrorMessage, SKIP_REASON_LABEL,
  UNCERTAIN_EXPLANATION,
} from '../error-messages';
import { NO_NAME_MATCH_TEXT } from '../name-search';
import type { DispatchRecipient, RecipientStatus, RetryInput } from '../schemas';
import { useBackToLastPage } from '../use-back-to-last-page';
import { PagedError } from './paged-error';

const ALL = 'all';
const STATUSES = Object.keys(RECIPIENT_STATUS_LABEL) as RecipientStatus[];

/** Pulado porque o telefone mudou (G4): não é repetível, o caminho é um envio novo. */
const PHONE_CHANGED_HINT = 'Para avisar essa pessoa, crie um envio novo.';

/** Detalhe além do rótulo: a explicação da incerta, o código da falha (auditoria) e a dica do telefone trocado. */
function reasonText({ status, reason }: DispatchRecipient): string {
  if (status === 'UNCERTAIN') return UNCERTAIN_EXPLANATION;
  if (status === 'SKIPPED' && reason === 'PHONE_CHANGED') return PHONE_CHANGED_HINT;
  return (status === 'FAILED' && reason) || '—';
}

/**
 * Situação da linha. O pulado por vencimento já diz tudo no motivo ("Não enviado: passou da hora"): sem o prefixo
 * "Pulado: ", que repetiria a frase.
 */
function statusText({ status, reason }: DispatchRecipient): string {
  if (status === 'SKIPPED' && reason === 'EXPIRED') return SKIP_REASON_LABEL.EXPIRED;
  return recipientStatusLabel(status, reason);
}

type RowProps = { item: DispatchRecipient; busy: boolean; onRetry: (item: DispatchRecipient) => void };

/** Repetir é ação de envio (DB6): sem `equipe.enviar` a linha só informa. */
function RecipientRow({ item, busy, onRetry }: RowProps) {
  const canRetry = usePermission('equipe.enviar');
  return (
    <TableRow>
      <TableCell>{item.userName}</TableCell>
      <TableCell>{item.phone ?? '—'}</TableCell>
      <TableCell>{statusText(item)}</TableCell>
      <TableCell>{item.channel ? channelLabel(item.channel) : '—'}</TableCell>
      <TableCell>{item.attempts > 0 ? item.attempts : '—'}</TableCell>
      <TableCell className="text-sm">{reasonText(item)}</TableCell>
      <TableCell>
        {item.repeatable && canRetry && (
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
      toast.error(await apiErrorText(err, retryErrorMessage));
    }
  };
  return { run, busy: retry.isPending };
}

/** `query` = busca por nome da tela (já com debounce): o servidor filtra pelo nome exibido (DG13). */
type Props = { dispatchId: string; failedCount: number; query?: string };

/** Destinatários do envio, por nome, com filtro de situação, busca, paginação e `Repetir` nas falhas certas. */
export function RecipientTable({ dispatchId, failedCount, query }: Props) {
  const [status, setStatus] = useState<RecipientStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [seenQuery, setSeenQuery] = useState(query);
  if (seenQuery !== query) {
    setSeenQuery(query);
    setPage(1);
  }
  const recipients = useDispatchRecipients(dispatchId, { status, page, q: query });
  const { run, busy } = useRetryAction(dispatchId);
  const canRetry = usePermission('equipe.enviar');
  const { data } = recipients;
  useBackToLastPage(page, setPage, data);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusFilter value={status} onChange={(next) => { setStatus(next); setPage(1); }} />
        {failedCount > 0 && canRetry && (
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
          searching={(query ?? '').trim() !== ''}
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
  searching: boolean;
  onRetry: (item: DispatchRecipient) => void;
  paging: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void };
};

function RecipientRows({ items, busy, searching, onRetry, paging }: RowsProps) {
  if (items.length === 0) {
    const emptyText = searching ? NO_NAME_MATCH_TEXT : 'Nenhum destinatário nesta situação.';
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="space-y-3">
      <div className="rounded-md border" style={{ borderColor: 'var(--border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead><TableHead>Telefone usado</TableHead><TableHead>Situação</TableHead>
              <TableHead>Número</TableHead><TableHead>Tentativas</TableHead><TableHead>Motivo</TableHead>
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
