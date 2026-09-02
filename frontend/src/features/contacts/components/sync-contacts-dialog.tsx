import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
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
import { extractApiError } from '@/lib/api-error';
import { useContacts, useSyncContacts, useSyncProgress } from '../api';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Espelha `GOZAP_CHECK_RATE_PER_MIN` (env do backend, padrão 40). */
export const GOZAP_CHECK_RATE_PER_MIN = 40;

/**
 * Quantas HORAS a validação leva, no ritmo lento. Arredonda para cima e nunca
 * devolve "0h" com trabalho pendente: dizer "≈ 0h" para 300 contatos (que
 * levam uns 8 minutos) faria o operador achar que é instantâneo e desistir no
 * meio.
 */
export function estimateHours(
  count: number,
  ratePerMin: number = GOZAP_CHECK_RATE_PER_MIN,
): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.ceil(count / ratePerMin / 60));
}

/** Uma rodada disparada: o marco (`since`) e o denominador CAPTURADO da
 * resposta do POST — nunca recalculado a partir da lista ao vivo. */
type SyncRun = { since: string; total: number };

export function SyncContactsDialog({ open, onOpenChange }: Props) {
  const sync = useSyncContacts();
  const [run, setRun] = useState<SyncRun | null>(null);

  // O N do BOTÃO sai da PRÓPRIA lista (`?validity=unvalidated&pageSize=1`): um
  // endpoint de contagem separado seria um segundo número, de outra fonte,
  // capaz de divergir do que a tela de contatos mostra.
  //
  // Achado 3 (revisão) — `enabled: open`: o diálogo fica SEMPRE montado (o
  // `open` do Radix só o esconde visualmente), então sem este freio esta
  // consulta disparava a CADA carregamento da tela de contatos, mesmo com o
  // diálogo fechado — o mesmo cuidado que `useSyncProgress`, abaixo, já tinha.
  const { data: pending } = useContacts(
    { page: 1, pageSize: 1, validity: 'unvalidated' },
    { enabled: open },
  );
  const pendingTotal = pending?.total ?? 0;

  // A BARRA usa `run.total` — o denominador que o POST devolveu, capturado
  // uma vez no clique — não `pendingTotal`: a lista de não validados encolhe
  // DURANTE a própria validação (cada contato checado sai dela), e usar esse
  // número mudando embaixo do pé faria "X de Y" ultrapassar 100% ou nunca
  // fechar.
  const { data: progress } = useSyncProgress({
    since: run?.since ?? null,
    total: run?.total ?? 0,
    // Só consulta com o diálogo ABERTO e uma rodada em curso — o diálogo fica
    // sempre montado (o `open` do Radix só o esconde), então sem este freio o
    // polling de 5s nunca pararia, mesmo com a janela fechada.
    enabled: open && run !== null,
  });

  const onStart = async () => {
    try {
      const r = await sync.mutateAsync('unvalidated');
      setRun({ since: r.startedAt, total: r.total });
      toast.success(`${r.enqueued} lote(s) enfileirado(s)`, {
        description:
          'A validação é lenta de propósito. Pode fechar esta janela: ela continua rodando.',
      });
    } catch (err) {
      const { title, message } = await extractApiError(err);
      toast.error(title, { description: message });
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Validar números no WhatsApp</AlertDialogTitle>
          <AlertDialogDescription>
            Consulta, um por um, se cada número não validado existe no WhatsApp,
            usando o canal padrão. O resultado aparece na coluna "WA" e no
            filtro "Validação".
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* ★ O RISCO É DO CLIENTE, então está na tela — não num comentário de
            código. O número deste cliente já foi bloqueado antes. */}
        <div
          data-testid="sync-risk-warning"
          className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Consultas de existência em massa por número não-oficial são um sinal
            conhecido de bloqueio. Ritmo lento: ~{GOZAP_CHECK_RATE_PER_MIN}/min,
            só em horário comercial. Estimativa: {pendingTotal.toLocaleString('pt-BR')}{' '}
            contatos ≈ {estimateHours(pendingTotal)}h.
          </span>
        </div>

        {/* ★ Crítico 1 (revisão) — o ritmo lento roda num ÚNICO worker e pode
            facilmente ultrapassar a janela de envio de 12h. Isto é
            INOFENSIVO (nada se perde), mas só se o operador SOUBER disso —
            senão vê a validação "parar" no meio e acha que quebrou. */}
        <p
          data-testid="sync-window-warning"
          className="text-xs text-muted-foreground"
        >
          Uma validação grande pode não terminar dentro da janela de envio de
          12h (worker único, ritmo lento de propósito). Os lotes que ainda
          estiverem na fila quando a janela fechar falham de forma limpa —
          nada se perde — e basta clicar em "Validar não validados" de novo no
          dia seguinte para continuar de onde parou.
        </p>

        {run && progress && (
          <div className="space-y-1">
            <div
              role="progressbar"
              aria-label="Progresso da validação"
              aria-valuenow={progress.checked}
              aria-valuemin={0}
              aria-valuemax={run.total}
              className="h-2 w-full overflow-hidden rounded bg-muted"
            >
              <div
                className="h-full bg-emerald-600"
                style={{
                  width: `${run.total > 0 ? Math.min(100, (progress.checked / run.total) * 100) : 0}%`,
                }}
              />
            </div>
            <p
              data-testid="sync-progress-label"
              className="text-xs text-muted-foreground"
            >
              {progress.checked.toLocaleString('pt-BR')} de{' '}
              {run.total.toLocaleString('pt-BR')} verificados ·{' '}
              {progress.unvalidated.toLocaleString('pt-BR')} ainda não validados
            </p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={sync.isPending}>Fechar</AlertDialogCancel>
          <AlertDialogAction
            disabled={sync.isPending || pendingTotal === 0}
            onClick={(e) => {
              e.preventDefault();
              void onStart();
            }}
          >
            {sync.isPending
              ? 'Enfileirando…'
              : `Validar não validados (${pendingTotal.toLocaleString('pt-BR')})`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
