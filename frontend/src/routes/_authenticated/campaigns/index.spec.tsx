import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CampaignSummary } from '@/features/campaigns/schemas';

// --- Router mock ----------------------------------------------------------
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// --- Feature API mock -----------------------------------------------------
const useCampaignsMock = vi.fn();
const deleteMutate = vi.fn();
// F1 T9 — segmentos dependentes (o aviso "isto some se apagar"). Default
// "sem dependentes" para não poluir os testes que já existiam.
const useDependentSegmentsMock = vi.fn(() => ({ data: [], isLoading: false }));
vi.mock('@/features/campaigns/api', () => ({
  useCampaigns: () => useCampaignsMock(),
  useDeleteCampaign: () => ({ mutateAsync: deleteMutate, isPending: false }),
  useDependentSegments: (...args: unknown[]) => useDependentSegmentsMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// A.6 — cada linha resolve o canal via `useProviders()` (GET
// /whatsapp/providers, TODO provedor — não `useInstances()`, que só cobre
// EVOLUTION). Um canal GOZAP (o provedor de produção) por padrão: é o
// cenário real que `useInstances()` nunca enxergava.
const useProvidersMock = vi.fn(() => ({
  data: {
    providers: [
      {
        provider: 'GOZAP',
        traits: { official: true, sessionBased: false, sessionWindow: false },
        capabilities: [],
        channels: [
          {
            id: 'inst1',
            name: 'robo',
            phoneE164: '+5592999999999',
            isActive: true,
            isDefault: true,
            provider: 'GOZAP',
            dailySendLimit: 500,
            sentToday: 120,
            sentTodayResetAt: '2026-08-24T13:00:00.000Z',
          },
        ],
      },
    ],
  },
  isPending: false,
  isError: false,
}));
vi.mock('@/features/whatsapp/api', () => ({
  useProviders: (...args: unknown[]) => useProvidersMock(...args),
}));

import { Route } from './index';

const CampaignsPage = (Route as unknown as { component: React.ComponentType })
  .component;

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

function makeCampaign(over: Partial<CampaignSummary>): CampaignSummary {
  return {
    id: 'c1',
    name: 'Campanha',
    templateId: 'tpl1',
    template: { metaName: 'tpl', language: 'pt_BR' },
    totalRecipients: 0,
    status: 'DRAFT',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    statusCounts: [],
    ...over,
  };
}

beforeEach(() => {
  // Achado 4 (review final) — `quotaRestante`/`horaDoReset` agora tratam um
  // `sentTodayResetAt` com mais de 24h como "reset já passado". O fixture do
  // canal usa uma data FIXA de 2026-08-24 — sem travar o relógio, o teste
  // "Aguardando teto" (que depende da quota estar de fato esgotada, não
  // stale) ficaria refém de QUANDO ele roda de verdade. Só `Date` é
  // congelado.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-24T15:00:00.000Z'));
  useCampaignsMock.mockReset();
  deleteMutate.mockReset();
  deleteMutate.mockResolvedValue({ deleted: true, id: 'c1' });
  useDependentSegmentsMock.mockReset();
  useDependentSegmentsMock.mockReturnValue({ data: [], isLoading: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CampaignsPage — 0-recipients progress', () => {
  it('shows a "sem destinatários" indicator (not a 0% bar) when totalRecipients === 0', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'empty',
          name: 'Campanha vazia',
          totalRecipients: 0,
          statusCounts: [],
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);

    const row = screen.getByRole('row', { name: /Campanha vazia/i });
    // The 0-recipient case must surface an explicit "sem destinatários" state.
    expect(
      within(row).getByText(/sem destinat[aá]rios/i),
    ).toBeInTheDocument();
    // And it must NOT render a width:0% progress fill (the misleading 0% case).
    expect(
      within(row).queryByTestId('campaign-progress-bar'),
    ).not.toBeInTheDocument();
  });

  it('renders a progress bar when there are recipients', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'full',
          name: 'Campanha cheia',
          totalRecipients: 10,
          status: 'RUNNING',
          statusCounts: [{ status: 'SENT', _count: 5 }],
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);

    const row = screen.getByRole('row', { name: /Campanha cheia/i });
    expect(
      within(row).getByTestId('campaign-progress-bar'),
    ).toBeInTheDocument();
    expect(
      within(row).queryByText(/sem destinat[aá]rios/i),
    ).not.toBeInTheDocument();
  });
});

describe('CampaignsPage — progress percentage', () => {
  function fillStyle(row: HTMLElement): string {
    const bar = within(row).getByTestId('campaign-progress-bar');
    const fill = bar.firstElementChild as HTMLElement;
    return fill.getAttribute('style') ?? '';
  }

  it('computes pct against total Message rows (fulfilled = SENT+DELIVERED+READ)', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'mix',
          name: 'Campanha mix',
          // Achado 2 (review final) — o denominador é o MAIOR entre
          // totalRecipients e totalMessages; aqui os dois batem (a campanha
          // já processou o público inteiro), então o resultado é o mesmo de
          // antes. `totalRecipients` maior que `totalMessages` é o cenário
          // coberto pelo teste de lotes logo abaixo (não pode virar 100%).
          totalRecipients: 6,
          status: 'RUNNING',
          // total = 1+1+1+1+1+1 = 6 messages; fulfilled = SENT+DELIVERED+READ = 3
          statusCounts: [
            { status: 'QUEUED', _count: 1 },
            { status: 'SENT', _count: 1 },
            { status: 'DELIVERED', _count: 1 },
            { status: 'READ', _count: 1 },
            { status: 'FAILED', _count: 1 },
            { status: 'CANCELLED', _count: 1 },
          ],
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Campanha mix/i });
    // 3 / 6 = 50%
    expect(fillStyle(row)).toContain('width: 50%');
  });

  /**
   * ★ Achado 2 (Importante, review final) — a barra e o texto abaixo dela
   * (`textoDaLinha`, testado em `list-progress.spec.ts`) usavam denominadores
   * DIFERENTES: a barra caía para `totalMessages` assim que a 1ª Message
   * existia, mesmo com a campanha em LOTES (13.400 no público, só 500
   * disparados no 1º lote) — 100% de barra ao lado de "500 / 13.400 · restam
   * 12.900" na mesma linha. O denominador da barra tem de ser o MAIOR entre
   * `totalRecipients` e `totalMessages` — nunca menor que o público inteiro
   * enquanto ele for conhecido.
   */
  it('não contradiz o texto: depois do 1º lote de 13.400, a barra NÃO pula para 100%', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'lote1',
          name: 'Campanha em lotes',
          totalRecipients: 13400,
          status: 'RUNNING',
          statusCounts: [{ status: 'SENT', _count: 500 }],
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Campanha em lotes/i });
    expect(within(row).getByTestId('campaign-counts').textContent).toBe(
      '500 / 13.400 · restam 12.900',
    );
    // 500 / 13.400 ≈ 3,73% — não 100%, que é o que `totalMessages` (500) sozinho daria.
    expect(fillStyle(row)).not.toContain('width: 100%');
    expect(fillStyle(row)).toContain('width: 3.73');
  });

  it('uses totalRecipients as denominator when there are no Message rows yet (0%)', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'fresh',
          name: 'Campanha nova',
          totalRecipients: 50,
          status: 'QUEUED',
          statusCounts: [],
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Campanha nova/i });
    // No messages -> denom = totalRecipients = 50, fulfilled = 0 -> 0%
    expect(within(row).getByTestId('campaign-progress-bar')).toBeInTheDocument();
    expect(fillStyle(row)).toContain('width: 0%');
  });
});

