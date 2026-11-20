import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { readApiErrorBody } from '@/lib/api-error';
import { useAuthStore } from '@/stores/auth.store';
import { useImportBatch } from '../api';
import type { BatchSummary } from '../schemas';
import { BatchList } from './batch-list';
import { FileStep } from './file-step';
import { MappingStep } from './mapping-step';
import { PreviewStep } from './preview-step';
import { ResultStep } from './result-step';
import { StepsHeader, type ImportStep } from './steps-header';
import { WritingStep } from './writing-step';

const BATCH_NOT_FOUND = 'people_import.batch_not_found';
const NOT_FOUND_FALLBACK = 'Lote não encontrado.';

type Stage = 'file' | 'mapping' | 'preview' | 'writing' | 'result';

const STEP_OF: Record<Stage, ImportStep> = { file: 1, mapping: 2, preview: 3, writing: 4, result: 4 };

/** Passo que a pessoa escolheu para um lote em prévia (a situação sozinha não diz: recém-enviado, voltar às colunas). */
type Chosen = { batchId: string; stage: 'mapping' | 'preview' };

export type BatchChange = (id: string | undefined, options?: { replace?: boolean }) => void;

/** Passo mostrado pela situação do lote (EX27); em prévia vale o que a pessoa escolheu, se for deste lote. */
function stageOf(batch: BatchSummary | undefined, chosen: Chosen | null): Stage {
  if (!batch) return 'file';
  if (batch.situation === 'WRITING' || batch.situation === 'INTERRUPTED') return 'writing';
  if (batch.situation !== 'PREVIEW') return 'result';
  if (chosen?.batchId === batch.id) return chosen.stage;
  return batch.mappingProblem ? 'mapping' : 'preview';
}

function useImportFlow(batchId: string | undefined, onBatchChange: BatchChange) {
  const [chosen, setChosen] = useState<Chosen | null>(null);
  /** Lote cuja gravação começa sozinha ao montar: só o que acabou de ser confirmado nesta tela. */
  const [autoStartId, setAutoStartId] = useState<string | null>(null);
  // Voltar/Avançar do navegador troca o lote da URL sem passar por `open`: o início automático vale só enquanto
  // o lote recém-confirmado continua aberto, senão o passo remontaria gravando sozinho.
  if (autoStartId !== null && autoStartId !== batchId) setAutoStartId(null);
  const open = useCallback(
    (id: string | undefined, options?: { replace?: boolean }) => {
      setChosen(null);
      setAutoStartId(null);
      if (options) onBatchChange(id, options);
      else onBatchChange(id);
    },
    [onBatchChange],
  );
  return {
    chosen,
    autoStartId,
    open,
    uploaded: (summary: BatchSummary) => {
      setChosen({ batchId: summary.id, stage: 'mapping' });
      onBatchChange(summary.id);
    },
    mapped: (summary: BatchSummary) => setChosen({ batchId: summary.id, stage: 'preview' }),
    backToMapping: () => batchId && setChosen({ batchId, stage: 'mapping' }),
    confirmed: (summary: BatchSummary) => {
      setChosen(null);
      setAutoStartId(summary.id);
    },
  };
}

type Flow = ReturnType<typeof useImportFlow>;

/** Lote que a API não acha mais (descartado, ou prévia com mais de 7 dias): avisa e volta ao passo Arquivo. */
function useVanishedBatch(query: ReturnType<typeof useImportBatch>, onVanished: () => void): void {
  const { isError, error } = query;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!isError || handled.current === error) return;
    handled.current = error;
    void readApiErrorBody(error).then((body) => {
      if (body?.code !== BATCH_NOT_FOUND) return;
      toast.error(body.detail ?? NOT_FOUND_FALLBACK);
      onVanished();
    });
  }, [isError, error, onVanished]);
}

type BodyProps = { batch: BatchSummary | undefined; flow: Flow; isAdmin: boolean; onDropped: () => void };

/** O resumo vem sempre da cache do lote (o passo anterior já a atualizou), nunca de uma cópia guardada aqui. */
function StepBody({ batch, flow, isAdmin, onDropped }: BodyProps) {
  if (!batch) return <FileStep onUploaded={flow.uploaded} />;
  switch (stageOf(batch, flow.chosen)) {
    case 'mapping':
      return <MappingStep key={batch.id} batch={batch} onReady={flow.mapped} onDiscarded={onDropped} />;
    case 'preview':
      return <PreviewStep key={batch.id} batch={batch} onConfirmed={flow.confirmed} onBack={flow.backToMapping} />;
    case 'writing':
      return <WritingStep key={batch.id} batch={batch} isAdmin={isAdmin} autoStart={flow.autoStartId === batch.id} />;
    default:
      return <ResultStep batch={batch} />;
  }
}

type PageBodyProps = BodyProps & { batchId: string | undefined; query: ReturnType<typeof useImportBatch> };

/** Falha ao ler o lote aberto, leitura em andamento ou o passo da vez. */
function PageBody({ batchId, query, ...body }: PageBodyProps) {
  if (batchId && !body.batch && query.isError)
    return <QueryErrorFallback error={query.error} onRetry={query.refetch} />;
  if (batchId && !body.batch) return <Skeleton className="h-40 w-full" />;
  return <StepBody {...body} />;
}

type Props = {
  /** Lote aberto (`?lote=` da URL); sem ele, o passo Arquivo. */
  batchId: string | undefined;
  onBatchChange: BatchChange;
};

/** Página "Importar pessoas" (spec E1): os quatro passos e, abaixo, a lista dos lotes já enviados. */
export function ImportPage({ batchId, onBatchChange }: Props) {
  const isAdmin = useAuthStore((state) => state.user?.role === 'ADMIN');
  const query = useImportBatch(batchId);
  const flow = useImportFlow(batchId, onBatchChange);
  const { open } = flow;
  const vanished = useCallback(() => open(undefined, { replace: true }), [open]);
  useVanishedBatch(query, vanished);

  const batch = batchId ? query.data : undefined;
  const dropBatch = () => open(undefined);
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Importar pessoas</h1>
          <p className="text-sm text-muted-foreground">
            Crie e atualize pessoas a partir de uma planilha. Nada é gravado antes de você confirmar a prévia.
          </p>
        </div>
        {batchId && (
          <Button variant="outline" onClick={dropBatch}>
            Nova importação
          </Button>
        )}
      </header>
      <StepsHeader current={STEP_OF[stageOf(batch, flow.chosen)]} />
      <PageBody batchId={batchId} query={query} batch={batch} flow={flow} isAdmin={isAdmin} onDropped={dropBatch} />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Lotes enviados</h2>
        <BatchList
          onOpen={open}
          onDiscarded={(id) => {
            if (id === batchId) dropBatch();
          }}
        />
      </section>
    </div>
  );
}
