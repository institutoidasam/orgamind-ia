import { useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAuditDateTime } from '@/features/audit-trail/labels';
import { apiErrorText } from '@/features/people-export/api';
import { downloadErrors, useCloseImport, useDiscardImport, useImportBatches } from '../api';
import { SITUATION_LABEL } from '../labels';
import { notEnteredCount } from '../progress';
import type { BatchListItem } from '../schemas';

const NONE = '—';
const REPORT_FALLBACK = 'Não foi possível baixar o relatório. Tente de novo.';
const CLOSE_FALLBACK = 'Não foi possível encerrar a gravação. Tente de novo.';
const DISCARD_FALLBACK = 'Não foi possível descartar o lote. Tente de novo.';

function toastApiError(error: unknown, fallback: string): void {
  void apiErrorText(error, fallback).then((text) => toast.error(text));
}

function ReportButton({ batchId }: { batchId: string }) {
  const [pending, setPending] = useState(false);
  const download = () => {
    setPending(true);
    downloadErrors(batchId)
      .catch((error: unknown) => toastApiError(error, REPORT_FALLBACK))
      .finally(() => setPending(false));
  };
  return (
    <Button size="sm" variant="outline" onClick={download} disabled={pending}>
      Relatório
    </Button>
  );
}

type RunOptions = { onSuccess: () => void; onError: (error: unknown) => void };

type ConfirmActionProps = {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  failure: string;
  pending: boolean;
  run: (options: RunOptions) => void;
};

/** Botão da linha com confirmação: o diálogo fica aberto enquanto a API responde e fecha só se der certo. */
function ConfirmAction({ label, title, description, confirmLabel, failure, pending, run }: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    run({ onSuccess: () => setOpen(false), onError: (error) => toastApiError(error, failure) });
  };
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={pending}>
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CloseAction({ batchId }: { batchId: string }) {
  const close = useCloseImport(batchId);
  return (
    <ConfirmAction
      label="Encerrar"
      title="Encerrar a gravação?"
      description="As linhas que ainda não foram gravadas ficarão como 'Não gravada: gravação encerrada'."
      confirmLabel="Encerrar gravação"
      failure={CLOSE_FALLBACK}
      pending={close.isPending}
      run={(options) => close.mutate(undefined, options)}
    />
  );
}

function DiscardAction({ batchId, onDiscarded }: { batchId: string; onDiscarded: (id: string) => void }) {
  const discard = useDiscardImport(batchId);
  return (
    <ConfirmAction
      label="Descartar"
      title="Descartar este lote?"
      description="A planilha enviada e a prévia serão apagadas. Esta ação não pode ser desfeita."
      confirmLabel="Descartar"
      failure={DISCARD_FALLBACK}
      pending={discard.isPending}
      run={(options) =>
        discard.mutate(undefined, {
          ...options,
          onSuccess: () => {
            options.onSuccess();
            onDiscarded(batchId);
          },
        })
      }
    />
  );
}

type RowProps = {
  item: BatchListItem;
  onOpen: (id: string) => void;
  onDiscarded: (id: string) => void;
};

/** "Continuar" abre o lote no passo da gravação; quem retoma o laço é o botão desse passo. */
function RowActions({ item, onOpen, onDiscarded }: RowProps) {
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" onClick={() => onOpen(item.id)}>
        Abrir
      </Button>
      {item.hasErrorReport && <ReportButton batchId={item.id} />}
      {item.canContinue && (
        <Button size="sm" onClick={() => onOpen(item.id)}>
          Continuar
        </Button>
      )}
      {item.canClose && <CloseAction batchId={item.id} />}
      {item.canDiscard && <DiscardAction batchId={item.id} onDiscarded={onDiscarded} />}
    </div>
  );
}

/** Lote em prévia ainda não gravou nada: sem andamento, as contagens ficam em branco. */
function BatchRow(props: RowProps) {
  const { item } = props;
  const { progress } = item;
  return (
    <TableRow>
      <TableCell className="font-medium">{item.fileName}</TableCell>
      <TableCell>{item.createdBy.name ?? NONE}</TableCell>
      <TableCell>{formatAuditDateTime(item.createdAt)}</TableCell>
      <TableCell>{SITUATION_LABEL[item.situation]}</TableCell>
      <TableCell>{progress ? progress.created : NONE}</TableCell>
      <TableCell>{progress ? progress.updated : NONE}</TableCell>
      <TableCell>{progress ? notEnteredCount(item) : NONE}</TableCell>
      <TableCell>
        <RowActions {...props} />
      </TableCell>
    </TableRow>
  );
}

const HEADERS = ['Arquivo', 'Enviado por', 'Data', 'Situação', 'Criadas', 'Atualizadas', 'Não entraram', 'Ações'];

function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Anterior
      </Button>
      <span className="text-sm text-muted-foreground">{`Página ${page} de ${pages}`}</span>
      <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Próxima
      </Button>
    </div>
  );
}

type Props = {
  onOpen: (id: string) => void;
  /** Um lote da lista foi descartado (a página tira o lote da URL se era o aberto). */
  onDiscarded: (id: string) => void;
};

/** Lotes já enviados (spec E1), mais recentes primeiro, 20 por página. */
export function BatchList({ onOpen, onDiscarded }: Props) {
  const [page, setPage] = useState(1);
  const list = useImportBatches(page);
  const lastPage = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  // Descartar o único lote da última página a deixa vazia: volta à última página que ainda existe.
  // Sem a lista, o total é desconhecido: não reposiciona (lastPage 1 mandaria a página aberta de volta à primeira).
  const past = Boolean(list.data) && page > lastPage;
  if (past) setPage(lastPage);
  if (list.isError) return <QueryErrorFallback error={list.error} onRetry={list.refetch} />;
  if (!list.data || past) return <Skeleton className="h-24 w-full" />;
  const { items } = list.data;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nenhum lote enviado ainda.</p>;
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            {HEADERS.map((header) => (
              <TableHead key={header}>{header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <BatchRow key={item.id} item={item} onOpen={onOpen} onDiscarded={onDiscarded} />
          ))}
        </TableBody>
      </Table>
      <Pager page={page} pages={lastPage} onChange={setPage} />
    </div>
  );
}
