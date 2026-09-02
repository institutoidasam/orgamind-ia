import { useState } from 'react';
import { Loader2, MoreHorizontal, RotateCw, SendHorizontal, XOctagon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { extractApiError } from '@/lib/api-error';
import {
  useBatchSummary,
  useCampaignWaiting,
  useCancelCampaign,
  useRedispatchCampaign,
  useRetryFailed,
  useSendBatch,
} from '@/features/campaigns/api';
import {
  avisoDeQuota,
  capDeHoje,
  fraseDoCanal,
  horaDoReset,
  quotaRestante,
  tamanhoInicialDoLote,
} from '@/features/campaigns/channel-quota';
import { formatarDataHora } from '@/features/campaigns/list-progress';
import { resolveCampaignChannel } from '@/features/campaigns/resolve-channel';
import { frasePuladosEmVoo } from '@/features/campaigns/skipped-already-live';
import { useProviders } from '@/features/whatsapp/api';
import { WaitingMessagesBanner } from '@/features/whatsapp/components/waiting-messages-banner';

/**
 * O CABEÇALHO DE PROGRESSO — a tela que responde "e agora?".
 *
 * Substitui os sete KPIs soltos por cinco números numa linha, a linha do canal
 * (que é onde mora a explicação do "parou em 500") e UMA ação: enviar o próximo
 * lote. Tudo que repete de propósito ou desfaz vai para "Mais ações", atrás de
 * um clique a mais.
 *
 * As três queixas do cliente moram aqui: "quantos já foram", "quantos faltam" e
 * "por que parou".
 */

const TERMINAIS = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const n = (v: number) => v.toLocaleString('pt-BR');
/** Mesmo teto de `sendCampaignBatchSchema` (backend) e do `<Input max=…>` abaixo. */
const MAX_BATCH_SIZE = 5000;

/**
 * Mesmo rótulo do Badge de status da página de detalhe da campanha
 * (`routes/_authenticated/campaigns/$campaignId.tsx` → `STATUS_VARIANT`),
 * para o aviso local não inventar um vocabulário novo para o mesmo fato.
 */
const ROTULO_TERMINAL: Record<string, string> = {
  COMPLETED: 'Esta campanha está concluída',
  FAILED: 'Esta campanha falhou',
  CANCELLED: 'Esta campanha foi cancelada',
};

export function CampaignProgressHeader({
  campaignId,
  timezone,
  defaultInstanceId,
  retryableFailedCount,
  nextRunAt,
  scheduleType,
}: {
  campaignId: string;
  /** `Campaign.timezone` — o fuso em que o horário do reset é escrito. */
  timezone: string;
  defaultInstanceId: string;
  /** CONTATOS distintos com falha retryável — o N de "Reenviar falhas". */
  retryableFailedCount: number;
  /**
   * Achado 3(b) (review final) — `Campaign.nextRunAt`/`scheduleType`, para
   * avisar que "Enviar próximo lote" DESARMA um agendamento de UMA VEZ (o
   * backend faz isso em `sendBatch` sempre que a campanha ainda está em
   * DRAFT — ver `campaigns.service.ts`, `disarmSchedule: !isRecurring`).
   */
  nextRunAt?: string | Date | null;
  scheduleType?: string;
}) {
  // A sondagem do resumo e a `live` que ela recebe são interdependentes: só
  // sabemos se a campanha é terminal DEPOIS de ler `s`, mas `s` só existe
  // depois de chamar `useBatchSummary`. Por isso guardamos o ÚLTIMO status
  // OBSERVADO — não um booleano travado: este MESMO cabeçalho oferece ações
  // (redispatch, "Reenviar falhas") que o backend usa para REABRIR uma
  // campanha terminal para RUNNING quando há gente para enfileirar de novo.
  // Um trinco que só desliga travaria a sondagem para sempre mesmo depois de
  // milhares de mensagens voltarem a sair — os cinco números congelariam
  // enquanto só "aguardando o canal" (que usa `viva`, recalculado à parte)
  // continuaria andando. `sondar` deriva de `statusVisto` DE NOVO a cada
  // render, então destrava sozinho assim que a invalidação pós-ação trouxer
  // o status novo (uma busca garantida mesmo com a sondagem desligada).
  const [statusVisto, setStatusVisto] = useState<string | null>(null);
  const sondar = statusVisto == null || !TERMINAIS.has(statusVisto);
  const summaryQuery = useBatchSummary(campaignId, { live: sondar });
  const s = summaryQuery.data;
  if (s != null && s.status !== statusVisto) {
    setStatusVisto(s.status);
  }
  const viva = s != null && !TERMINAIS.has(s.status);

  const waiting = useCampaignWaiting(campaignId, { live: viva });
  // T15 — `useInstances()` (GET /whatsapp/instances) só cobre EVOLUTION; o
  // canal da campanha vem de `useProviders()` (TODO provedor), com
  // `refetchInterval: 30s` só AQUI — esta é a tela em que a quota precisa
  // continuar avançando enquanto o operador acompanha o disparo. Mesma
  // queryKey do resto do app: não duplica a requisição, só o polling.
  // Fix round 1 (#2, review Opus) — `refetchOnMount: 'always'`: sem isto, o
  // `staleTime: Infinity` do `useProviders()` faria esta tela nascer com a
  // quota que o topbar buscou horas atrás (cache "fresco" pela regra errada
  // — a lista de provedores não muda, mas `sentToday` muda a cada lote).
  const providersQuery = useProviders({
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  });
  const sendBatch = useSendBatch(campaignId);
  const retryFailed = useRetryFailed(campaignId);
  const redispatch = useRedispatchCampaign(campaignId);
  const cancel = useCancelCampaign();

  const resolution = resolveCampaignChannel(providersQuery, defaultInstanceId);
  const canal = resolution.state === 'found' ? resolution.canal : undefined;
  // Fix round 1 (#1, review Opus) — um REFETCH que falha (o poll de 30s
  // acima) não trava mais nada: `resolution.stale` avisa sem desabilitar.
  const canalDesatualizado = resolution.stale === true;
  const canalCarregando = resolution.state === 'loading';
  const canalComErro = resolution.state === 'error';
  // `missing` só é verdade depois que a query RESOLVEU (não durante loading
  // nem error) — ver resolve-channel.ts. Bloqueia de verdade: nenhum lote
  // sairia por um canal que não existe.
  const canalNaoEncontrado = resolution.state === 'missing';
  // Achado 4 (review final) — um relógio só, lido uma vez por render, para
  // "quanto já saiu hoje" (`restaQuota`), "quando reinicia" (`reset`) e o
  // aviso (`aviso`) nunca discordarem um do outro por causa de milissegundos
  // entre chamadas a `new Date()` diferentes.
  const now = new Date();
  const restam = s?.pending ?? 0;
  const restaQuota = canal ? quotaRestante(canal, now) : 0;
  const teto = canal ? capDeHoje(canal) : 0;
  const sugerido = tamanhoInicialDoLote({
    restam,
    quotaRestante: restaQuota,
    capDeHoje: teto,
  });

  // O campo acompanha o resumo — MAS só até o operador tocar nele. Sem o
  // `dirty`, o polling de 5s (useBatchSummary é `live`) recalcula `sugerido`
  // a cada resposta e apaga o que o operador acabou de digitar no meio da
  // digitação, sem ele perceber. `dirty` liga no primeiro toque no campo e só
  // desliga depois de um lote enviado com sucesso — quando faz sentido propor
  // de novo, para o PRÓXIMO lote.
  //
  // Ajustado DURANTE o render, não num useEffect: é o padrão que o próprio
  // React recomenda para "sincronizar estado quando algo muda" (guardar o
  // último valor visto e comparar a cada render). Um useEffect aqui
  // dispararia uma re-renderização em cascata a cada atualização do resumo —
  // que chega a cada 5s com o polling ligado — e ainda pintaria um quadro com
  // o valor velho antes de corrigir. O estado nasce já com o `sugerido` do
  // PRIMEIRO render (inicializador preguiçoso) para não nascer vazio.
  const [size, setSize] = useState(() => (sugerido > 0 ? String(sugerido) : ''));
  const [dirty, setDirty] = useState(false);
  const [sugeridoAnterior, setSugeridoAnterior] = useState(sugerido);
  if (sugerido !== sugeridoAnterior) {
    setSugeridoAnterior(sugerido);
    if (!dirty) {
      setSize(sugerido > 0 ? String(sugerido) : '');
    }
  }

  const [resendOpen, setResendOpen] = useState(false);
  const [resendConfirm, setResendConfirm] = useState('');

  if (!s) return null;

  const pedido = Number.parseInt(size, 10);
  const pedidoValido = Number.isFinite(pedido) && pedido > 0;
  // Minor 9 (review final) — `sendCampaignBatchSchema` (backend) rejeita
  // `size > 5000` com a mensagem crua do zod; o campo já tem `max={5000}` no
  // HTML, mas nada impedia digitar 6000 e mandar o clique mesmo assim. O
  // clamp no cliente evita o erro cru e é o MESMO teto do `<Input max=…>`.
  const aEnviar = pedidoValido ? Math.min(pedido, restam, MAX_BATCH_SIZE) : 0;
  const reset = canal ? horaDoReset(canal.sentTodayResetAt, timezone, now) : null;
  // Minor 7 (review final) — o aviso usava o número DIGITADO (`pedido`), não
  // o CLAMPADO (`aEnviar`): pedir 4800 com 300 restando avisava "4.500 ficam
  // em fila" quando na verdade só 300 saem (o resto nem existe para enviar).
  const aviso = canal
    ? avisoDeQuota({
        tamanho: aEnviar,
        quotaRestante: restaQuota,
        reset,
      })
    : null;
  const emFila = s.inFlight ?? 0;
  const invalidosOuPulados = s.unreachable + s.skipped + s.failed;
  const pct = s.total > 0 ? Math.round((s.sent / s.total) * 100) : 0;
  // ★ Canal DESATIVADO bloqueia; teto esgotado NÃO. A diferença é se o lote
  // sai algum dia: o excedente do teto sai sozinho no reset, mas por um canal
  // desativado não sai nunca — e a saída (ativar em Canais) não está nesta
  // tela. `=== false` e não `!canal.isActive`: `canal` fica `undefined`
  // enquanto o estado é `loading`/`error`/`missing` (ver `resolveCampaignChannel`)
  // — esses três JÁ bloqueiam por conta própria (ver `podeEnviar` abaixo, e os
  // avisos correspondentes mais adiante), então `canalInativo` só precisa
  // decidir o caso em que o canal FOI encontrado e está desativado.
  const canalInativo = canal?.isActive === false;
  const campanhaTerminal = TERMINAIS.has(s.status);
  // Achado 3(b) — só um agendamento de UMA VEZ (`ONCE_AT`) é desarmado pelo
  // lote manual (`disarmSchedule: !isRecurring` no backend); DAILY_AT/WEEKLY/
  // INTERVAL são recorrentes e continuam armados depois do lote — avisar ali
  // seria alarme falso. `nextRunAt` tem de existir: sem ele não há agendamento
  // nenhum para cancelar.
  const agendamentoUnico = scheduleType === 'ONCE_AT' && nextRunAt != null;
  const dataDoAgendamento = agendamentoUnico
    ? formatarDataHora(nextRunAt!, timezone)
    : null;
  const podeEnviar =
    restam > 0 &&
    !campanhaTerminal &&
    aEnviar > 0 &&
    !canalInativo &&
    !canalNaoEncontrado &&
    !canalCarregando &&
    !canalComErro;

  return (
    <div
      data-testid="campaign-progress-header"
      className="space-y-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          Público <strong>{n(s.total)}</strong>
        </span>
        <span>
          Já receberam <strong>{n(s.sent)}</strong> ({pct}%)
        </span>
        <span title="Mensagens a caminho: na fila, saindo, ou esperando o canal reconectar.">
          Em fila <strong>{n(emFila)}</strong>
        </span>
        <span>
          Restam <strong>{n(restam)}</strong>
        </span>
        <span
          title={`${n(s.unreachable)} desligaram marketing no WhatsApp · ${n(s.skipped)} pulados pelo gate de consentimento · ${n(s.failed)} tentativa(s) com falha`}
        >
          Inválidos/pulados <strong>{n(invalidosOuPulados)}</strong>
        </span>
      </div>

      {canal && (
        <p
          data-testid="campaign-channel-line"
          className="text-xs text-muted-foreground"
        >
          {fraseDoCanal({ nome: canal.name, canal, timezone, now })}
          {/* Fix round 1 (#1, review Opus) — um REFETCH que falhou não bloqueia
              o envio (o canal em cache continua "found"), mas o operador
              merece saber que o número pode não ser o mais recente. */}
          {canalDesatualizado && (
            <span data-testid="channel-stale-hint">
              {' '}
              — não foi possível atualizar o teto — usando o último valor
            </span>
          )}
        </p>
      )}

      {/* O aviso do canal caído mora AQUI dentro: é a explicação do "Em fila"
          que não anda, e antes ele vivia solto no meio da página. */}
      {waiting.data && waiting.data.count > 0 && (
        <WaitingMessagesBanner
          waitingCount={waiting.data.count}
          instanceNames={waiting.data.instanceNames}
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="next-batch-size"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Enviar próximo lote de
          </label>
          <Input
            id="next-batch-size"
            data-testid="next-batch-size"
            type="number"
            min={1}
            max={5000}
            className="w-28"
            value={size}
            disabled={restam === 0 || campanhaTerminal}
            onChange={(e) => {
              setSize(e.target.value);
              setDirty(true);
            }}
          />
        </div>

        <Button
          data-testid="next-batch-button"
          disabled={!podeEnviar || sendBatch.isPending}
          onClick={async () => {
            try {
              const r = await sendBatch.mutateAsync(aEnviar);
              // O lote saiu — a próxima proposta (para o PRÓXIMO lote) pode
              // voltar a seguir o resumo automaticamente.
              setDirty(false);
              const sobra = r.summary?.pending ?? r.remaining;
              const restanteDescricao =
                restaQuota > 0
                  ? `Restam ${n(sobra)} nesta campanha.`
                  : `Ficam em fila e saem quando o teto do canal reiniciar. Restam ${n(sobra)}.`;
              // Achado 1 (Importante, re-review Opus) — com o lote anterior
              // ainda drenando, o backend devolve `queued: 0` e
              // `skippedAlreadyLive > 0` (todo mundo já tem mensagem viva
              // desta campanha a caminho). Sem isto, o toast ficava mudo
              // sobre o PORQUÊ — "0 mensagens enfileiradas" lê como "travou",
              // e a reação natural é clicar de novo. Mesma frase do toast de
              // "Disparar de novo para TODOS" (`frasePuladosEmVoo`) — um só
              // lugar explica o mesmo fato nos dois toasts.
              const emVoo = frasePuladosEmVoo(r.skippedAlreadyLive);
              toast.success(`Lote ${r.seq}: ${n(r.queued)} mensagens enfileiradas`, {
                description: emVoo ? `${emVoo} ${restanteDescricao}` : restanteDescricao,
              });
            } catch (err) {
              const { title, message } = await extractApiError(err);
              toast.error(title, { description: message });
            }
          }}
        >
          {sendBatch.isPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <SendHorizontal className="mr-1 h-4 w-4" />
          )}
          Enviar próximo lote
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-testid="more-actions-trigger">
              <MoreHorizontal className="mr-1 h-4 w-4" />
              Mais ações
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              data-testid="action-retry-failed"
              disabled={retryableFailedCount === 0}
              onSelect={async () => {
                try {
                  const r = await retryFailed.mutateAsync();
                  toast.success(`${n(r.queued)} mensagens reenfileiradas`);
                } catch (err) {
                  const { title, message } = await extractApiError(err);
                  toast.error(title, { description: message });
                }
              }}
            >
              <RotateCw className="mr-2 h-4 w-4" />
              Reenviar falhas ({n(retryableFailedCount)})
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="action-resend-all"
              disabled={s.sent === 0}
              onSelect={() => {
                setResendConfirm('');
                setResendOpen(true);
              }}
            >
              <SendHorizontal className="mr-2 h-4 w-4" />
              Disparar de novo para TODOS
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="action-cancel"
              disabled={campanhaTerminal}
              onSelect={async () => {
                try {
                  await cancel.mutateAsync(campaignId);
                  toast.success('Cancelamento solicitado');
                } catch (err) {
                  const { title, message } = await extractApiError(err);
                  toast.error(title, { description: message });
                }
              }}
            >
              <XOctagon className="mr-2 h-4 w-4" />
              Cancelar campanha
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {restam === 0 && (
          <p className="text-xs text-muted-foreground">
            Todo mundo já recebeu — não há mais ninguém para enviar nesta campanha.
          </p>
        )}
        {restam > 0 && canalCarregando && (
          <p
            data-testid="channel-loading-notice"
            className="w-full text-xs text-muted-foreground"
          >
            Carregando o teto do canal…
          </p>
        )}
        {restam > 0 && canalComErro && (
          <p
            data-testid="channel-error-notice"
            className="w-full text-xs text-destructive"
          >
            Não deu para consultar os canais — tente de novo
          </p>
        )}
        {restam > 0 && canalInativo && (
          <p
            data-testid="channel-inactive-notice"
            className="w-full text-xs text-destructive"
          >
            O canal desta campanha está desativado — ative-o em Canais para
            continuar enviando.
          </p>
        )}
        {restam > 0 && canalNaoEncontrado && (
          <p
            data-testid="channel-missing-notice"
            className="w-full text-xs text-destructive"
          >
            O canal desta campanha não foi encontrado — verifique em Canais.
          </p>
        )}
        {restam > 0 && !canalInativo && campanhaTerminal && (
          <p
            data-testid="campaign-terminal-notice"
            className="w-full text-xs text-muted-foreground"
          >
            {ROTULO_TERMINAL[s.status] ?? 'Esta campanha está encerrada'} — para
            continuar, crie uma campanha nova.
          </p>
        )}
        {/* Achado 2 (Minor, re-review Opus) — `aEnviar` clampa `pedido`
            (min com `Restam`/`MAX_BATCH_SIZE`) em silêncio: sem este aviso, o
            operador digita 100 com 40 restando, o campo continua mostrando
            "100", e só descobre que 40 saíram lendo o toast DEPOIS de
            clicar. */}
        {pedidoValido && pedido > aEnviar && (
          <p
            data-testid="batch-request-reduced-notice"
            className="w-full text-xs text-muted-foreground"
          >
            Você pediu {n(pedido)}, mas só {n(aEnviar)} podem sair agora.
          </p>
        )}
        {aviso && (
          <p data-testid="quota-notice" className="w-full text-xs text-amber-600">
            {aviso}
          </p>
        )}
        {agendamentoUnico && dataDoAgendamento && (
          <p
            data-testid="schedule-cancel-warning"
            className="w-full text-xs text-amber-600"
          >
            Esta campanha está agendada para {dataDoAgendamento} — enviar um
            lote agora cancela o agendamento.
          </p>
        )}
      </div>

      {/* A ÚNICA AÇÃO QUE REPETE DE PROPÓSITO. Digitar o número obriga a LER o
          número — um botão "confirmar" sozinho é clicado sem leitura. */}
      <AlertDialog open={resendOpen} onOpenChange={setResendOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disparar de novo para TODOS?</AlertDialogTitle>
            <AlertDialogDescription data-testid="resend-all-confirm-text">
              {n(s.sent)} pessoas receberiam esta mensagem pela 2ª vez. Para
              confirmar, digite {n(s.sent)} abaixo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            data-testid="resend-all-confirm-input"
            aria-label="Digite o número para confirmar"
            value={resendConfirm}
            onChange={(e) => setResendConfirm(e.target.value)}
            placeholder={n(s.sent)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              data-testid="resend-all-confirm-button"
              // Aceita tanto o número formatado ("1.500", igual ao texto acima)
              // quanto os dígitos crus ("1500") — o operador não precisa acertar
              // o ponto de milhar para confirmar, só o NÚMERO certo.
              disabled={resendConfirm.replace(/[.\s]/g, '') !== String(s.sent)}
              onClick={async () => {
                try {
                  // Achado 1 (crítico, review final) — sem o corpo, o backend
                  // caía no default `resendToAll: false` e recortava para
                  // `unreached` (ninguém, quando todos já receberam): esta é
                  // a ÚNICA ação da tela que repete de propósito, e "de novo
                  // para TODOS" tem de mandar `resendToAll: true`.
                  const r = await redispatch.mutateAsync({ resendToAll: true });
                  // Mesma frase de batch-panel.tsx e da página de detalhe da
                  // campanha — o "por que a caminho" de quem foi pulado por já
                  // ter mensagem viva não pode virar duas explicações
                  // diferentes para o mesmo fato.
                  const emVoo = frasePuladosEmVoo(r.skippedAlreadyLive);
                  toast.success(
                    r.queued === 0 && emVoo
                      ? 'Nada novo foi disparado'
                      : `${n(r.queued)} mensagens disparadas`,
                    emVoo ? { description: emVoo } : undefined,
                  );
                } catch (err) {
                  const { title, message } = await extractApiError(err);
                  toast.error(title, { description: message });
                }
              }}
            >
              Disparar de novo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