// A fusão de /disparos: as taxas por campanha agora moram aqui. A seção
// "fora do orgamind" (disparos pelo painel do Zernio) foi removida a pedido do
// cliente — poluía a tela de campanhas com algo que não é campanha do orgamind.
describe('CampaignsPage — fusão de /disparos', () => {
  it('mostra "% entregue · % lida" sob a barra de progresso quando há mensagens', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          totalRecipients: 45,
          status: 'COMPLETED',
          statusCounts: [
            { status: 'DELIVERED', _count: 7 },
            { status: 'READ', _count: 31 },
            { status: 'SENT', _count: 1 },
            { status: 'FAILED', _count: 6 },
          ],
        }),
      ],
      isLoading: false,
      isError: false,
    });

    wrap(<CampaignsPage />);

    // (7+31)/45 destinatários = 84% entregue; 31/45 = 69% lida — a MESMA
    // régua do card "Campanhas recentes" do Início.
    expect(screen.getByTestId('delivery-caption')).toHaveTextContent(
      '84% entregue · 69% lida',
    );
  });

  it('quem foi PULADO pelo gate conta no denominador — 40 pulados + 60 entregues NÃO é "100% entregue"', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          totalRecipients: 100,
          status: 'COMPLETED',
          statusCounts: [
            { status: 'DELIVERED', _count: 60 },
            { status: 'SKIPPED_NO_CONSENT', _count: 40 },
          ],
        }),
      ],
      isLoading: false,
      isError: false,
    });

    wrap(<CampaignsPage />);

    // Entrega é prestação de contas: 60 de 100 destinatários receberam.
    expect(screen.getByTestId('delivery-caption')).toHaveTextContent(
      '60% entregue · 0% lida',
    );
  });

  it('sem nenhuma Message ainda, não inventa "0% entregue"', () => {
    useCampaignsMock.mockReturnValue({
      data: [makeCampaign({ totalRecipients: 10, statusCounts: [] })],
      isLoading: false,
      isError: false,
    });

    wrap(<CampaignsPage />);

    expect(screen.queryByTestId('delivery-caption')).not.toBeInTheDocument();
  });
});

