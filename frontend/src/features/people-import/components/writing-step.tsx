import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { extractApiError } from '@/lib/api-error';
import { useCloseImport } from '../api';
import { processedCount } from '../progress';
import type { BatchSummary } from '../schemas';
import { useWriteLoop } from '../use-write-loop';

type Props = {
  batch: BatchSummary;
  isAdmin: boolean;
  /** Começa a gravar ao montar (logo depois da confirmação). Ao abrir um lote já iniciado, fica em `false`. */
  autoStart?: boolean;
};

const INTERRUPTED_TEXT = 'A gravação parou antes de terminar. As linhas já gravadas continuam gravadas.';
const NOT_CONFIRMER_TEXT = 'Só quem confirmou a importação pode continuar a gravação.';

function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label="Andamento da gravação"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Só o ADMIN encerra; as linhas ainda não gravadas viram "Não gravada" e entram no relatório. */
function CloseWriting({ batchId }: { batchId: string }) {
  const [open, setOpen] = useState(false);
  const close = useCloseImport(batchId);
  const confirm = async () => {
    try {
      await close.mutateAsync();
      setOpen(false);
    } catch (error) {
      const { title, message } = await extractApiError(error);
      toast.error(title, { description: message });
    }
  };
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Encerrar gravação
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !close.isPending && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Encerrar gravação</AlertDialogTitle>
            <AlertDialogDescription>
              As linhas que ainda não foram gravadas ficarão como &apos;Não gravada: gravação encerrada&apos;.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={close.isPending}>Cancelar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirm()} disabled={close.isPending}>
              Encerrar gravação
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type NoticeProps = {
  error: string | null;
  interrupted: boolean;
  canContinue: boolean;
};

/** O aviso da API (ex.: permissão perdida) e, parado, o que aconteceu com as linhas já gravadas. */
function Notice({ error, interrupted, canContinue }: NoticeProps) {
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {interrupted && (
        <p className="text-sm text-muted-foreground">
          {canContinue ? INTERRUPTED_TEXT : `${INTERRUPTED_TEXT} ${NOT_CONFIRMER_TEXT}`}
        </p>
      )}
    </>
  );
}

type ActionsProps = { running: boolean; summary: BatchSummary; isAdmin: boolean; onContinue: () => void };

/** Continuar é de quem confirmou (`canContinue`); encerrar é do ADMIN (`canClose`). */
function Actions({ running, summary, isAdmin, onContinue }: ActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {!running && summary.canContinue && <Button onClick={onContinue}>Continuar gravação</Button>}
      {isAdmin && summary.canClose && <CloseWriting batchId={summary.id} />}
    </div>
  );
}

/**
 * Passo 4 durante a gravação (E6): "Gravando X de Y" enquanto o laço pede blocos; parado, "Gravação interrompida"
 * com o aviso da API (ex.: permissão perdida). Continuar é de quem confirmou; encerrar é do ADMIN.
 */
export function WritingStep({ batch, isAdmin, autoStart = false }: Props) {
  const { running, summary, error, start } = useWriteLoop(batch);
  // Só uma vez por montagem: um laço parado (ex.: 403) não pode recomeçar sozinho se `start` mudar de identidade.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    start();
  }, [autoStart, start]);

  const { progress } = summary;
  const done = progress ? processedCount(progress) : 0;
  const total = progress ? progress.toWrite : 0;
  const interrupted = !running && (error !== null || summary.situation === 'INTERRUPTED');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{interrupted ? 'Gravação interrompida' : `Gravando ${done} de ${total}`}</CardTitle>
        <CardDescription>{summary.fileName}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ProgressBar done={done} total={total} />
        <Notice error={error} interrupted={interrupted} canContinue={summary.canContinue} />
        <Actions running={running} summary={summary} isAdmin={isAdmin} onContinue={start} />
      </CardContent>
    </Card>
  );
}
