import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CampaignDetail } from '@/features/campaigns/schemas';

// --- Router mock ----------------------------------------------------------
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
    useParams: () => ({ campaignId: 'camp1' }),
  }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// --- react-query -------------------------------------------------------
// A.5 — a página não usa mais useQuery diretamente (a consulta de "aguardando
// canal" virou useCampaignWaiting, dentro do cabeçalho). O mock fica de pé,
// simples, para o caso de algum filho não stubado precisar dele.
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
}));

// --- api-client mock --------------------------------------------------
vi.mock('@/lib/api-client', () => ({
  api: { get: vi.fn(() => ({ json: vi.fn() })) },
}));

// --- Feature API mocks ----------------------------------------------------
// A.5 — a página só chama `useCampaign`/`useCampaignMessages` diretamente;
// `useCancelCampaign`/`useRedispatchCampaign`/`useRetryFailed` (e os toasts
// que os cercavam) migraram para dentro de `CampaignProgressHeader`, que é
// mockado inteiro logo abaixo — não sobrou consumidor real destes hooks
// nem de `sonner`/`extractApiError` neste arquivo.
const useCampaignMock = vi.fn();
vi.mock('@/features/campaigns/api', () => ({
  useCampaign: () => useCampaignMock(),
  useCampaignMessages: () => ({ data: undefined }),
}));

// --- Stub heavy children --------------------------------------------------
vi.mock('@/components/events-explorer', () => ({ EventsExplorer: () => null }));
vi.mock('@/features/whatsapp/components/waiting-messages-banner', () => ({
  WaitingMessagesBanner: () => null,
}));
vi.mock('@/features/consent/api', () => ({
  useConsentPurposes: () => ({
    data: [
      {
        key: 'campanha_apoio',
        label: 'Campanha de apoio',
        description: '',
        isSensitive: false,
      },
    ],
  }),
}));
vi.mock('@/features/campaigns/components/messages-table', () => ({
  MessagesTable: () => null,
}));
vi.mock('@/features/campaigns/components/schedule-info-card', () => ({
  ScheduleInfoCard: () => null,
}));
// ZE — o painel de lotes tem spec própria (batch-panel.spec.tsx) e faz suas
// próprias queries; aqui ele é só mais um filho pesado a stubar.
vi.mock('@/features/campaigns/components/batch-panel', () => ({
  BatchPanel: () => null,
}));

// O cabeçalho de progresso tem spec própria (campaign-progress-header.spec.tsx)
// e faz as próprias queries; aqui só interessa que a página o monte, com o
// canal e o fuso da campanha.
const headerProps: Array<Record<string, unknown>> = [];
vi.mock('@/features/campaigns/components/campaign-progress-header', () => ({
  CampaignProgressHeader: (p: Record<string, unknown>) => {
    headerProps.push(p);
    return <div data-testid="campaign-progress-header" />;
  },
}));

import { Route } from './$campaignId';

const CampaignDetailPage = (
  Route as unknown as { component: React.ComponentType }
).component;

function makeCampaign(status: CampaignDetail['status']): CampaignDetail {
  return {
    id: 'camp1',
    name: 'Campanha',
    templateId: 'tpl1',
    totalRecipients: 10,
    status,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    filters: { combinator: 'and', rules: [] },
    variableMap: {},
    template: {
      id: 'tpl1',
      metaName: 'tpl',
      language: 'pt_BR',
      body: 'oi',
      variables: [],
    },
    statusCounts: [],
  };
}

beforeEach(() => {
  headerProps.length = 0;
  useCampaignMock.mockReset();
});

/**
 * Achado 5 (Importante, review final) — "Disparar tudo agora" saiu da
 * página: era um 3º caminho de envio (enfileirava a audiência INTEIRA sem
 * quota/canal/confirmação), redundante com "Enviar próximo lote" do
 * cabeçalho de progresso, que já atende uma campanha em DRAFT (`sendBatch`
 * também a tira de DRAFT). "Enviar próximo lote" é agora a ÚNICA porta de
 * envio na tela, para qualquer status não-terminal — inclusive DRAFT.
 */