// A.6 — o badge de status passou a mostrar `statusDoOperador(...)` (a frase
// escrita para o operador), não mais o rótulo cru de `CAMPAIGN_STATUS_LABEL`.
// As regras exatas de cada frase têm cobertura própria em
// `list-progress.spec.ts`; aqui só interessa que a página LIGUE campaign +
// canal + quota corretamente e passe o resultado para o Badge.
describe('CampaignsPage — status do operador (badge)', () => {
  it('estados terminais (COMPLETED/CANCELLED/...) falam por si, como antes', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({ id: 's1', name: 'Camp completa', status: 'COMPLETED' }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Camp completa/i });
    expect(within(row).getByText('Concluída')).toBeInTheDocument();
  });

  it('um status fora do vocabulário conhecido cai no caminho genérico "em andamento" (não trava nem mostra o código cru)', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 's2',
          name: 'Camp desconhecida',
          // fora de CAMPAIGN_STATUS_LABEL e dos 4 estados terminais que
          // statusDoOperador trata explicitamente — cai no ramo "em curso".
          status: 'SOMETHING_NEW' as CampaignSummary['status'],
          totalRecipients: 10,
          statusCounts: [{ status: 'SENT', _count: 3 }],
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Camp desconhecida/i });
    expect(
      within(row).getByText('Em andamento — próximo lote disponível'),
    ).toBeInTheDocument();
  });

  it('applies animate-pulse to the badge only while RUNNING', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'run',
          name: 'Camp em curso',
          status: 'RUNNING',
          totalRecipients: 10,
          statusCounts: [{ status: 'SENT', _count: 3 }],
        }),
        makeCampaign({ id: 'draft', name: 'Camp rascunho', status: 'DRAFT' }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const running = within(
      screen.getByRole('row', { name: /Camp em curso/i }),
    ).getByText('Em andamento — próximo lote disponível');
    const draft = within(
      screen.getByRole('row', { name: /Camp rascunho/i }),
    ).getByText('Rascunho — nada foi enviado ainda');
    expect(running.className).toContain('animate-pulse');
    expect(draft.className).not.toContain('animate-pulse');
  });
});

