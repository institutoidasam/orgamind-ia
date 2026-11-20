import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { extractApiError } from '@/lib/api-error';
import { downloadErrors } from '../api';
import { SITUATION_LABEL } from '../labels';
import { notEnteredCount } from '../progress';
import type { BatchSummary } from '../schemas';

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function ErrorReportButton({ batchId }: { batchId: string }) {
  const [pending, setPending] = useState(false);
  const download = async () => {
    setPending(true);
    try {
      await downloadErrors(batchId);
    } catch (error) {
      const { title, message } = await extractApiError(error);
      toast.error(title, { description: message });
    } finally {
      setPending(false);
    }
  };
  return (
    <Button variant="outline" onClick={() => void download()} disabled={pending}>
      Baixar relatório de erros
    </Button>
  );
}

/** "Sem alteração": as da prévia (`counts.UNCHANGED`, não vão à gravação) mais as que a gravação achou iguais. */
function unchangedCount({ counts, progress }: Pick<BatchSummary, 'counts' | 'progress'>): number {
  return (counts?.UNCHANGED ?? 0) + (progress?.unchanged ?? 0);
}

/** Passo 4 depois da gravação (E1): quantas foram criadas, atualizadas e quantas falharam, com o relatório de erros. */
export function ResultStep({ batch }: { batch: BatchSummary }) {
  const progress = batch.progress;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{SITUATION_LABEL[batch.situation]}</CardTitle>
        <CardDescription>{batch.fileName}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Count label="Criadas" value={progress?.created ?? 0} />
          <Count label="Atualizadas" value={progress?.updated ?? 0} />
          <Count label="Sem alteração" value={unchangedCount(batch)} />
          <Count label="Não entraram" value={notEnteredCount(batch)} />
        </dl>
        {progress && progress.phoneTaken > 0 && (
          <p className="text-sm">{`Falhas por telefone já cadastrado: ${progress.phoneTaken}`}</p>
        )}
        {batch.hasErrorReport && <ErrorReportButton batchId={batch.id} />}
      </CardContent>
    </Card>
  );
}