describe('CampaignDetailPage — sem "Disparar tudo agora" (achado 5)', () => {
  it('não mostra "Disparar tudo agora" numa campanha DRAFT — só "Enviar próximo lote", no cabeçalho', () => {
    useCampaignMock.mockReturnValue({
      data: makeCampaign('DRAFT'),
      isLoading: false,
    });

    render(<CampaignDetailPage />);

    expect(
      screen.queryByRole('button', { name: /disparar tudo agora/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('campaign-progress-header')).toBeInTheDocument();
  });

  it('não mostra "Disparar tudo agora" em nenhum outro status', () => {
    for (const status of [
      'QUEUED',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ] as const) {
      useCampaignMock.mockReturnValue({
        data: makeCampaign(status),
        isLoading: false,
      });

      const { unmount } = render(<CampaignDetailPage />);

      expect(
        screen.queryByRole('button', { name: /disparar tudo agora/i }),
      ).not.toBeInTheDocument();

      unmount();
    }
  });
});

// A.5 — a ação mudou para "Mais ações" no cabeçalho (campaign-progress-header.spec.tsx).
// A.5 — a consulta virou useCampaignWaiting (features/campaigns/api.ts) e o polling vive no cabeçalho.

/**
 * GATE SILENCIOSO — o incidente de 2026-07-10.
 *
 * 2 contatos, campanha disparada, NADA saiu. Todos os contadores em zero
 * (Enviadas 0, Entregues 0, Lidas 0, Falhas 0, Pendentes 0) e o status "Em
 * execução" para sempre. O motivo real — os 2 contatos não consentiram para a
 * finalidade — só aparecia num selinho cinza dentro de UMA mensagem.
 *
 * A tela precisa dizer, sozinha: quantos foram pulados, por qual finalidade, e
 * o que fazer.
 */
describe('CampaignDetailPage — pulados pelo gate de consentimento', () => {
  function skippedCampaign(): CampaignDetail {
    return {
      ...makeCampaign('COMPLETED'),
      totalRecipients: 2,
      purposeKey: 'campanha_apoio',
      statusCounts: [{ status: 'SKIPPED_NO_CONSENT', _count: 2 }],
    };
  }

  // A.5 — o grid solto de 7 KPIs (com o card "Pulados (sem consentimento)",
  // testid kpi-skipped) saiu da página. A contagem de pulados continua visível
  // no card "Distribuição" logo abaixo, e o total de inválidos/pulados aparece
  // dentro do cabeçalho de progresso (campaign-progress-header.spec.tsx).

  it('avisa no topo: quantos, por qual finalidade e a saída', () => {
    useCampaignMock.mockReturnValue({
      data: skippedCampaign(),
      isLoading: false,
    });

    render(<CampaignDetailPage />);

    const alert = screen.getByTestId('skipped-alert');
    // Quantos, de quantos.
    expect(alert).toHaveTextContent(/2 de 2/);
    // Por qual finalidade — o RÓTULO, não a key (o operador não fala slug).
    expect(alert).toHaveTextContent(/Campanha de apoio/i);
    // Nenhuma mensagem saiu — o que ele achou que era horário.
    expect(alert).toHaveTextContent(/nenhuma mensagem (saiu|foi enviada)/i);
    // A saída.
    expect(alert).toHaveTextContent(/opt-in|consentimento|finalidade/i);
  });

  it('não mostra o aviso quando não há pulados', () => {
    useCampaignMock.mockReturnValue({
      data: {
        ...makeCampaign('COMPLETED'),
        statusCounts: [{ status: 'SENT', _count: 10 }],
      },
      isLoading: false,
    });

    render(<CampaignDetailPage />);

    expect(screen.queryByTestId('skipped-alert')).not.toBeInTheDocument();
  });
});

// A.5 — a ação mudou para "Mais ações" no cabeçalho (campaign-progress-header.spec.tsx).

describe('A.5 — a página monta o cabeçalho de progresso', () => {
  it('passa o canal e o fuso da campanha para o cabeçalho', () => {
    headerProps.length = 0;
    useCampaignMock.mockReturnValue({
      data: {
        ...makeCampaign('RUNNING'),
        defaultInstanceId: 'inst1',
        timezone: 'America/Manaus',
        retryableFailedCount: 3,
      },
      isLoading: false,
    });

    render(<CampaignDetailPage />);

    expect(screen.getByTestId('campaign-progress-header')).toBeInTheDocument();
    expect(headerProps[0]).toMatchObject({
      campaignId: 'camp1',
      defaultInstanceId: 'inst1',
      timezone: 'America/Manaus',
      retryableFailedCount: 3,
    });
  });

  /**
   * Os botões antigos ("Disparar novamente", "Reenviar falhas", "Cancelar
   * campanha") mudaram de casa: agora vivem em "Mais ações", dentro do
   * cabeçalho. Deixá-los também no topo daria duas portas para a mesma coisa,
   * com confirmações diferentes.
   */
  it('não mostra mais os botões soltos no topo', () => {
    useCampaignMock.mockReturnValue({
      data: { ...makeCampaign('RUNNING'), defaultInstanceId: 'inst1' },
      isLoading: false,
    });

    render(<CampaignDetailPage />);

    expect(screen.queryByText('Disparar novamente')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelar campanha')).not.toBeInTheDocument();
  });
});