describe('CampaignsPage — row content', () => {
  it('renders name, template metaName, recipient count and a pt-BR date', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'full-row',
          name: 'Campanha completa',
          template: { metaName: 'meu_template', language: 'pt_BR' },
          totalRecipients: 42,
          status: 'DRAFT',
          createdAt: new Date('2026-06-01T12:00:00Z'),
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Campanha completa/i });
    expect(within(row).getByText('Campanha completa')).toBeInTheDocument();
    expect(within(row).getByText('meu_template')).toBeInTheDocument();
    expect(within(row).getByText('42')).toBeInTheDocument();
    // Date is formatted via toLocaleString('pt-BR'); assert against the same call
    // so the test is locale-runtime-agnostic.
    expect(
      within(row).getByText(
        new Date('2026-06-01T12:00:00Z').toLocaleString('pt-BR'),
      ),
    ).toBeInTheDocument();
  });

  /**
   * Minor 8 (review final) — a coluna "Destinatários" mostrava o número CRU
   * (`13400`) na MESMA linha em que "Progresso" já formata em pt-BR
   * ("13.400"): duas réguas diferentes lado a lado.
   */
  it('formata Destinatários em pt-BR (milhar com ponto)', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'big-row',
          name: 'Campanha grande',
          totalRecipients: 13400,
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<CampaignsPage />);
    const row = screen.getByRole('row', { name: /Campanha grande/i });
    expect(within(row).getByText('13.400')).toBeInTheDocument();
    expect(within(row).queryByText('13400')).not.toBeInTheDocument();
  });
});

/**
 * APAGAR CAMPANHA.
 *
 * `Message.campaignId -> Campaign` é `onDelete: Cascade`, e as Message são as
 * BOLHAS DO INBOX. Apagar uma campanha que enviou de verdade ARRANCA essas bolhas
 * das conversas — o contato responde a uma mensagem que o operador não vê mais.
 *
 * Por isso a tela tem de DIZER O ESTRAGO ANTES, com o número, e exigir
 * confirmação. Um "tem certeza?" genérico não informa nada.
 */
describe('CampaignsPage — apagar campanha', () => {
  const comMensagens = makeCampaign({
    id: 'c1',
    name: 'Teste 1',
    status: 'COMPLETED',
    totalRecipients: 2,
    statusCounts: [
      { status: 'SENT', _count: 5 },
      { status: 'SKIPPED_NO_CONSENT', _count: 2 },
    ],
  });

  it('a confirmação DIZ quantas bolhas do inbox somem — e que o consentimento não é afetado', async () => {
    const user = userEvent.setup();
    useCampaignsMock.mockReturnValue({ data: [comMensagens], isLoading: false });
    wrap(<CampaignsPage />);

    await user.click(screen.getByRole('button', { name: /apagar campanha Teste 1/i }));

    const aviso = (await screen.findByTestId('delete-warning')).textContent ?? '';
    expect(aviso).toMatch(/7 mensagens/i); // 5 SENT + 2 SKIPPED
    expect(aviso).toMatch(/inbox|conversas/i);
    expect(aviso).toMatch(/consentimento/i);
  });

  it('só apaga DEPOIS de confirmar', async () => {
    const user = userEvent.setup();
    useCampaignsMock.mockReturnValue({ data: [comMensagens], isLoading: false });
    wrap(<CampaignsPage />);

    await user.click(screen.getByRole('button', { name: /apagar campanha Teste 1/i }));
    // O diálogo abriu, mas nada foi apagado ainda.
    expect(deleteMutate).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('button', { name: /^apagar$/i }));
    expect(deleteMutate).toHaveBeenCalledWith('c1');
  });

  /**
   * F1 T9 — o furo que o T7 (excluir quem já recebeu) deixou aberto: apagar a
   * campanha CASCADE-apaga as Message, e é esse registro que os filtros
   * "history" leem para decidir quem já recebeu. O diálogo tem de dizer isso
   * — não só que as bolhas do inbox somem, mas que o próprio registro de "quem
   * recebeu" some, e o que isso destrava silenciosamente.
   */
  it('o aviso diz que apagar destrói o registro de quem já recebeu a campanha', async () => {
    const user = userEvent.setup();
    useCampaignsMock.mockReturnValue({ data: [comMensagens], isLoading: false });
    wrap(<CampaignsPage />);

    await user.click(screen.getByRole('button', { name: /apagar campanha Teste 1/i }));

    const aviso = (await screen.findByTestId('delete-warning')).textContent ?? '';
    expect(aviso).toMatch(/registro de quem (já )?recebeu/i);
  });

  it('lista os segmentos dependentes quando o endpoint devolve algum', async () => {
    const user = userEvent.setup();
    useCampaignsMock.mockReturnValue({ data: [comMensagens], isLoading: false });
    useDependentSegmentsMock.mockReturnValue({
      data: [
        { id: 'seg-1', name: 'Já receberam a campanha Teste 1' },
        { id: 'seg-2', name: 'Excluindo Teste 1' },
      ],
      isLoading: false,
    });
    wrap(<CampaignsPage />);

    await user.click(screen.getByRole('button', { name: /apagar campanha Teste 1/i }));

    const aviso = await screen.findByTestId('dependent-segments-warning');
    expect(aviso.textContent).toMatch(/já receberam a campanha teste 1/i);
    expect(aviso.textContent).toMatch(/excluindo teste 1/i);
  });

  it('sem segmentos dependentes, não mostra a lista (não polui o diálogo)', async () => {
    const user = userEvent.setup();
    useCampaignsMock.mockReturnValue({ data: [comMensagens], isLoading: false });
    useDependentSegmentsMock.mockReturnValue({ data: [], isLoading: false });
    wrap(<CampaignsPage />);

    await user.click(screen.getByRole('button', { name: /apagar campanha Teste 1/i }));

    // O diálogo já abriu (o warning de mensagens existe); só a lista de
    // dependentes é que não deve aparecer.
    await screen.findByTestId('delete-warning');
    expect(
      screen.queryByTestId('dependent-segments-warning'),
    ).not.toBeInTheDocument();
  });

  /**
   * Campanha EM VOO não pode ser apagada (o backend recusa com campaign.in_flight):
   * os jobs já enfileirados ficariam apontando para Message inexistentes. A tela
   * não deve nem oferecer o botão.
   */
  it('campanha RUNNING não oferece o botão de apagar — cancele antes', () => {
    useCampaignsMock.mockReturnValue({
      data: [makeCampaign({ id: 'c2', name: 'Em voo', status: 'RUNNING' })],
      isLoading: false,
    });
    wrap(<CampaignsPage />);

    expect(
      screen.queryByRole('button', { name: /apagar campanha Em voo/i }),
    ).not.toBeInTheDocument();
  });
});

