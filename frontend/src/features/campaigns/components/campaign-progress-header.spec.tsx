import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BatchSummary } from '../schemas';

const sendBatchMutate = vi.fn();
const retryMutate = vi.fn();
const redispatchMutate = vi.fn();
const cancelMutate = vi.fn();
// `.mock.calls` grava os argumentos REAIS que o componente passar, mesmo sem
// a implementação declarar parâmetros — é a única forma de inspecionar com
// QUE `live` o hook foi chamado a cada render, para verificar que a sondagem
// liga/desliga quando o status observado muda.
const useBatchSummaryMock = vi.fn(() => ({
  data: state.summary,
}));

// T15 — o canal da campanha agora vem de `useProviders()` (GET
// /whatsapp/providers, TODO provedor), não mais de `useInstances()`
// (EVOLUTION-only). `channels: undefined` simula "ainda carregando"
// (isPending); `providersError: true` simula uma falha de rede na query.
const useProvidersMock = vi.fn(() => ({
  data:
    state.channels === undefined
      ? undefined
      : {
          providers: [
            { provider: 'GOZAP', traits: {}, capabilities: [], channels: state.channels },
          ],
        },
  isPending: state.channels === undefined && !state.providersError,
  isError: state.providersError,
}));

const state: {
  summary: BatchSummary | undefined;
  waiting: { count: number; instanceNames: string[] } | undefined;
  /** `undefined` simula "useProviders ainda carregando" (isPending). */
  channels: unknown[] | undefined;
  providersError: boolean;
} = { summary: undefined, waiting: undefined, channels: [], providersError: false };

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/api-error', () => ({
  extractApiError: vi.fn(async () => ({ title: 'Erro', message: 'x' })),
}));
vi.mock('@/features/campaigns/api', () => ({
  // Referência PREGUIÇOSA (não `useBatchSummary: useBatchSummaryMock`
  // direto): o factory do vi.mock é hoisted para o topo do arquivo, antes de
  // `const useBatchSummaryMock = ...` existir — uma referência direta lançava
  // "Cannot access 'useBatchSummaryMock' before initialization".
  useBatchSummary: (...args: Parameters<typeof useBatchSummaryMock>) =>
    useBatchSummaryMock(...args),
  useCampaignWaiting: () => ({ data: state.waiting }),
  useSendBatch: () => ({ mutateAsync: sendBatchMutate, isPending: false }),
  useRetryFailed: () => ({ mutateAsync: retryMutate, isPending: false }),
  useRedispatchCampaign: () => ({ mutateAsync: redispatchMutate, isPending: false }),
  useCancelCampaign: () => ({ mutateAsync: cancelMutate, isPending: false }),
}));
vi.mock('@/features/whatsapp/api', () => ({
  useProviders: (...args: Parameters<typeof useProvidersMock>) =>
    useProvidersMock(...args),
}));
vi.mock('@/features/whatsapp/components/waiting-messages-banner', () => ({
  WaitingMessagesBanner: ({ waitingCount }: { waitingCount: number }) =>
    waitingCount > 0 ? <div data-testid="waiting-banner">{waitingCount}</div> : null,
}));

import { CampaignProgressHeader } from './campaign-progress-header';

const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  total: 13400,
  sent: 500,
  pending: 12900,
  inFlight: 0,
  waiting: 0,
  unreachable: 120,
  failed: 0,
  skipped: 0,
  isMarketing: true,
  status: 'RUNNING',
  ...over,
});

// T15 — GOZAP é o cenário real de produção (o provedor que
// `useInstances()`/EVOLUTION-only nunca via). `provider` não importa para
// `resolveCampaignChannel` (procura em TODO grupo), mas fica aqui para
// documentar QUAL provedor este fixture representa.
const CANAL = {
  id: 'inst1',
  name: 'robo',
  provider: 'GOZAP' as const,
  isActive: true,
  dailySendLimit: 500,
  sentToday: 120,
  sentTodayResetAt: '2026-08-24T13:00:00.000Z',
};