/**
 * "APAGAR TODAS" — o pedido literal: limpar as campanhas de teste e começar do
 * zero. Mesma confirmação, mesma franqueza, com a contagem SOMADA.
 *
 * Campanhas em voo ficam de fora (o backend as recusaria de qualquer forma), e o
 * diálogo diz quantas serão apagadas — não "todas", que esconderia o fato de que
 * as em voo sobrevivem.
 */
describe('CampaignsPage — apagar todas', () => {
  it('soma as mensagens de todas e apaga uma a uma, pulando as EM VOO', async () => {
    const user = userEvent.setup();
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          id: 'c1',
          name: 'Teste 1',
          status: 'COMPLETED',
          statusCounts: [{ status: 'SENT', _count: 5 }],
        }),
        makeCampaign({
          id: 'c2',
          name: 'Teste 2',
          status: 'FAILED',
          statusCounts: [{ status: 'SKIPPED_NO_CONSENT', _count: 3 }],
        }),
        makeCampaign({ id: 'c3', name: 'Em voo', status: 'RUNNING' }),
      ],
      isLoading: false,
    });
    wrap(<CampaignsPage />);

    await user.click(screen.getByRole('button', { name: /apagar todas/i }));

    const aviso = (await screen.findByTestId('delete-all-warning')).textContent ?? '';
    expect(aviso).toMatch(/2 campanhas/i); // a RUNNING fica de fora
    expect(aviso).toMatch(/8 mensagens/i); // 5 + 3
    expect(aviso).toMatch(/consentimento/i);

    await user.click(await screen.findByRole('button', { name: /^apagar 2$/i }));

    expect(deleteMutate).toHaveBeenCalledTimes(2);
    expect(deleteMutate).toHaveBeenCalledWith('c1');
    expect(deleteMutate).toHaveBeenCalledWith('c2');
    expect(deleteMutate).not.toHaveBeenCalledWith('c3');
  });

  it('sem campanhas apagáveis, não oferece "apagar todas"', () => {
    useCampaignsMock.mockReturnValue({
      data: [makeCampaign({ id: 'c3', name: 'Em voo', status: 'RUNNING' })],
      isLoading: false,
    });
    wrap(<CampaignsPage />);

    expect(
      screen.queryByRole('button', { name: /apagar todas/i }),
    ).not.toBeInTheDocument();
  });
});