function montar(
  over: Partial<BatchSummary> = {},
  agendamento: { nextRunAt?: string | null; scheduleType?: string } = {},
) {
  state.summary = summary(over);
  return render(
    <CampaignProgressHeader
      campaignId="camp1"
      timezone="America/Manaus"
      defaultInstanceId="inst1"
      retryableFailedCount={0}
      {...agendamento}
    />,
  );
}

beforeEach(() => {
  // Achado 4 (review final) — `quotaRestante`/`horaDoReset`/`fraseDoCanal`
  // agora tratam um `sentTodayResetAt` com mais de 24h como "reset já
  // passado". O fixture `CANAL` usa a data FIXA 2026-08-24T13:00Z — sem
  // travar o relógio, os testes de "teto de hoje esgotado"/"reinicia às
  // 09:00" ficariam reféns de QUANDO rodam de verdade. Só `Date` é
  // congelado — `setTimeout` real segue de pé para o `userEvent`.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-24T15:00:00.000Z'));
  sendBatchMutate.mockReset();
  sendBatchMutate.mockResolvedValue({
    batchId: 'b1',
    seq: 1,
    requested: 380,
    queued: 380,
    skipped: 0,
    remaining: 12520,
  });
  retryMutate.mockReset();
  retryMutate.mockResolvedValue({ queued: 0 });
  redispatchMutate.mockReset();
  redispatchMutate.mockResolvedValue({ queued: 500 });
  cancelMutate.mockReset();
  useBatchSummaryMock.mockClear();
  useProvidersMock.mockClear();
  state.waiting = { count: 0, instanceNames: [] };
  state.channels = [CANAL];
  state.providersError = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CampaignProgressHeader', () => {
  it('mostra as cinco métricas em português', () => {
    montar();
    const cab = screen.getByTestId('campaign-progress-header');
    expect(cab.textContent).toContain('Público 13.400');
    expect(cab.textContent).toContain('Já receberam 500');
    expect(cab.textContent).toContain('Em fila 0');
    expect(cab.textContent).toContain('Restam 12.900');
    expect(cab.textContent).toContain('Inválidos/pulados 120');
  });

  /**
   * `inFlight` é OPCIONAL no tipo do fio (uma API mais antiga não o devolve).
   * `undefined` tem de virar "0", nunca "NaN" nem um campo em branco.
   */
  it('mostra "Em fila 0" quando a API não manda inFlight', () => {
    montar({ inFlight: undefined, waiting: undefined });
    expect(
      screen.getByTestId('campaign-progress-header').textContent,
    ).toContain('Em fila 0');
    expect(
      screen.getByTestId('campaign-progress-header').textContent,
    ).not.toContain('NaN');
  });

  /**
   * `failed` conta TENTATIVAS (Messages FAILED), não contatos distintos — uma
   * pessoa com 3 tentativas nesta campanha soma 3. O texto que resume isto
   * precisa dizer "tentativa(s)", não implicar "3 pessoas".
   */
  it('o título de "Inválidos/pulados" descreve failed como tentativas, não contatos', () => {
    montar({ failed: 3 });
    expect(screen.getByTitle(/tentativa\(s\) com falha/)).toBeInTheDocument();
  });

  it('mostra a linha do canal com o teto e o reset no fuso da campanha', () => {
    montar();
    expect(screen.getByTestId('campaign-channel-line').textContent).toBe(
      'Canal robo: enviou 120 de 500 hoje · teto reinicia às 09:00',
    );
  });

  /**
   * A.3/A.5 — o número proposto é min(quota restante, Restam). Ele é a
   * diferença entre "enviar o que o canal aguenta hoje" e "enfileirar 13.000
   * de madrugada".
   */
  it('propõe min(quota restante, Restam) no campo do próximo lote', () => {
    montar();
    expect(screen.getByTestId('next-batch-size')).toHaveValue(380);
  });

  it('propõe o que resta quando o público é menor que a quota', () => {
    montar({ pending: 40 });
    expect(screen.getByTestId('next-batch-size')).toHaveValue(40);
  });

  /**
   * O resumo sonda a cada 5s (`useBatchSummary(..., { live: true })`). Sem
   * proteção, a resposta de uma sondagem no meio ou depois da digitação apaga
   * o número que o operador acabou de escrever — ele nem percebe e manda um
   * lote do tamanho errado.
   */
  it('mantém o valor digitado pelo operador quando o resumo atualiza sozinho (polling)', async () => {
    const user = userEvent.setup();
    const { rerender } = montar(); // sugerido inicial: 380
    const campo = screen.getByTestId('next-batch-size');
    await user.clear(campo);
    await user.type(campo, '2000');
    expect(campo).toHaveValue(2000);

    // Simula o polling trazendo um resumo novo (outro lote drenou; Restam caiu).
    state.summary = summary({ pending: 40 });
    rerender(
      <CampaignProgressHeader
        campaignId="camp1"
        timezone="America/Manaus"
        defaultInstanceId="inst1"
        retryableFailedCount={0}
      />,
    );

    expect(screen.getByTestId('next-batch-size')).toHaveValue(2000);
  });

  /**
   * Este MESMO cabeçalho oferece ações (redispatch, "Reenviar falhas") que o
   * backend usa para reabrir uma campanha terminal para RUNNING. Um trinco
   * que só desliga a sondagem travaria os cinco números congelados mesmo
   * depois de milhares de mensagens voltarem a sair — a sondagem tem de
   * voltar a ligar quando o status observado deixa de ser terminal, e
   * desligar de novo se ele voltar a ser.
   */
  it('volta a sondar quando o status observado deixa de ser terminal, e desliga de novo se voltar a ser', () => {
    const ultimaChamada = () =>
      useBatchSummaryMock.mock.calls[useBatchSummaryMock.mock.calls.length - 1];

    const { rerender } = montar({ status: 'COMPLETED' });
    expect(ultimaChamada()?.[1]).toEqual({ live: false });

    // O redispatch/retry reabriu a campanha (RUNNING) — a invalidação pós-ação
    // garante uma busca nova; o rerender simula essa busca chegando.
    state.summary = summary({ status: 'RUNNING' });
    rerender(
      <CampaignProgressHeader
        campaignId="camp1"
        timezone="America/Manaus"
        defaultInstanceId="inst1"
        retryableFailedCount={0}
      />,
    );
    expect(ultimaChamada()?.[1]).toEqual({ live: true });

    // E desliga de novo se o status observado voltar a ser terminal.
    state.summary = summary({ status: 'COMPLETED' });
    rerender(
      <CampaignProgressHeader
        campaignId="camp1"
        timezone="America/Manaus"
        defaultInstanceId="inst1"
        retryableFailedCount={0}
      />,
    );
    expect(ultimaChamada()?.[1]).toEqual({ live: false });
  });

  it('desabilita o envio e explica quando não resta ninguém', async () => {
    montar({ pending: 0 });
    expect(screen.getByTestId('next-batch-button')).toBeDisabled();
    expect(screen.getByTestId('campaign-progress-header').textContent).toContain(
      'Todo mundo já recebeu',
    );
  });

  /**
   * A.5 — CANAL DESATIVADO É A OUTRA RAZÃO DE O BOTÃO NÃO PODER SER CLICADO.
   *
   * Teto esgotado não bloqueia (o excedente fica em fila e sai no reset), mas
   * canal desativado bloqueia: nenhum lote sairia, nem agora nem depois. Sem
   * o texto, o operador clicaria e veria um erro do servidor sem saber que a
   * saída é ativar o canal em Canais.
   */
  it('desabilita o envio e explica quando o canal da campanha está desativado', () => {
    state.channels = [{ ...CANAL, isActive: false }];
    montar();
    expect(screen.getByTestId('next-batch-button')).toBeDisabled();
    expect(screen.getByTestId('channel-inactive-notice').textContent).toContain(
      'O canal desta campanha está desativado',
    );
  });

  /**
   * O canal FOI carregado (useProviders resolveu) mas o id da campanha não
   * está em NENHUM provedor — o registro sumiu, ou está errado. Sem isto,
   * `tamanhoInicialDoLote` ainda propõe 1 (o piso "nunca 0 quando há gente")
   * e o botão fica clicável sem canal nenhum por trás.
   */
  it('desabilita o envio e explica quando o canal da campanha não foi encontrado', () => {
    state.channels = []; // carregou; lista vazia, "inst1" não está nela
    montar();
    expect(screen.getByTestId('next-batch-button')).toBeDisabled();
    expect(screen.getByTestId('channel-missing-notice').textContent).toContain(
      'O canal desta campanha não foi encontrado',
    );
  });

  /**
   * T15 (ruling do controller) — ENQUANTO `useProviders()` ainda carrega, o
   * botão FICA desabilitado (não o oposto de antes): `tamanhoInicialDoLote`
   * nunca devolve 0 com público > 0, então "canal desconhecido por
   * ignorância" virava sugestão "1" e o botão ficava clicável sem saber se o
   * canal tinha QUALQUER quota. `resolveCampaignChannel` torna esse estado
   * EXPLÍCITO nas duas telas — ver resolve-channel.ts.
   */
  it('desabilita o envio e explica enquanto a lista de canais ainda carrega', () => {
    state.channels = undefined;
    montar();
    expect(screen.getByTestId('next-batch-button')).toBeDisabled();
    expect(screen.getByTestId('channel-loading-notice').textContent).toContain(
      'Carregando o teto do canal',
    );
    expect(screen.queryByTestId('channel-missing-notice')).not.toBeInTheDocument();
  });

  /**
   * T15 — uma FALHA DE REDE não pode virar "Canal não encontrado": são causas
   * diferentes (rede caída vs. canal que realmente não existe) e pedem
   * respostas diferentes do operador.
   */
  it('desabilita o envio e explica quando a consulta de canais falha (nunca "Canal não encontrado")', () => {
    state.channels = undefined;
    state.providersError = true;
    montar();
    expect(screen.getByTestId('next-batch-button')).toBeDisabled();
    expect(screen.getByTestId('channel-error-notice').textContent).toContain(
      'Não deu para consultar os canais',
    );
    expect(screen.queryByTestId('channel-missing-notice')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('campaign-progress-header').textContent,
    ).not.toContain('Canal não encontrado');
  });

  /**
   * Fix round 1 (#1, review Opus) — o cabeçalho poll a cada 30s
   * (`refetchInterval`). Um REFETCH que falha DEPOIS de já ter um canal bom
   * em cache não pode travar "Enviar próximo lote" — isso desligaria o botão
   * por causa de UM blip de rede, não de um problema real com o canal. A
   * tela só avisa (pequeno, não bloqueante) que o número pode estar
   * desatualizado.
   */
  it('T15 fix round 1 — um blip de REDE numa refetch não trava o envio quando o canal já está em cache (só avisa)', () => {
    state.channels = [CANAL]; // já tinha um canal bom em cache
    state.providersError = true; // ...e a busca MAIS RECENTE falhou
    montar();
    expect(screen.getByTestId('next-batch-button')).not.toBeDisabled();
    expect(screen.getByTestId('channel-stale-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-error-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channel-missing-notice')).not.toBeInTheDocument();
  });

  /**
   * Fix round 1 (#2/#5, review Opus) — pina o contrato de polling: sem
   * `refetchOnMount: 'always'`, o `staleTime: Infinity` de `useProviders()`
   * deixaria esta tela nascer com uma quota velha (buscada há horas pelo
   * topbar); sem `refetchInterval: 30_000`, a quota pararia de avançar
   * enquanto o operador acompanha a campanha.
   */
  it('chama useProviders com refetchInterval:30s e refetchOnMount:"always"', () => {
    montar();
    const ultimaChamada =
      useProvidersMock.mock.calls[useProvidersMock.mock.calls.length - 1];
    expect(ultimaChamada?.[0]).toEqual({
      refetchInterval: 30_000,
      refetchOnMount: 'always',
    });
  });

  /**
   * T15 — a quota funciona para TODO provedor, não só GOZAP: um canal
   * EVOLUTION (o único que `useInstances()` já cobria) não pode regredir.
   */
  it('funciona também com um canal EVOLUTION — não é exclusividade do GoZap', () => {
    state.channels = [{ ...CANAL, provider: 'EVOLUTION' as const }];
    montar();
    expect(screen.getByTestId('next-batch-button')).not.toBeDisabled();
    expect(screen.getByTestId('campaign-channel-line').textContent).toContain(
      'Canal robo: enviou 120 de 500 hoje',
    );
  });

  /**
   * Plano — uma campanha CANCELLED/FAILED pode ter pendentes de sobra (foi
   * interrompida ou falhou no meio). Sem este aviso local, o botão desabilita
   * sem NENHUM dos outros três textos explicar por quê.
   */
  it('desabilita o envio e explica quando a campanha já terminou mas ainda restam pendentes', () => {
    montar({ status: 'CANCELLED', pending: 300 });
    expect(screen.getByTestId('next-batch-button')).toBeDisabled();
    expect(screen.getByTestId('campaign-terminal-notice').textContent).toContain(
      'Esta campanha foi cancelada',
    );
  });

  it('avisa (sem bloquear) quando o teto de hoje já acabou', () => {
    state.channels = [{ ...CANAL, sentToday: 500 }];
    montar();
    expect(screen.getByTestId('next-batch-button')).not.toBeDisabled();
    expect(screen.getByTestId('quota-notice').textContent).toContain(
      'O teto de hoje deste canal acabou',
    );
  });

  /**
   * ★ Achado 3(b) (Importante, review final) — `sendBatch` DESARMA o
   * agendamento de uma vez (`campaigns.service.ts`,
   * `disarmSchedule: !isRecurring`) sempre que a campanha ainda está em
   * DRAFT: é assim que o worker evita disparar a audiência INTEIRA de novo no
   * `nextRunAt` original depois de um lote manual. Isso é CORRETO no backend,
   * mas o cabeçalho oferecia "Enviar próximo lote" numa campanha ONCE_AT
   * agendada sem dizer que o clique joga a data fora — o operador só
   * descobria depois, quando o agendamento simplesmente não disparava.
   */
  describe('achado 3(b) — aviso de "enviar agora cancela o agendamento"', () => {
    it('avisa numa campanha ONCE_AT com nextRunAt (agendamento de uma vez)', () => {
      montar({}, { scheduleType: 'ONCE_AT', nextRunAt: '2026-08-26T13:00:00.000Z' });
      const aviso = screen.getByTestId('schedule-cancel-warning').textContent ?? '';
      expect(aviso).toContain('agendada para 26/08 09:00');
      expect(aviso).toMatch(/cancela o agendamento/i);
    });

    it('não avisa sem nextRunAt (nunca foi agendada)', () => {
      montar({}, { scheduleType: 'ONCE_AT', nextRunAt: null });
      expect(screen.queryByTestId('schedule-cancel-warning')).not.toBeInTheDocument();
    });

    it('não avisa numa campanha RECORRENTE (DAILY_AT) — o agendamento continua armado depois do lote manual', () => {
      montar({}, { scheduleType: 'DAILY_AT', nextRunAt: '2026-08-26T13:00:00.000Z' });
      expect(screen.queryByTestId('schedule-cancel-warning')).not.toBeInTheDocument();
    });
  });

  it('o aviso de "aguardando o canal" vive dentro do cabeçalho', () => {
    state.waiting = { count: 81, instanceNames: ['robo'] };
    montar({ waiting: 81, inFlight: 81 });
    expect(screen.getByTestId('waiting-banner')).toBeInTheDocument();
  });

  it('clicar em "Enviar próximo lote" aciona o envio com o tamanho proposto', async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByTestId('next-batch-button'));
    expect(sendBatchMutate).toHaveBeenCalledTimes(1);
    expect(sendBatchMutate).toHaveBeenCalledWith(380);
  });

  /**
   * A capacidade que substituiu o antigo "Disparar tudo agora" do assistente
   * (removido no achado 5 — ver comentário de `$campaignId.tsx`): uma
   * campanha recém-criada fica em DRAFT, com `pending > 0` e o canal já
   * resolvido, e "Enviar próximo lote" é a ÚNICA porta para tirá-la do papel.
   * Sem este teste, o caminho DRAFT nunca era exercitado — o fixture padrão
   * (`summary()`) é sempre RUNNING.
   */
  it('numa campanha DRAFT com pendentes e canal com quota, "Enviar próximo lote" está habilitado e aciona o envio', async () => {
    const user = userEvent.setup();
    montar({ status: 'DRAFT' });
    expect(screen.getByTestId('next-batch-button')).not.toBeDisabled();

    await user.click(screen.getByTestId('next-batch-button'));
    expect(sendBatchMutate).toHaveBeenCalledTimes(1);
    expect(sendBatchMutate).toHaveBeenCalledWith(380);
  });

  /**
   * Achado 1 (Importante, re-review Opus) — com o lote anterior ainda
   * drenando, o backend devolve `queued: 0` e `skippedAlreadyLive > 0` (todo
   * mundo já tem mensagem viva desta campanha a caminho). Sem explicar isto,
   * o toast lia "Lote N: 0 mensagens enfileiradas" — uma resposta muda que
   * treina o operador a clicar de novo achando que travou. Mesma frase
   * (`frasePuladosEmVoo`) do toast de "Disparar de novo para TODOS" — um só
   * lugar explica o mesmo fato nos dois toasts.
   */
  it('com o lote anterior ainda drenando, o toast diz POR QUE nada foi enfileirado', async () => {
    const user = userEvent.setup();
    sendBatchMutate.mockResolvedValueOnce({
      batchId: 'b2',
      seq: 2,
      requested: 380,
      queued: 0,
      skipped: 0,
      skippedAlreadyLive: 70,
      remaining: 12900,
    });
    montar();
    await user.click(screen.getByTestId('next-batch-button'));

    expect(toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining(
          '70 contatos já têm mensagem a caminho nesta campanha',
        ),
      }),
    );
  });

  /**
   * Achado 2 (Minor, re-review Opus) — `aEnviar` clampa `pedido` (min com
   * `Restam`/`MAX_BATCH_SIZE`) em silêncio: o operador digita 100, só 40
   * saem, e nada na tela avisa que o pedido foi reduzido — ele descobre só
   * lendo o toast DEPOIS de clicar.
   */
  it('avisa quando o pedido é maior do que pode sair agora', async () => {
    const user = userEvent.setup();
    montar({ pending: 40 }); // sugerido inicial: 40 (min(380, 40))
    const campo = screen.getByTestId('next-batch-size');
    await user.clear(campo);
    await user.type(campo, '100');

    expect(screen.getByTestId('batch-request-reduced-notice').textContent).toBe(
      'Você pediu 100, mas só 40 podem sair agora.',
    );
  });

  it('não avisa quando o pedido cabe inteiro', async () => {
    const user = userEvent.setup();
    montar({ pending: 40 });
    const campo = screen.getByTestId('next-batch-size');
    await user.clear(campo);
    await user.type(campo, '40');

    expect(
      screen.queryByTestId('batch-request-reduced-notice'),
    ).not.toBeInTheDocument();
  });

  /**
   * "Disparar de novo para TODOS" é a ÚNICA ação que repete de propósito. A
   * confirmação exige digitar o número de quem já recebeu — ler o número é o
   * que impede o clique automático.
   */
  it('a confirmação de "disparar de novo para TODOS" exige digitar quantos já receberam', async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByTestId('more-actions-trigger'));
    await user.click(screen.getByTestId('action-resend-all'));

    expect(screen.getByTestId('resend-all-confirm-text').textContent).toContain(
      '500 pessoas receberiam esta mensagem pela 2ª vez',
    );
    // O campo é identificável por leitor de tela mesmo sem label visível.
    expect(
      screen.getByLabelText('Digite o número para confirmar'),
    ).toBe(screen.getByTestId('resend-all-confirm-input'));

    const confirmar = screen.getByTestId('resend-all-confirm-button');
    expect(confirmar).toBeDisabled();

    await user.type(screen.getByTestId('resend-all-confirm-input'), '500');
    expect(confirmar).not.toBeDisabled();
  });

  /**
   * A propriedade que mais importa neste fluxo: confirmar "disparar de novo"
   * aciona SÓ o redispatch. Nenhuma das outras três mutações (reenviar
   * falhas, enviar lote, cancelar) pode disparar por engano a partir daqui.
   */
  it('confirmar "disparar de novo para TODOS" aciona só o redispatch, nenhuma outra mutação', async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByTestId('more-actions-trigger'));
    await user.click(screen.getByTestId('action-resend-all'));
    await user.type(screen.getByTestId('resend-all-confirm-input'), '500');
    await user.click(screen.getByTestId('resend-all-confirm-button'));

    expect(redispatchMutate).toHaveBeenCalledTimes(1);
    // Achado 1 (crítico) — sem `resendToAll: true` o backend recorta para
    // `unreached`, que é vazio quando todos já receberam (o caso comum desta
    // ação): "de novo para TODOS" tem de declarar a intenção no corpo.
    expect(redispatchMutate).toHaveBeenCalledWith({ resendToAll: true });
    expect(retryMutate).not.toHaveBeenCalled();
    expect(sendBatchMutate).not.toHaveBeenCalled();
    expect(cancelMutate).not.toHaveBeenCalled();
  });

  it('nem abre a confirmação de "disparar de novo" quando ninguém recebeu ainda', async () => {
    const user = userEvent.setup();
    montar({ sent: 0 });
    await user.click(screen.getByTestId('more-actions-trigger'));
    await user.click(screen.getByTestId('action-resend-all'));
    expect(screen.queryByTestId('resend-all-confirm-text')).not.toBeInTheDocument();
  });

  /**
   * Acima de mil, o texto formata em pt-BR ("1.500"). A confirmação aceita
   * tanto o formatado quanto os dígitos crus — o operador não precisa acertar
   * o ponto de milhar — mas um número ERRADO continua travando o botão.
   */
  it('aceita o número formatado ou cru, mas não um número errado', async () => {
    const user = userEvent.setup();
    montar({ sent: 1500 });
    await user.click(screen.getByTestId('more-actions-trigger'));
    await user.click(screen.getByTestId('action-resend-all'));

    expect(screen.getByTestId('resend-all-confirm-text').textContent).toContain(
      '1.500 pessoas receberiam esta mensagem pela 2ª vez',
    );
    const confirmar = screen.getByTestId('resend-all-confirm-button');
    const campo = screen.getByTestId('resend-all-confirm-input');

    await user.type(campo, '150');
    expect(confirmar).toBeDisabled();

    await user.clear(campo);
    await user.type(campo, '1500');
    expect(confirmar).not.toBeDisabled();

    await user.clear(campo);
    await user.type(campo, '1.500');
    expect(confirmar).not.toBeDisabled();
  });
});