/**
 * A.6 — a lista mostra quantos faltam e por que a campanha parou, sem uma
 * consulta de audiência por linha. O canal (`inst1`, GOZAP) vem do
 * `useProvidersMock` default declarado no topo do arquivo: dailySendLimit
 * 500, sentToday 120 → quota restante 380, coerente com "próximo lote
 * disponível".
 */
describe('A.6 — a linha diz quantos faltam', () => {
  it('mostra "500 / 13.400 · restam 12.900" e o status escrito para o operador', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          totalRecipients: 13400,
          status: 'RUNNING',
          defaultInstanceId: 'inst1',
          statusCounts: [
            { status: 'SENT', _count: 300 },
            { status: 'DELIVERED', _count: 150 },
            { status: 'READ', _count: 50 },
          ],
        }),
      ],
      isLoading: false,
    });

    wrap(<CampaignsPage />);

    expect(screen.getByTestId('campaign-counts').textContent).toBe(
      '500 / 13.400 · restam 12.900',
    );
    expect(
      screen.getByText('Em andamento — próximo lote disponível'),
    ).toBeInTheDocument();
  });

  /**
   * Uma campanha ANTIGA cujo `summary` não tem os campos novos (T5) — sem
   * `defaultInstanceId`/`timezone` — ainda tem de renderizar a linha, sem
   * quebrar em `undefined`.
   */
  it('renderiza a linha mesmo quando o summary não traz defaultInstanceId/timezone', () => {
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          name: 'Campanha antiga',
          totalRecipients: 10,
          status: 'RUNNING',
          statusCounts: [{ status: 'SENT', _count: 2 }],
        }),
      ],
      isLoading: false,
    });

    wrap(<CampaignsPage />);

    const row = screen.getByRole('row', { name: /Campanha antiga/i });
    expect(within(row).getByTestId('campaign-counts').textContent).toBe(
      '2 / 10 · restam 8',
    );
    // Sem canal resolvido (defaultInstanceId ausente), a quota é
    // desconhecida — o status cai no ramo padrão "em andamento", nunca em
    // branco ou quebrado.
    expect(
      within(row).getByText('Em andamento — próximo lote disponível'),
    ).toBeInTheDocument();
  });

  /**
   * "Aguardando teto" só aparece quando a quota do canal da campanha
   * realmente acabou — o cenário que fez o operador criar campanhas
   * duplicadas por achar que "500" era um limite da campanha, e não do canal.
   */
  it('mostra "Aguardando teto (reinicia HH:MM)" quando a quota do canal acabou', () => {
    useProvidersMock.mockReturnValueOnce({
      data: {
        providers: [
          {
            provider: 'GOZAP',
            traits: { official: true, sessionBased: false, sessionWindow: false },
            capabilities: [],
            channels: [
              {
                id: 'inst1',
                name: 'robo',
                phoneE164: '+5592999999999',
                isActive: true,
                isDefault: true,
                provider: 'GOZAP',
                dailySendLimit: 500,
                sentToday: 500,
                sentTodayResetAt: '2026-08-24T13:00:00.000Z',
              },
            ],
          },
        ],
      },
      isPending: false,
      isError: false,
    });
    useCampaignsMock.mockReturnValue({
      data: [
        makeCampaign({
          name: 'Campanha no teto',
          totalRecipients: 13400,
          status: 'RUNNING',
          defaultInstanceId: 'inst1',
          timezone: 'America/Manaus',
          statusCounts: [{ status: 'SENT', _count: 500 }],
        }),
      ],
      isLoading: false,
    });

    wrap(<CampaignsPage />);

    const row = screen.getByRole('row', { name: /Campanha no teto/i });
    expect(within(row).getByText(/Aguardando teto \(reinicia \d{2}:\d{2}\)/)).toBeInTheDocument();
  });
});
