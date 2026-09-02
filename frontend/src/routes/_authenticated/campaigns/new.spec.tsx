import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PreviewResult, ScheduleConfig } from '@/features/campaigns/schemas';
import { hasExcludeInvalid } from '@/features/campaigns/exclude-invalid';

// --- Router mock ----------------------------------------------------------
const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
  useNavigate: () => navigateSpy,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// --- Toast mock -----------------------------------------------------------
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

// --- Feature API mocks ----------------------------------------------------
// create resolves to a DRAFT campaign. Fix round 1 (#2) — `useRunCampaign`
// stays mocked (some other spec/util in this file's history may still
// reference it) but `new.tsx` itself no longer imports or calls it: the
// wizard's confirm step now sends the 1º LOTE via `sendFirstBatch` only.
const CREATED_ID = 'clcreated000000000000000a';
const createMutateAsync = vi.fn();
const runMutateAsync = vi.fn();
const previewMutateAsync = vi.fn();
const preflightChecksMutateAsync = vi.fn();
const sendBatchMutateAsync = vi.fn();
// Fix round 1 (#2) — configurável por teste: precisa simular o lote EM VOO
// (entre o create resolver e o sendFirstBatch terminar) para provar que os
// dois botões ficam travados nessa janela, não só durante `create.isPending`.
const sendBatchState: { isPending: boolean } = { isPending: false };

vi.mock('@/features/campaigns/api', () => ({
  useCreateCampaign: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useRunCampaign: () => ({ mutateAsync: runMutateAsync, isPending: false }),
  usePreviewCampaign: () => ({ mutateAsync: previewMutateAsync, isPending: false }),
  usePreflightCampaignChecks: () => ({
    mutateAsync: preflightChecksMutateAsync,
    isPending: false,
  }),
  // A.3 — o 1º LOTE do assistente: recebe o campaignId NA CHAMADA (T5).
  useSendFirstBatch: () => ({
    mutateAsync: sendBatchMutateAsync,
    isPending: sendBatchState.isPending,
  }),
  // F1 T7 — HistoryExclusionBlock (stubbed below) reads this too; empty list
  // is enough since these tests don't exercise the exclusion picker itself
  // (see history-exclusion-block.spec.tsx for that).
  useCampaigns: () => ({ data: [] }),
}));

// Catálogo de templates lido preguiçosamente (mesmo padrão de `providersState`
// abaixo): um teste injeta um template com botões ilegíveis sem contaminar os
// demais. O `beforeEach` restaura o catálogo padrão (um único APPROVED).
type MockTemplate = {
  id: string;
  metaName: string;
  language: string;
  status: string;
  body: string;
  variables: string[];
  consentButtons?: {
    labels: string[];
    declared: { text: string; role: string }[];
    problems: string[];
  } | null;
};
const templatesState: { data: MockTemplate[] } = { data: [] };
const DEFAULT_TEMPLATE: MockTemplate = {
  id: 'tpl1',
  metaName: 'boas_vindas',
  language: 'pt_BR',
  status: 'APPROVED',
  body: 'Olá {{nome}}',
  variables: ['nome'],
};

vi.mock('@/features/templates/api', () => ({
  useTemplates: () => templatesState,
}));

type MockProvider = 'EVOLUTION' | 'TWILIO' | 'ZERNIO' | 'META' | 'GOZAP';
type MockChannel = {
  id: string;
  name: string;
  phoneE164: string | null;
  isActive: boolean;
  isDefault: boolean;
  provider: MockProvider;
  // T15 — a quota de hoje, espelhando os 6 campos opcionais que
  // `channelSummarySchema` (whatsapp/api.ts) agora declara. Antes só existia
  // em `useInstances()` (EVOLUTION-only); agora vem do MESMO `useProviders()`
  // que já alimenta a seleção de canal do assistente.
  dailySendLimit?: number;
  sentToday?: number;
  sentTodayResetAt?: string | null;
  warmupEffectiveCap?: number;
  warming?: boolean;
  warmupDay?: number;
};

// Multi-provider channel source. Individual tests overwrite `providersState.data`
// to exercise grouping / scope / cross-provider behaviour. Accessed lazily
// (functions close over the module-level state), so the value is read at render
// time — not when the mock factory runs.
//
// T15 — `isPending`/`isError` entraram no mock porque `resolveCampaignChannel`
// (o passo final do assistente, T11) lê os três campos de `useProviders()`
// para decidir entre "carregando"/"erro"/"não encontrado"/"encontrado" — a
// MESMA query que já alimentava a seleção de canal, agora também a quota.
const providersState: {
  data: { providers: { provider: MockProvider; channels: MockChannel[] }[] } | undefined;
  isPending: boolean;
  isError: boolean;
} = { data: { providers: [] }, isPending: false, isError: false };
// `.mock.calls` grava os ARGUMENTOS reais que cada chamador passa —
// `NewCampaignPage` (seleção de canal, sem args) e `Step4Confirm` (quota,
// T15 fix round 1 #2: `refetchOnMount: 'always'`) chamam o MESMO hook com
// opções diferentes. Referência preguiçosa por causa do hoisting do
// `vi.mock` (ver o mesmo padrão em campaign-progress-header.spec.tsx).
const useProvidersMock = vi.fn(() => providersState);
vi.mock('@/features/whatsapp/api', () => ({
  useProviders: (...args: Parameters<typeof useProvidersMock>) =>
    useProvidersMock(...args),
}));

// Global provider scope (topbar). `scopeState.scope` is read lazily on render.
const scopeState: { scope: 'all' | MockProvider } = { scope: 'all' };
vi.mock('@/features/whatsapp/provider-scope', () => ({
  useProviderScope: () => ({ scope: scopeState.scope, setScope: vi.fn() }),
  // Render the provider enum as text so tests can assert grouping by provider.
  ProviderBadge: ({ provider }: { provider: string }) => (
    <span data-testid="provider-badge">{provider}</span>
  ),
}));

// Fix round 1 (#1) — o canal padrão ('inst1', o mesmo `defaultInstanceId` em
// todo o arquivo) tem um teto FOLGADO (5000, o máximo de um lote) para não
// interferir nos testes que não são sobre quota. Antes o padrão era "canal
// SEMPRE desconhecido", o que a review apontou como o próprio bug #1: nenhum
// teste existente notava porque `tamanhoInicialDoLote` nunca devolve 0 —
// devolvia "1" para QUALQUER preview, mascarando o defeito.
//
// T15 — a quota agora é parte do MESMO fixture `useProviders()` usado para a
// seleção de canal (antes vivia só em `instancesState`, que só existia
// porque `useInstances()`/EVOLUTION-only era a única fonte da tela).
const DEFAULT_PROVIDERS: {
  providers: { provider: MockProvider; channels: MockChannel[] }[];
} = {
  providers: [
    {
      provider: 'EVOLUTION',
      channels: [
        {
          id: 'inst1',
          name: 'Principal',
          phoneE164: '+5511999999999',
          isActive: true,
          isDefault: true,
          provider: 'EVOLUTION',
          dailySendLimit: 5000,
          sentToday: 0,
          sentTodayResetAt: '2026-08-24T00:00:00.000Z',
        },
      ],
    },
  ],
};

// Stub the heavy filter/preview/schedule children — irrelevant to confirm flow.
// Capture the `value` the FilterBuilder receives so the "load segment" test can
// assert the segment's filters were copied into the advanced builder.
const filterBuilderValues: unknown[] = [];
vi.mock('@/features/campaigns/components/filter-builder', () => ({
  FilterBuilder: ({ value }: { value: unknown }) => {
    filterBuilderValues.push(value);
    return <div data-testid="filter-builder" />;
  },
}));
vi.mock('@/features/campaigns/components/facet-filters', () => ({
  FacetFilters: () => null,
}));
// "Adicionar contato específico" — stubbed like the other FilterStep children
// above; a BUSCA/interação em si (busca, adicionar, remover) é coberta por
// extra-contacts-picker.spec.tsx, e o nó de filtro que ele materializa por
// extra-contacts.spec.ts. Aqui o stub expõe um botão que simula "escolher um
// contato" — o suficiente para provar a COSTURA picker → finalFilters →
// prévia, sem duplicar a busca real.
type StubExtraContact = { id: string; name: string | null; phoneE164: string };
const STUB_EXTRA_CONTACT: StubExtraContact = {
  id: 'extra1',
  name: 'Zeca Avulso',
  phoneE164: '+5592988880000',
};
vi.mock('@/features/campaigns/components/extra-contacts-picker', () => ({
  ExtraContactsPicker: ({
    onChange,
  }: {
    selected: StubExtraContact[];
    onChange: (next: StubExtraContact[]) => void;
  }) => (
    <div data-testid="extra-contacts-picker">
      <button type="button" onClick={() => onChange([STUB_EXTRA_CONTACT])}>
        Adicionar {STUB_EXTRA_CONTACT.name} (stub)
      </button>
    </div>
  ),
}));
// LivePreview reports a non-empty preview up to the parent so the FilterStep
// "Próximo" button is enabled (it gates on a non-zero latestPreview).
// Report via effect (once) — calling setState during render would loop.
vi.mock('@/features/campaigns/components/live-preview', () => ({
  LivePreview: ({
    onPreviewResult,
  }: {
    onPreviewResult: (r: { count: number; sample: unknown[] }) => void;
  }) => {
    useEffect(() => {
      onPreviewResult?.({ count: 3, sample: [] });
    }, [onPreviewResult]);
    return <div data-testid="live-preview" />;
  },
}));
vi.mock('@/features/campaigns/components/active-filter-chips', () => ({
  ActiveFilterChips: () => null,
}));
// F1 T7 — stubbed like the other FilterStep children above; its own behaviour
// (materializing/removing the history node) is covered by
// history-exclusion.spec.ts and history-exclusion-block.spec.tsx.
vi.mock('@/features/campaigns/components/history-exclusion-block', () => ({
  HistoryExclusionBlock: () => <div data-testid="history-exclusion-block" />,
}));
vi.mock('@/features/campaigns/components/schedule-picker', () => ({
  SchedulePicker: () => <div data-testid="schedule-picker" />,
}));

// C1b — finalidades de consentimento (alimentam o seletor do passo 1).
// Estado lido preguiçosamente, como providersState: um teste pode esvaziar a
// lista antes de renderizar.
const purposesState: {
  data:
    | { key: string; label: string; description: string; isSensitive: boolean }[]
    | undefined;
  isLoading: boolean;
} = { data: undefined, isLoading: false };
vi.mock('@/features/consent/api', () => ({
  useConsentPurposes: () => purposesState,
}));

const DEFAULT_PURPOSES = [
  {
    key: 'convite_atividades',
    label: 'Convites para cursos, oficinas e eventos',
    description: 'inscrições, chamadas, mutirões',
    isSensitive: false,
  },
  {
    key: 'captacao_recursos',
    label: 'Campanhas de doação e apoio',
    description: 'arrecadação',
    isSensitive: false,
  },
];

// Segments API: list (picker) + detail (load). Detail is driven per-test.
const segmentDetail = vi.fn();
vi.mock('@/features/segments/api', () => ({
  useSegments: () => ({ data: [{ id: 'seg1', name: 'Andre' }], isLoading: false }),
  useSegment: (id: string | undefined) =>
    id ? { data: segmentDetail(), isFetching: false, refetch: vi.fn() } : { data: undefined, isFetching: false, refetch: vi.fn() },
  useCreateSegment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import {
  Route,
  segmentFiltersToBuilder,
  selectableTemplates,
  templateBlockedReason,
  initialCampaignFilters,
} from './new';

const NewCampaignPage = (Route as unknown as { component: React.ComponentType })
  .component;

const DRAFT_KEY = 'picoa:campaign-wizard-draft';

const PREVIEW: PreviewResult = {
  count: 3,
  sample: [{ id: 'c1', name: 'Ana', phoneE164: '+5511988887777' }],
};

function seedDraftAtConfirmStep(opts: { schedule?: ScheduleConfig } = {}) {
  // Land directly on step 4 (confirm) with an IMMEDIATE schedule by default.
  // Fix round 1 (CRÍTICO) — `schedule` agora é parametrizável: os testes de
  // ONCE_AT/DAILY_AT precisam do MESMO caminho de navegação, só trocando o
  // agendamento.
  sessionStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      step: 4,
      name: 'Campanha X',
      templateId: 'tpl1',
      defaultInstanceId: 'inst1',
      variableMap: { nome: { source: 'field', field: 'name' } },
      filters: {
        combinator: 'and',
        rules: [{ field: 'name', op: 'contains', value: 'a' }],
      },
      schedule: opts.schedule ?? { type: 'IMMEDIATE' },
      presenceDelayMs: 0,
    }),
  );
}

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

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
// Sem estes polyfills o trigger não abre e o teste do seletor de finalidade
// falharia por motivo errado.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  // Achado 4 (review final) — `quotaRestante`/`horaDoReset` agora tratam um
  // `sentTodayResetAt` com mais de 24h como "reset já passado" (sentToday
  // vira 0). Os fixtures deste arquivo usam datas FIXAS de 2026-08-24 — sem
  // travar o relógio, o teste ficaria refém de QUANDO ele roda de verdade
  // (`new Date()` real): passadas 24h do fixture, "quota esgotada" viraria
  // silenciosamente "quota cheia" e o teste do teto passaria a falhar sem
  // que o código tivesse mudado. Só `Date` é congelado — `setTimeout` real
  // continua de pé para o `userEvent` funcionar normalmente.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-24T14:00:00.000Z'));
  sessionStorage.clear();
  templatesState.data = [{ ...DEFAULT_TEMPLATE }];
  purposesState.data = DEFAULT_PURPOSES.map((p) => ({ ...p }));
  purposesState.isLoading = false;
  // Reset the channel source + scope so each test starts from a single
  // Evolution channel ("Principal", id inst1) under the "all" scope unless it
  // opts into a different multi-provider setup.
  providersState.data = {
    providers: DEFAULT_PROVIDERS.providers.map((g) => ({
      ...g,
      channels: g.channels.map((c) => ({ ...c })),
    })),
  };
  providersState.isPending = false;
  providersState.isError = false;
  useProvidersMock.mockClear();
  scopeState.scope = 'all';
  navigateSpy.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  createMutateAsync.mockReset();
  runMutateAsync.mockReset();
  previewMutateAsync.mockReset();
  preflightChecksMutateAsync.mockReset();
  sendBatchMutateAsync.mockReset();
  sendBatchState.isPending = false;

  // step 4 effect recomputes the preview from saved filters.
  previewMutateAsync.mockResolvedValue(PREVIEW);
  // step 4 send-analysis: no blocking checks by default (button stays enabled).
  preflightChecksMutateAsync.mockResolvedValue({
    recipients: 3,
    reachability: { total: 3, reachable: 3, invalid: 0, unknown: 0 },
    checks: [],
  });
  // create always succeeds, returning a DRAFT campaign id.
  createMutateAsync.mockResolvedValue({ id: CREATED_ID });
  // run fails (e.g. instance offline / pacing lock / 5xx) — vestigial for the
  // confirm step itself (A.3 replaced it with the 1º lote), kept because
  // `run.isPending` still feeds the button's disabled/label state.
  runMutateAsync.mockRejectedValue(new Error('run boom'));
  // A.3 — o 1º lote falha por padrão; só os testes que exercitam o caminho
  // de sucesso (A12 happy path, A.3) o sobrescrevem.
  sendBatchMutateAsync.mockRejectedValue(new Error('lote boom'));
});

afterEach(() => {
  vi.useRealTimers();
});

// A.3 — reescrito do cenário A12: o passo final não chama mais `run`
// (enfileirar a base inteira), e sim `sendFirstBatch` (o 1º lote). O caso "cria
// mas não dispara" vira "cria mas o 1º lote não sai" — e a saída muda: o A12
// original ficava no assistente porque a página de detalhe não tinha NENHUMA
// ação de disparo para um DRAFT (navegar para lá era beco sem saída). Agora
// ela tem — `CampaignProgressHeader` ("Enviar próximo lote") atende qualquer
// campanha não-terminal — então o operador vai para lá, com o erro já no
// toast, para retentar de onde essa ação mora de verdade.
describe('NewCampaignPage confirm — A12 create OK + 1º lote falha', () => {
  it('clears the draft, warns the batch did not go out, and sends the operator to the DRAFT detail (the progress header is the retry surface there)', async () => {
    seedDraftAtConfirmStep();
    wrap(<NewCampaignPage />);

    const dispatch = await screen.findByRole('button', {
      name: /Criar e enviar 1º lote/,
    });
    fireEvent.click(dispatch);

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendBatchMutateAsync).toHaveBeenCalledTimes(1));

    // The draft MUST be cleared even though the batch failed (otherwise a
    // re-click creates a second DRAFT).
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();

    // Generic "Falha ao salvar campanha" must NOT be shown (the campaign was
    // saved). A targeted "1º lote não saiu" message must be shown.
    expect(toastError).not.toHaveBeenCalledWith(
      expect.stringMatching(/Falha ao salvar/i),
    );
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/1º lote não saiu/i),
      expect.anything(),
    );

    // Unlike the old `run` (A12): the DRAFT detail page had NO dispatch
    // action back then, so navigating there was a dead end. The detail page
    // now has `CampaignProgressHeader` ("Enviar próximo lote"), which is the
    // ONLY send path and works for ANY non-terminal campaign (DRAFT
    // included, as long as `pending > 0`) — so the operator is sent there,
    // with the error already shown via the toast, to retry from the page
    // that owns that action.
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({
        to: '/campaigns/$campaignId',
        params: { campaignId: CREATED_ID },
      }),
    );
  });

  // DEFENSIVO — depois do fix "navigate-on-failure", o operador não fica mais
  // no assistente após uma falha (ele já foi mandado para o DRAFT, onde o
  // cabeçalho de progresso — "Enviar próximo lote" — é o retry de verdade).
  // Em produção este segundo clique nesta MESMA tela não deveria acontecer.
  // Mas o `navigate` mockado neste arquivo não desmonta o componente de
  // teste, então o guard `createdIdRef` continua
  // sendo exercitável — e vale manter o teste como cinto-de-segurança: se por
  // qualquer motivo (race, back-button) o operador voltar a clicar aqui, o
  // guard ainda não pode duplicar a criação.
  it('[defensivo] mesmo se o operador clicar de novo nesta tela, não cria uma segunda campanha', async () => {
    seedDraftAtConfirmStep();
    wrap(<NewCampaignPage />);

    const dispatch = await screen.findByRole('button', {
      name: /Criar e enviar 1º lote/,
    });

    // First click: create OK, batch fails.
    fireEvent.click(dispatch);
    await waitFor(() => expect(sendBatchMutateAsync).toHaveBeenCalledTimes(1));

    // Operator clicks again to retry the batch.
    fireEvent.click(dispatch);
    await waitFor(() => expect(sendBatchMutateAsync).toHaveBeenCalledTimes(2));

    // create must have run exactly once — the retry reuses the existing id.
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    // The retry reuses the persisted created id and the same suggested size
    // (teto de 5000/dia do canal padrão de DEFAULT_PROVIDERS vs. o preview de
    // 3 → sugere 3).
    expect(sendBatchMutateAsync).toHaveBeenLastCalledWith({
      campaignId: CREATED_ID,
      size: 3,
    });
  });
});

describe('NewCampaignPage confirm — A12 create OK + 1º lote OK (happy path)', () => {
  it('clears the draft and navigates to the new campaign detail on success', async () => {
    sendBatchMutateAsync.mockReset();
    sendBatchMutateAsync.mockResolvedValue({
      batchId: 'b1',
      seq: 1,
      requested: 1,
      queued: 1,
      skipped: 0,
      remaining: 0,
    });
    seedDraftAtConfirmStep();
    wrap(<NewCampaignPage />);

    const dispatch = await screen.findByRole('button', {
      name: /Criar e enviar 1º lote/,
    });
    fireEvent.click(dispatch);

    await waitFor(() => expect(sendBatchMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Lote 1/),
      expect.anything(),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({
        to: '/campaigns/$campaignId',
        params: { campaignId: CREATED_ID },
      }),
    );
  });
});

// --- Characterization: rendered states per step ---------------------------
// These lock the wizard's rendered DOM + navigation so the upcoming
// extraction refactor cannot silently change behaviour.
describe('NewCampaignPage characterization — step rendering & navigation', () => {
  it('step 1 renders the title, name/template fields and the channel picker', async () => {
    wrap(<NewCampaignPage />);

    expect(
      screen.getByRole('heading', { name: /passo 1 de 4/i }),
    ).toBeTruthy();
    expect(screen.getByText('Nome e template')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Boas-vindas alunos/i)).toBeTruthy();
    // Channel row for the seeded "Principal" channel.
    expect(screen.getByText('Principal')).toBeTruthy();
    // "Próximo" is disabled until name + template + channel are set.
    const next = screen.getByRole('button', { name: /Próximo/i });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it('step 1 "Próximo" advances to step 2 once name/template/instance are set', async () => {
    // Seed step 1 with all required fields already set (template selection
    // goes through a Radix portal that jsdom cannot drive). This exercises the
    // same enabled-"Próximo" → setStep(2) navigation handler.
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 1,
        name: 'Minha campanha',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        // C2 — sem finalidade o passo 1 não avança em nenhum provedor.
        purposeKey: 'convite_atividades',
        variableMap: {},
        filters: { combinator: 'and', rules: [] },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
    wrap(<NewCampaignPage />);

    const next = await screen.findByRole('button', { name: /Próximo/i });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);

    expect(
      await screen.findByRole('heading', { name: /passo 2 de 4/i }),
    ).toBeTruthy();
    expect(screen.getByText('Variáveis do template')).toBeTruthy();
  });

  it('step 2 renders the template body and a row per variable', async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 2,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        variableMap: {},
        filters: { combinator: 'and', rules: [] },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
    wrap(<NewCampaignPage />);

    expect(
      await screen.findByRole('heading', { name: /passo 2 de 4/i }),
    ).toBeTruthy();
    // Template body is shown.
    expect(screen.getByText(/Olá/)).toBeTruthy();
    // The {{nome}} variable row label is present.
    expect(screen.getByText('{{nome}}')).toBeTruthy();
    // Back + Próximo controls present.
    expect(screen.getByRole('button', { name: /Voltar/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Próximo/i })).toBeTruthy();
  });

  it('step 2 "Voltar" returns to step 1 and "Próximo" advances to step 3', async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 2,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        // C2 — voltar ao passo 1 e avançar de novo exige a finalidade.
        purposeKey: 'convite_atividades',
        variableMap: {},
        filters: { combinator: 'and', rules: [] },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
    wrap(<NewCampaignPage />);

    await screen.findByRole('heading', { name: /passo 2 de 4/i });
    fireEvent.click(screen.getByRole('button', { name: /Voltar/i }));
    expect(
      await screen.findByRole('heading', { name: /passo 1 de 4/i }),
    ).toBeTruthy();

    // Go forward again and advance to step 3.
    fireEvent.click(screen.getByRole('button', { name: /Próximo/i }));
    await screen.findByRole('heading', { name: /passo 2 de 4/i });
    fireEvent.click(screen.getByRole('button', { name: /Próximo/i }));

    expect(
      await screen.findByRole('heading', { name: /passo 3 de 4/i }),
    ).toBeTruthy();
    expect(screen.getByText('Quem vai receber?')).toBeTruthy();
  });

  it('step 3 (FilterStep) renders the recipients card and advances to step 4 via "Próximo"', async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 3,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        variableMap: { nome: { source: 'field', field: 'name' } },
        filters: {
          combinator: 'and',
          rules: [{ field: 'name', op: 'contains', value: 'a' }],
        },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
    wrap(<NewCampaignPage />);

    expect(
      await screen.findByRole('heading', { name: /passo 3 de 4/i }),
    ).toBeTruthy();
    expect(screen.getByText('Quem vai receber?')).toBeTruthy();
    // LivePreview stub reports count=3 → "Próximo" becomes enabled.
    const next = await screen.findByRole('button', { name: /Próximo: confirmar/i });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);

    expect(
      await screen.findByRole('heading', { name: /passo 4 de 4/i }),
    ).toBeTruthy();
  });

  it('step 4 (confirm) renders count, sample, schedule picker and presence delay', async () => {
    seedDraftAtConfirmStep();
    wrap(<NewCampaignPage />);

    expect(
      await screen.findByRole('heading', { name: /passo 4 de 4/i }),
    ).toBeTruthy();
    // Recipient count from the recomputed preview (3).
    expect(await screen.findByText(/3 destinatários/i)).toBeTruthy();
    // Sample contact name rendered.
    expect(screen.getByText('Ana')).toBeTruthy();
    // SchedulePicker stub + presence-delay select present.
    expect(screen.getByTestId('schedule-picker')).toBeTruthy();
    expect(screen.getByText(/Presença \(digitando/i)).toBeTruthy();
    // A.3 — "Enviar agora" + os dois botões do passo final present.
    expect(screen.getByTestId('first-batch-size')).toBeTruthy();
    expect(screen.getByTestId('create-without-sending')).toBeTruthy();
    expect(screen.getByTestId('create-and-send')).toBeTruthy();
  });
});

// --- F3: multi-provider channel selection ---------------------------------
describe('NewCampaignPage — multi-provider channel selection', () => {
  const TWO_PROVIDERS = {
    providers: [
      {
        provider: 'EVOLUTION' as const,
        channels: [
          {
            id: 'ev1',
            name: 'Evo Um',
            phoneE164: '+5511111111111',
            isActive: true,
            isDefault: true,
            provider: 'EVOLUTION' as const,
          },
        ],
      },
      {
        provider: 'TWILIO' as const,
        channels: [
          {
            id: 'tw1',
            name: 'Twilio Um',
            phoneE164: '+5599999999999',
            isActive: true,
            isDefault: false,
            provider: 'TWILIO' as const,
          },
        ],
      },
    ],
  };

  function seedStep1({
    templateId = 'tpl1',
    defaultInstanceId,
  }: {
    templateId?: string;
    defaultInstanceId: string;
  }) {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 1,
        name: 'Campanha X',
        templateId,
        defaultInstanceId,
        // C2 — a finalidade é obrigatória em QUALQUER provedor: sem ela o passo
        // 1 não avança (o gate de consentimento é por finalidade).
        purposeKey: 'convite_atividades',
        variableMap: {},
        filters: { combinator: 'and', rules: [] },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
  }

  it('groups the channel picker by provider (Evolution + Twilio)', async () => {
    providersState.data = TWO_PROVIDERS;
    wrap(<NewCampaignPage />);

    // Both provider groups render (badge text = provider enum via the mock)…
    expect(screen.getAllByText('EVOLUTION').length).toBeGreaterThan(0);
    expect(screen.getAllByText('TWILIO').length).toBeGreaterThan(0);
    // …and each provider's channel is listed.
    expect(screen.getByText('Evo Um')).toBeTruthy();
    expect(screen.getByText('Twilio Um')).toBeTruthy();
  });

  it('filters the channel picker to the active provider scope', async () => {
    providersState.data = TWO_PROVIDERS;
    scopeState.scope = 'TWILIO';
    wrap(<NewCampaignPage />);

    // Only the scoped provider's channel is shown.
    expect(screen.getByText('Twilio Um')).toBeTruthy();
    expect(screen.queryByText('Evo Um')).toBeNull();
    expect(screen.queryByText('EVOLUTION')).toBeNull();
  });

  it('clears the selected template when switching to a channel of another provider', async () => {
    providersState.data = TWO_PROVIDERS;
    // Start with the template chosen and the Evolution channel selected.
    seedStep1({ defaultInstanceId: 'ev1' });
    wrap(<NewCampaignPage />);

    const next = await screen.findByRole('button', { name: /Próximo/i });
    // name + template + channel all set → enabled.
    await waitFor(() =>
      expect((next as HTMLButtonElement).disabled).toBe(false),
    );

    // Switch to the Twilio channel (a different provider).
    fireEvent.click(screen.getByRole('radio', { name: /Twilio Um/i }));

    // The provider-owned template no longer applies → it is dropped, so
    // "Próximo" is disabled again.
    await waitFor(() =>
      expect((next as HTMLButtonElement).disabled).toBe(true),
    );
    await waitFor(() => {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      expect(JSON.parse(raw as string).templateId).toBe('');
      expect(JSON.parse(raw as string).defaultInstanceId).toBe('tw1');
    });
  });

  it('keeps the selected template when switching between channels of the same provider', async () => {
    providersState.data = {
      providers: [
        {
          provider: 'EVOLUTION' as const,
          channels: [
            {
              id: 'ev1',
              name: 'Evo Um',
              phoneE164: '+5511111111111',
              isActive: true,
              isDefault: true,
              provider: 'EVOLUTION' as const,
            },
            {
              id: 'ev2',
              name: 'Evo Dois',
              phoneE164: '+5522222222222',
              isActive: true,
              isDefault: false,
              provider: 'EVOLUTION' as const,
            },
          ],
        },
      ],
    };
    seedStep1({ defaultInstanceId: 'ev1' });
    wrap(<NewCampaignPage />);

    const next = await screen.findByRole('button', { name: /Próximo/i });
    await waitFor(() =>
      expect((next as HTMLButtonElement).disabled).toBe(false),
    );

    // Switch to another Evolution channel (same provider).
    fireEvent.click(screen.getByRole('radio', { name: /Evo Dois/i }));

    await waitFor(() => {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      expect(JSON.parse(raw as string).defaultInstanceId).toBe('ev2');
    });
    // The template is preserved → "Próximo" stays enabled.
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(
      JSON.parse(sessionStorage.getItem(DRAFT_KEY) as string).templateId,
    ).toBe('tpl1');
  });

  it('shows an empty state with a Canais link when no channel is in scope', async () => {
    // Only Evolution channels exist, but the scope is narrowed to Twilio.
    providersState.data = {
      providers: [TWO_PROVIDERS.providers[0]],
    };
    scopeState.scope = 'TWILIO';
    wrap(<NewCampaignPage />);

    expect(
      screen.getByText(/Nenhum canal no contexto atual/i),
    ).toBeTruthy();
    expect(screen.getByText(/ver Canais/i)).toBeTruthy();
    // No channel radios are rendered.
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

// --- Characterization: draft seed / restore -------------------------------
describe('NewCampaignPage characterization — draft seed/restore & persist', () => {
  it('restores the wizard from a persisted draft (lands on the saved step with saved name)', async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 2,
        name: 'Restaurada',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        variableMap: {},
        filters: { combinator: 'and', rules: [] },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
    wrap(<NewCampaignPage />);

    // Restored straight onto step 2.
    expect(
      await screen.findByRole('heading', { name: /passo 2 de 4/i }),
    ).toBeTruthy();
  });

  it('persists wizard state to sessionStorage as the operator types a name', async () => {
    wrap(<NewCampaignPage />);

    fireEvent.change(screen.getByPlaceholderText(/Boas-vindas alunos/i), {
      target: { value: 'Persistir isto' },
    });

    await waitFor(() => {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string).name).toBe('Persistir isto');
    });
  });

  // B.4 fix — o toggle "Excluir inválidos confirmados" nasce ligado (Task 16),
  // então `filters.rules` NUNCA é []: um assistente intocado já carrega o
  // grupo de exclusão. Sem tratar isso como "vazio", `isEmpty` nunca é
  // verdadeiro numa campanha nova, e um rascunho é gravado (e o aviso de
  // "alterações não salvas" arma) mesmo que o operador só tenha ABERTO a
  // tela e não tenha tocado em nada.
  it('assistente intocado (só com o toggle padrão) NÃO grava rascunho', async () => {
    wrap(<NewCampaignPage />);

    // Espera o mount (e os effects) assentarem antes de checar a ausência.
    await screen.findByRole('heading', { name: /passo 1 de 4/i });

    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

// --- Task 6: load a saved segment's filters into the builder --------------
describe('segmentFiltersToBuilder', () => {
  it("copies a segment's filters into the builder state verbatim", () => {
    const detail = {
      id: 's1',
      filters: {
        combinator: 'or' as const,
        rules: [{ field: 'city' as const, op: 'eq' as const, value: 'Manaus' }],
      },
    };
    expect(segmentFiltersToBuilder(detail)).toEqual(detail.filters);
  });

  it('returns an empty AND group when the segment has no filters', () => {
    expect(segmentFiltersToBuilder({ id: 's1' })).toEqual({
      combinator: 'and',
      rules: [],
    });
  });

  it('returns a fresh object (a deep copy, not the same reference)', () => {
    const detail = {
      id: 's1',
      filters: { combinator: 'and' as const, rules: [] },
    };
    const out = segmentFiltersToBuilder(detail);
    expect(out).toEqual(detail.filters);
    expect(out).not.toBe(detail.filters);
  });
});

// Gate de campanha (twilio-platform T2): o wizard SÓ oferece templates
// APPROVED. PAUSED (novo status — Meta pausou/desabilitou o template),
// REJECTED e PENDING ficam de fora do select.
describe('selectableTemplates — gate APPROVED do wizard', () => {
  const tpl = (id: string, status: string) =>
    ({
      id,
      metaName: `tpl_${status.toLowerCase()}`,
      language: 'pt_BR',
      status,
      body: 'Olá',
      variables: [],
    }) as never;

  it('PAUSED não passa (nem REJECTED, nem PENDING) — só APPROVED', () => {
    const result = selectableTemplates([
      tpl('t1', 'APPROVED'),
      tpl('t2', 'PAUSED'),
      tpl('t3', 'REJECTED'),
      tpl('t4', 'PENDING'),
    ]);
    expect(result.map((t: { id: string }) => t.id)).toEqual(['t1']);
  });

  it('lista undefined → lista vazia', () => {
    expect(selectableTemplates(undefined)).toEqual([]);
  });
});

/**
 * INCIDENTE 2026-08-11 — o cliente tentou criar campanha 8× em 28 minutos e
 * levou `400 campaign.template_consent_buttons_unrecognized` todas as vezes.
 *
 * O gate dos botões (`assertTemplateConsentButtonsUsable`) roda SÓ no
 * `POST /campaigns`. `preview`, `preflight` e `preflight-checks` não olham o
 * template — devolvem 201 e pintam o wizard inteiro de verde. E o wizard
 * filtrava template apenas por `status === 'APPROVED'`, IGNORANDO o
 * `consentButtons.problems` que a mesma resposta de `GET /templates` já traz.
 * Resultado: o sistema sabia desde o primeiro clique que aquele template era
 * indisparável, e só contava no último.
 *
 * O gate está certo e não se enfraquece: no Zernio o clique chega como RÓTULO,
 * e um "sim" de opt-in com rótulo fora da lista fechada gravaria ZERO
 * consentimento em silêncio. O que se conserta é a VISIBILIDADE.
 */
describe('templateBlockedReason — botões ilegíveis, visíveis ANTES do último clique', () => {
  const tpl = (problems: string[]): never =>
    ({
      id: 't1',
      metaName: 'opt_in',
      language: 'pt_BR',
      status: 'APPROVED',
      body: 'Olá',
      variables: [],
      consentButtons: { labels: ['Bora, quero!'], declared: [], problems },
    }) as never;

  it('template com botão não reconhecido tem motivo, e o motivo diz onde consertar', () => {
    const reason = templateBlockedReason(tpl(['O botão 1 não é reconhecido.']));
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/bot(õ|o)es/i);
    expect(reason).toMatch(/Templates/);
  });

  it('template com a lista de problemas VAZIA não é bloqueado', () => {
    expect(templateBlockedReason(tpl([]))).toBeNull();
  });

  it('template sem o campo consentButtons não é bloqueado (só ZERNIO o recebe)', () => {
    expect(templateBlockedReason({ ...DEFAULT_TEMPLATE } as never)).toBeNull();
  });
});

describe('passo 1 — template indisparável não pode ser escolhido às cegas', () => {
  const BLOQUEADO: MockTemplate = {
    id: 'tpl2',
    metaName: 'opt_in_zernio',
    language: 'pt_BR',
    status: 'APPROVED',
    body: 'Aceita receber?',
    variables: [],
    consentButtons: {
      labels: ['Bora, quero!'],
      declared: [],
      problems: ['O botão 1 ("Bora, quero!") não é reconhecido.'],
    },
  };

  it('aparece DESABILITADO no select, com o motivo no próprio rótulo', async () => {
    templatesState.data = [{ ...DEFAULT_TEMPLATE }, { ...BLOQUEADO }];
    wrap(<NewCampaignPage />);

    fireEvent.click(screen.getByRole('combobox', { name: /template/i }));

    const bloqueado = await screen.findByRole('option', {
      name: /opt_in_zernio/i,
    });
    expect(bloqueado).toHaveAttribute('aria-disabled', 'true');
    expect(bloqueado).toHaveTextContent(/bot(õ|o)es/i);

    // O template são continua escolhível — o gate é por template, não global.
    expect(
      await screen.findByRole('option', { name: /boas_vindas/i }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('se ele for o ÚNICO template, o wizard explica em vez de mostrar lista vazia', async () => {
    templatesState.data = [{ ...BLOQUEADO }];
    wrap(<NewCampaignPage />);

    expect(
      screen.getByText(/Classifique os botões na página Templates/i),
    ).toBeInTheDocument();
  });

  /**
   * O bloqueio pode nascer DEPOIS da escolha: um rascunho salvo em
   * sessionStorage guarda o `templateId`, e o papel declarado de um botão cai
   * sozinho quando a Meta reescreve o rótulo (`reconcileConsentButtonRoles`
   * NUNCA inventa papel — rótulo que mudou volta a "não declarado"). Sem esta
   * trava o wizard deixa avançar e o 400 volta a aparecer no último clique.
   */
  it('template que JÁ ESTAVA escolhido e bloqueou trava o "Próximo" e mostra o motivo', async () => {
    templatesState.data = [{ ...BLOQUEADO }];
    // Passo 1 COMPLETO no rascunho: nome, canal e finalidade preenchidos. Assim
    // o único motivo possível para o "Próximo" continuar travado é o template —
    // sem isso o teste passaria por acidente (campo vazio já trava o botão).
    sessionStorage.setItem(
      'picoa:campaign-wizard-draft',
      JSON.stringify({
        step: 1,
        name: 'Campanha X',
        templateId: BLOQUEADO.id,
        defaultInstanceId: 'inst1',
        purposeKey: 'convite_atividades',
        variableMap: {},
        filters: { op: 'AND', rules: [] },
      }),
    );
    wrap(<NewCampaignPage />);

    expect(
      screen.getByText(/Classifique os botões na página Templates/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Próximo/i })).toBeDisabled();
  });
});

describe('FilterStep — load a saved segment', () => {
  beforeEach(() => {
    filterBuilderValues.length = 0;
    segmentDetail.mockReset();
  });

  it('copies the loaded segment filters into the advanced builder on "Carregar"', async () => {
    const SEG_FILTERS = {
      combinator: 'or' as const,
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    };
    segmentDetail.mockReturnValue({
      id: 'seg1',
      name: 'Andre',
      filters: SEG_FILTERS,
    });

    // Land on step 3 (FilterStep).
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 3,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        variableMap: { nome: { source: 'field', field: 'name' } },
        filters: { combinator: 'and', rules: [] },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
    wrap(<NewCampaignPage />);

    await screen.findByText('Quem vai receber?');

    // Pick the segment in the picker.
    fireEvent.change(screen.getByLabelText(/Carregar de um segmento/i), {
      target: { value: 'seg1' },
    });
    // Click "Carregar".
    fireEvent.click(screen.getByRole('button', { name: /^Carregar$/i }));

    // The builder must now render (advanced mode) and receive the segment's
    // filters as its value.
    await waitFor(() =>
      expect(screen.getByTestId('filter-builder')).toBeTruthy(),
    );
    expect(filterBuilderValues).toContainEqual(SEG_FILTERS);
  });
});

/**
 * C1b — o seletor de finalidade.
 *
 * O C1 fez o gate de dispatch exigir consentimento POR FINALIDADE. Sem um
 * seletor no wizard, toda campanha nova nasce com `purposeKey` nulo e o gate
 * (corretamente) pula 100% dos destinatários. Estes testes são o que impede a
 * feature de nascer morta.
 */
describe('C1b — finalidade da campanha (passo 1)', () => {
  const TWILIO_PROVIDERS: typeof DEFAULT_PROVIDERS = {
    providers: [
      {
        provider: 'TWILIO',
        channels: [
          {
            id: 'tw1',
            name: 'Canal Oficial',
            phoneE164: '+559231550103',
            isActive: true,
            isDefault: true,
            provider: 'TWILIO',
          },
        ],
      },
    ],
  };

  /** Preenche nome + template + canal no passo 1 (tudo menos a finalidade). */
  async function fillStep1ExceptPurpose() {
    fireEvent.change(screen.getByPlaceholderText(/Boas-vindas/i), {
      target: { value: 'Campanha X' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: /template/i }));
    fireEvent.click(await screen.findByRole('option', { name: /boas_vindas/i }));
    fireEvent.click(screen.getByRole('radio'));
  }

  it('canal OFICIAL (TWILIO): não avança sem finalidade', async () => {
    providersState.data = TWILIO_PROVIDERS;
    wrap(<NewCampaignPage />);

    await fillStep1ExceptPurpose();

    expect(screen.getByRole('button', { name: /Próximo/i })).toBeDisabled();
  });

  it('escolher a finalidade libera o avanço — as opções vêm do endpoint', async () => {
    providersState.data = TWILIO_PROVIDERS;
    wrap(<NewCampaignPage />);
    await fillStep1ExceptPurpose();

    fireEvent.click(screen.getByRole('combobox', { name: /finalidade/i }));
    fireEvent.click(
      await screen.findByRole('option', { name: /Convites para cursos/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Próximo/i })).toBeEnabled(),
    );
  });

  /**
   * C2 — CORREÇÃO do footgun do C1b. O wizard liberava EVOLUTION sem finalidade
   * ("é o canal legado"), mas o gate de dispatch é o mesmo em todo provedor: sem
   * finalidade, `hasConsent(contact, null)` é falso e a campanha vira 100%
   * SKIPPED_NO_CONSENT — ela nasce, e não envia NADA, em silêncio. A finalidade
   * é obrigatória em QUALQUER provedor.
   */
  it('EVOLUTION também NÃO avança sem finalidade (sem ela o gate pula todo mundo, em silêncio)', async () => {
    wrap(<NewCampaignPage />); // DEFAULT_PROVIDERS = uma conexão EVOLUTION

    await fillStep1ExceptPurpose();

    expect(screen.getByRole('button', { name: /Próximo/i })).toBeDisabled();
    expect(
      screen.getByText(/Selecione a finalidade da campanha/i),
    ).toBeInTheDocument();
  });

  it('EVOLUTION com finalidade escolhida avança normalmente', async () => {
    wrap(<NewCampaignPage />);
    await fillStep1ExceptPurpose();

    fireEvent.click(screen.getByRole('combobox', { name: /finalidade/i }));
    fireEvent.click(
      await screen.findByRole('option', { name: /Convites para cursos/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Próximo/i })).toBeEnabled(),
    );
  });

  it('o rótulo nunca oferece a finalidade como opcional', () => {
    wrap(<NewCampaignPage />);
    expect(screen.queryByText(/opcional neste canal/i)).toBeNull();
  });
});

describe('C1b — a finalidade chega ao backend', () => {
  function seedDraftAtConfirmStepWithPurpose(purposeKey: string) {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 4,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        purposeKey,
        variableMap: { nome: { source: 'field', field: 'name' } },
        filters: {
          combinator: 'and',
          rules: [{ field: 'name', op: 'contains', value: 'a' }],
        },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
  }

  it('a finalidade escolhida entra no payload de criação da campanha', async () => {
    seedDraftAtConfirmStepWithPurpose('captacao_recursos');
    wrap(<NewCampaignPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Criar e enviar 1º lote/ }),
    );

    await waitFor(() =>
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ purposeKey: 'captacao_recursos' }),
      ),
    );
  });

  // C2 — o wizard já não deixa chegar ao passo 4 sem finalidade, mas um rascunho
  // ANTIGO no sessionStorage ainda pode. Nesse caso o payload não pode levar um
  // `purposeKey: ''` (o backend recusaria por "min(1)", com mensagem críptica,
  // em vez do erro de domínio `campaign.purpose_required`).
  it('rascunho antigo sem finalidade: o payload não carrega purposeKey vazio', async () => {
    seedDraftAtConfirmStep();
    wrap(<NewCampaignPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Criar e enviar 1º lote/ }),
    );

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const payload = createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.purposeKey).toBeUndefined();
  });
});

/**
 * O operador precisa ver o custo do gate ANTES de disparar — não depois, na
 * lista de SKIPPED_NO_CONSENT.
 */
describe('C1b — passo 4 mostra quem consentiu para a finalidade', () => {
  function seedConfirmWithPurpose() {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 4,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        purposeKey: 'convite_atividades',
        variableMap: {},
        filters: {
          combinator: 'and',
          rules: [{ field: 'name', op: 'contains', value: 'a' }],
        },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
  }

  it('pede o preflight COM a finalidade e exibe consentiram × serão pulados', async () => {
    seedConfirmWithPurpose();
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 120,
      reachability: { total: 120, reachable: 120, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 42,
        viaOpenWindow: 0,
        eligible: 42,
        withoutConsent: 78,
      },
    });

    wrap(<NewCampaignPage />);

    await waitFor(() =>
      expect(preflightChecksMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ purposeKey: 'convite_atividades' }),
      ),
    );

    expect(await screen.findByTestId('consent-summary')).toHaveTextContent(/42/);
    expect(screen.getByTestId('consent-summary')).toHaveTextContent(/78/);
    // O rótulo da finalidade, não a key — o operador não fala slug.
    expect(screen.getByTestId('consent-summary')).toHaveTextContent(
      /Convites para cursos/i,
    );
  });

  it('ninguém consentiu → aviso explícito de que a campanha não enviaria nada', async () => {
    seedConfirmWithPurpose();
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 120,
      reachability: { total: 120, reachable: 120, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 0,
        viaOpenWindow: 0,
        eligible: 0,
        withoutConsent: 120,
      },
    });

    wrap(<NewCampaignPage />);

    expect(await screen.findByTestId('consent-summary')).toHaveTextContent(
      /Nenhum contato .* pode receber/i,
    );
  });

  /**
   * GATE SILENCIOSO — o aviso existia e era DECORATIVO.
   *
   * O painel de consentimento ficava vermelho, mas `consent.withConsent` nunca
   * entrava no `disabled` do botão. Com 2 contatos e 0 consentimentos o botão
   * "Disparar agora" continuava habilitado, o disparo acontecia, e o sistema
   * ainda dava um toast VERDE de sucesso — foi esse toast que fechou o loop de
   * engano e mandou o operador procurar o bug no agendamento.
   */
  it('ZERO elegíveis → o botão de disparo é BLOQUEADO (não dá para disparar às cegas)', async () => {
    seedConfirmWithPurpose();
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 2,
      reachability: { total: 2, reachable: 2, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 0,
        viaOpenWindow: 0,
        eligible: 0,
        withoutConsent: 2,
      },
    });

    wrap(<NewCampaignPage />);

    await screen.findByTestId('consent-summary');
    // "Criar sem enviar" continua livre (só cria — nada dispara); é o botão
    // de ENVIAR que a análise trava.
    expect(screen.getByTestId('create-and-send')).toBeDisabled();
  });

  it('com elegíveis > 0, o botão de enviar o 1º lote destrava', async () => {
    seedConfirmWithPurpose();
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 3,
      reachability: { total: 3, reachable: 3, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 1,
        viaOpenWindow: 0,
        eligible: 1,
        withoutConsent: 2,
      },
    });

    wrap(<NewCampaignPage />);

    await waitFor(() =>
      expect(screen.getByTestId('create-and-send')).not.toBeDisabled(),
    );
  });

  /*
    O outro lado da moeda — e a regressão que este bloqueio quase introduziu.

    O gate real autoriza por TRÊS caminhos (grant ∪ janela de 24h ∪ override); a
    contagem que trava o botão só conhecia o primeiro. Uma campanha de serviço
    para quem respondeu nas últimas 24h — envio que o gate MANDA sair — apareceria
    como "0 de 12" e ficaria INDISPARÁVEL pela UI. Seria o bug do ticket ao
    contrário: a tela contradizendo o gate.
  */
  it('elegível pela JANELA de 24h (sem opt-in explícito) → o disparo continua liberado', async () => {
    seedConfirmWithPurpose();
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 3,
      reachability: { total: 3, reachable: 3, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'servico_projeto',
        // Ninguém deu opt-in explícito — todos entram pela janela de 24h.
        withConsent: 0,
        viaOpenWindow: 3,
        eligible: 3,
        withoutConsent: 0,
      },
    });

    wrap(<NewCampaignPage />);

    await waitFor(() =>
      expect(screen.getByTestId('create-and-send')).not.toBeDisabled(),
    );
    // E a tela EXPLICA de onde vêm esses 3 (janela, não opt-in).
    expect(screen.getByTestId('consent-summary')).toHaveTextContent(
      /janela de atendimento de 24h/i,
    );
  });

  /*
    Falha de rede no preflight: o botão fica (corretamente) travado — mas travar
    em silêncio é o MESMO bug deste PR, do lado seguro. A tela tem que dizer o que
    houve e oferecer uma saída.
  */
  it('preflight caiu → a tela DIZ que a análise falhou e oferece "Tentar de novo"', async () => {
    seedConfirmWithPurpose();
    preflightChecksMutateAsync.mockRejectedValue(new Error('500'));

    wrap(<NewCampaignPage />);

    expect(await screen.findByTestId('analysis-error')).toHaveTextContent(
      /Não foi possível analisar o envio/i,
    );
    expect(screen.getByTestId('create-and-send')).toBeDisabled();

    // O retry refaz a análise — e, voltando, o disparo destrava.
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 3,
      reachability: { total: 3, reachable: 3, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 3,
        viaOpenWindow: 0,
        eligible: 3,
        withoutConsent: 0,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));

    await waitFor(() =>
      expect(screen.getByTestId('create-and-send')).not.toBeDisabled(),
    );
  });
});

/**
 * CANAL ÚNICO — um canal DESATIVADO não pode sequer ser oferecido.
 *
 * A base tem duas contas Zernio e só UMA pode disparar. Antes, o canal
 * desativado ainda era RENDERIZADO no seletor (opacidade 50%, radio disabled) —
 * e, pior, o auto-select caía nele: os dois últimos fallbacks
 * (`?? channels.find(c => c.isDefault) ?? channels[0]`) não olhavam `isActive`.
 * Um canal desativado podia acabar PRÉ-SELECIONADO no assistente.
 *
 * Numa campanha eleitoral, disparar pelo número errado é irreversível — não
 * existe despublicar mensagem de WhatsApp.
 */
describe('canal desativado não aparece no assistente', () => {
  const DOIS_ZERNIO: typeof DEFAULT_PROVIDERS = {
    providers: [
      {
        provider: 'ZERNIO',
        channels: [
          {
            id: 'proibido',
            name: 'Canal Proibido',
            phoneE164: '+5592945550101',
            isActive: false,
            isDefault: true, // era o default ANTES de ser desativado
            provider: 'ZERNIO',
          },
          {
            id: 'permitido',
            name: 'Canal Permitido',
            phoneE164: '+559231550101',
            isActive: true,
            isDefault: false,
            provider: 'ZERNIO',
          },
        ],
      },
    ],
  };

  it('o canal desativado NÃO é oferecido como opção de envio', () => {
    providersState.data = DOIS_ZERNIO;
    wrap(<NewCampaignPage />);

    expect(screen.queryByText('Canal Proibido')).not.toBeInTheDocument();
    expect(screen.getByText('Canal Permitido')).toBeInTheDocument();
  });

  /**
   * O caso perigoso de verdade. Os dois últimos fallbacks do auto-select
   * (`?? channels.find(c => c.isDefault) ?? channels[0]`) NÃO olhavam isActive —
   * eles só eram alcançados quando nenhum canal estava ativo+com número. É
   * exatamente o estado em que o operador fica depois de desativar o canal
   * proibido e ANTES de terminar de configurar o certo: o assistente
   * PRÉ-SELECIONAVA o canal proibido e deixava disparar por ele.
   */
  it('só há canais DESATIVADOS → nenhum é pré-selecionado (o assistente não oferece saída pelo número errado)', () => {
    providersState.data = {
      providers: [
        {
          provider: 'ZERNIO',
          channels: [
            {
              id: 'proibido',
              name: 'Canal Proibido',
              phoneE164: '+5592945550101',
              isActive: false,
              isDefault: true,
              provider: 'ZERNIO',
            },
          ],
        },
      ],
    };
    wrap(<NewCampaignPage />);

    expect(screen.queryByText('Canal Proibido')).not.toBeInTheDocument();
    const marcado = screen
      .queryAllByRole('radio')
      .find((r) => (r as HTMLInputElement).checked);
    expect(marcado).toBeUndefined();
  });
});

// A.1 — o recorte "os N primeiros" não existe mais na criação.

/**
 * ★ A TELA DE CONFIRMAÇÃO NÃO PODE PROMETER UM NÚMERO E O DISPARO FAZER OUTRO.
 *
 * O painel do passo 3 (LivePreview) já pedia a prévia COM o template, e por
 * isso mostrava "88 contatos" + "412 não entraram". O botão "Próximo", porém,
 * pedia OUTRA prévia sem o template — e era essa (500) que virava o
 * `previewResult` do passo 4: o número do título, o do `SendAnalysisPanel` e o
 * denominador do botão que o operador aperta. A mesma omissão existia na prévia
 * de RECUPERAÇÃO do passo 4 (aba recarregada).
 *
 * É o contrato que a Fase 0 existiu para consertar: a prévia não mente.
 */
describe('confirmação (passo 4) — o número é o que o disparo materializa', () => {
  function seedFilterStep() {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 3,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        purposeKey: 'convite_atividades',
        variableMap: { nome: { source: 'field', field: 'name' } },
        filters: {
          combinator: 'and',
          rules: [{ field: 'name', op: 'contains', value: 'a' }],
        },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
  }

  function seedConfirmStepWithPurpose() {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 4,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        purposeKey: 'convite_atividades',
        variableMap: { nome: { source: 'field', field: 'name' } },
        filters: {
          combinator: 'and',
          rules: [{ field: 'name', op: 'contains', value: 'a' }],
        },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
  }

  it('o "Próximo" do passo 3 pede a prévia COM o template escolhido', async () => {
    seedFilterStep();
    wrap(<NewCampaignPage />);

    const next = await screen.findByRole('button', {
      name: /Próximo: confirmar/i,
    });
    await waitFor(() =>
      expect((next as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(next);

    await waitFor(() => expect(previewMutateAsync).toHaveBeenCalled());
    expect(previewMutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ templateId: 'tpl1' }),
    );
  });

  it('a prévia de RECUPERAÇÃO do passo 4 (aba recarregada) também leva o template', async () => {
    seedConfirmStepWithPurpose();
    wrap(<NewCampaignPage />);

    await waitFor(() => expect(previewMutateAsync).toHaveBeenCalled());
    expect(previewMutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ templateId: 'tpl1' }),
    );
  });

  it('diz, em palavras, quantos não entraram por já estarem em campanha com este template', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [{ id: 'c1', name: 'Ana', phoneE164: '+5511988887777' }],
      excludedSameTemplate: 412,
    });

    wrap(<NewCampaignPage />);

    const aviso = await screen.findByTestId('same-template-exclusion');
    expect(aviso).toHaveTextContent(/412/);
    expect(aviso).toHaveTextContent(/mesmo template/i);
  });

  it('sem ninguém excluído, o aviso não aparece (um "0 excluídos" fixo vira ruído)', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [],
      excludedSameTemplate: 0,
    });

    wrap(<NewCampaignPage />);

    await screen.findByRole('heading', { name: /passo 4 de 4/i });
    expect(screen.queryByTestId('same-template-exclusion')).toBeNull();
  });

  /**
   * A análise de envio (anti-ban + consentimento) roda no backend sobre o
   * FilterGroup cru — sem o template e sem o limite. Com a exclusão ativa, o
   * `eligible` que volta pode ser MAIOR que a audiência que existirá de fato, e
   * o botão chegava a prometer "500 de 88". O número do botão é o que o
   * operador lê no instante do clique: ele não pode passar do teto real.
   */
  it('o botão não promete mais gente do que a audiência real', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [],
      excludedSameTemplate: 412,
    });
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 500,
      reachability: { total: 500, reachable: 500, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 500,
        viaOpenWindow: 0,
        eligible: 500,
        withoutConsent: 0,
      },
    });

    wrap(<NewCampaignPage />);

    // A.3 — o número "quantos vão receber de verdade" não está mais NO BOTÃO
    // (que agora mostra o tamanho do lote, não a contagem de consentimento);
    // continua no painel de consentimento, que é o que este teste protege.
    const box = await screen.findByTestId('consent-summary');
    await waitFor(() =>
      expect(box.textContent ?? '').toMatch(/vão receber/),
    );
    expect(box.textContent ?? '').not.toMatch(/500 vão receber/);
    expect(box.textContent ?? '').toMatch(/88 vão receber/);
  });

  it('avisa que os números da análise foram calculados ANTES da exclusão', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [],
      excludedSameTemplate: 412,
    });
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 500,
      reachability: { total: 500, reachable: 500, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 300,
        viaOpenWindow: 0,
        eligible: 300,
        withoutConsent: 200,
      },
    });

    wrap(<NewCampaignPage />);

    const aviso = await screen.findByTestId('analysis-audience-caveat');
    // O tamanho da audiência SOBRE A QUAL a análise foi feita é o `recipients`
    // que o próprio preflight devolveu — não a soma 88 + 412 (que só coincide
    // quando não há limite; ver send-analysis-panel.spec.tsx).
    expect(aviso).toHaveTextContent(/500/);
    // ...e para quantos o disparo vai de fato.
    expect(aviso).toHaveTextContent(/88/);
  });
});

/**
 * ★ SEGUNDA RODADA — A MESMA DOENÇA, NOS DOIS LUGARES QUE SOBRARAM.
 *
 * O `preflight-checks` mede consentimento, volume e alcançabilidade sobre o
 * FilterGroup CRU: sem o limite "os N primeiros" e sem a exclusão "já está em
 * campanha com este template". O `preview` (que alimenta o passo 4) já aplica
 * os dois. Quando os dois números divergem, a tela não pode:
 *   a) imprimir `consent.eligible` cru com o verbo "vão receber" — é a promessa
 *      mais forte da tela, no card onde o operador aperta o botão;
 *   b) esconder o descasamento atrás de um Math.min sem acender a explicação —
 *      "500 de 500" é plausível, lê-se como "todo mundo aqui recebe" e é falso.
 *
 * Precedente caro: 2026-08-11, uma recusa sem explicação custou oito tentativas
 * cegas numa tarde.
 */
describe('confirmação (passo 4) — quando a análise e o disparo medem audiências diferentes', () => {
  function seedConfirmStepWithPurpose() {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 4,
        name: 'Campanha X',
        templateId: 'tpl1',
        defaultInstanceId: 'inst1',
        purposeKey: 'convite_atividades',
        variableMap: { nome: { source: 'field', field: 'name' } },
        filters: {
          combinator: 'and',
          rules: [{ field: 'name', op: 'contains', value: 'a' }],
        },
        schedule: { type: 'IMMEDIATE' },
        presenceDelayMs: 0,
      }),
    );
  }

  it('o box de consentimento não promete o número do filtro como "vão receber"', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [],
      excludedSameTemplate: 412,
    });
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 500,
      reachability: { total: 500, reachable: 500, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 500,
        viaOpenWindow: 0,
        eligible: 500,
        withoutConsent: 0,
      },
    });

    wrap(<NewCampaignPage />);

    const box = await screen.findByTestId('consent-summary');
    // "500 de 500 contatos vão receber" logo abaixo de "Confirmar — 88
    // destinatários" é a contradição inteira numa tela só.
    expect(box.textContent ?? '').not.toMatch(/500 de 500 contatos vão receber/);
    // E o box tem de dizer para quantos esta campanha vai de verdade.
    expect(box).toHaveTextContent(/88/);
  });

  /**
   * Cenário do revisor: filtro de 13000, limite 500, metade sem consentimento,
   * NENHUMA exclusão por template. Antes: "Disparar agora — 6500 de 500"
   * (absurdo, mas faz parar). Com o Math.min sozinho: "500 de 500" (plausível e
   * falso — o disparo entregaria ~250) e nenhum aviso.
   */
  it('com só o limite recortando, o aviso aparece e o botão não promete exatidão', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 500,
      sample: [],
      excludedSameTemplate: 0,
    });
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 13000,
      reachability: { total: 13000, reachable: 13000, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 6500,
        viaOpenWindow: 0,
        eligible: 6500,
        withoutConsent: 6500,
      },
    });

    wrap(<NewCampaignPage />);

    const aviso = await screen.findByTestId('analysis-audience-caveat');
    expect(aviso).toHaveTextContent(/13000/);

    // A.3 — o número "quantos vão receber de verdade" não está mais no
    // botão (que agora mostra o tamanho do LOTE, não a contagem de
    // consentimento); continua no painel de consentimento, que segue sem
    // afirmar uma exatidão que não existe.
    const box = screen.getByTestId('consent-summary');
    expect(box.textContent ?? '').not.toMatch(/— 500 vão receber/);
    expect(box.textContent ?? '').toMatch(/entre 0 e 500/);
  });

  it('quando a análise mediu a mesma audiência do disparo, o número é exato e sem ressalva', async () => {
    seedConfirmStepWithPurpose();
    previewMutateAsync.mockResolvedValue({
      count: 120,
      sample: [],
      excludedSameTemplate: 0,
    });
    preflightChecksMutateAsync.mockResolvedValue({
      recipients: 120,
      reachability: { total: 120, reachable: 120, invalid: 0, unknown: 0 },
      checks: [],
      consent: {
        purposeKey: 'convite_atividades',
        withConsent: 90,
        viaOpenWindow: 0,
        eligible: 90,
        withoutConsent: 30,
      },
    });

    wrap(<NewCampaignPage />);

    await waitFor(() =>
      expect(screen.getByTestId('create-and-send')).not.toBeDisabled(),
    );
    expect(screen.queryByTestId('analysis-audience-caveat')).toBeNull();
    expect(screen.getByTestId('consent-summary')).toHaveTextContent(
      /90 de 120 contatos vão receber/,
    );
  });
});

/**
 * Navega até o passo 3 (Quem vai receber?) preenchendo nome + template +
 * canal + finalidade no passo 1 e clicando em "Próximo" até chegar lá — o
 * mesmo caminho que o operador percorre de verdade, em vez de semear o
 * rascunho já no passo 3.
 */
function renderWizardAtFilterStep() {
  sessionStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      step: 1,
      name: 'Campanha X',
      templateId: 'tpl1',
      defaultInstanceId: 'inst1',
      purposeKey: 'convite_atividades',
      variableMap: {},
      filters: { combinator: 'and', rules: [] },
      schedule: { type: 'IMMEDIATE' },
      presenceDelayMs: 0,
    }),
  );
  wrap(<NewCampaignPage />);
  fireEvent.click(screen.getByRole('button', { name: /Próximo/i }));
  fireEvent.click(screen.getByRole('button', { name: /Próximo/i }));
}

/**
 * A partir do passo 3 (`renderWizardAtFilterStep`), encontra e clica o
 * "Próximo" que avança ao passo 4 — o texto muda para "Próximo: confirmar N"
 * assim que a prévia estubada de `LivePreview` resolve (ver
 * vi.mock('.../live-preview')). Mesmo padrão do describe 'confirmação (passo
 * 4) — o número é o que o disparo materializa' (abaixo).
 */
async function avancarAoPasso4() {
  const next = await screen.findByRole('button', { name: /Próximo/i });
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(next);
}

/**
 * A.2 — O CAMPO QUE CAUSAVA O PROBLEMA SAIU DA TELA.
 *
 * "Limitar aos primeiros N" recorta sempre as MESMAS N pessoas mais antigas,
 * antes de qualquer exclusão. Era a armadilha (b) do diagnóstico: o cliente
 * mandava "para o restante" e caía em cima de quem já tinha recebido.
 */
describe('A.2 — o wizard não oferece mais "Limitar aos primeiros"', () => {
  it('o campo não existe no passo do público', async () => {
    renderWizardAtFilterStep();
    expect(screen.queryByTestId('audience-limit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audience-limit-hint')).not.toBeInTheDocument();
  });
});

/**
 * Pousa direto no passo 4 com um rascunho pronto — o mesmo caminho das outras
 * suítes de confirmação deste arquivo (`seedDraftAtConfirmStep` /
 * `seedConfirmStepWithPurpose`). A prévia vem de `previewMutateAsync` (o
 * efeito de RECUPERAÇÃO do passo 4, que roda ao pousar direto nele): o stub de
 * `LivePreview` só alimenta o botão "Próximo" do passo 3, que este caminho
 * nem passa por.
 */
async function renderWizardAtConfirmStep({
  previewCount,
  schedule,
}: {
  previewCount: number;
  /** Fix round 1 (CRÍTICO) — para o teste de DAILY_AT (recorrente: continua
   *  mostrando o campo/lote). Um schedule ONCE_AT não usa este helper — ele
   *  esconde o campo "Enviar agora" inteiro, então `first-batch-size` nunca
   *  aparece. */
  schedule?: ScheduleConfig;
}) {
  seedDraftAtConfirmStep({ schedule });
  previewMutateAsync.mockResolvedValue({ count: previewCount, sample: [] });
  wrap(<NewCampaignPage />);
  await screen.findByTestId('first-batch-size');
}

/**
 * T15 — substitui `instancesState.data = [...]` (EVOLUTION-only) pelo mesmo
 * `providersState` que já alimenta a seleção de canal. GOZAP de propósito: é
 * o cenário REAL de produção — `useInstances()` nunca via este canal.
 */
function setCanalGozap(over: Partial<MockChannel> = {}) {
  providersState.data = {
    providers: [
      {
        provider: 'GOZAP',
        channels: [
          {
            id: 'inst1',
            name: 'robo',
            phoneE164: '+559231550101',
            isActive: true,
            isDefault: true,
            provider: 'GOZAP',
            dailySendLimit: 500,
            sentToday: 120,
            sentTodayResetAt: '2026-08-24T13:00:00.000Z',
            ...over,
          },
        ],
      },
    ],
  };
}

/**
 * A.3 — "DISPARAR" DEIXA DE SIGNIFICAR "ENFILEIRAR A BASE INTEIRA".
 *
 * O passo final agora cria a campanha e manda o 1º LOTE, dimensionado pelo teto
 * de hoje do canal. É a decisão 2 da spec: nunca a base inteira por padrão.
 */
describe('A.3 — passo final: criar + 1º lote', () => {
  beforeEach(() => {
    sendBatchMutateAsync.mockReset();
    sendBatchMutateAsync.mockResolvedValue({
      batchId: 'b1',
      seq: 1,
      requested: 380,
      queued: 380,
      skipped: 0,
      remaining: 12520,
    });
    setCanalGozap();
  });

  it('o campo "Enviar agora" nasce com min(quota restante, público)', async () => {
    await renderWizardAtConfirmStep({ previewCount: 13400 });
    expect(screen.getByTestId('first-batch-size')).toHaveValue(380);
  });

  /**
   * Fix round 1 (#2, review Opus) — `useProviders()` é `staleTime: Infinity`
   * (a lista de provedores só muda no redeploy). Sem `refetchOnMount:
   * 'always'`, este passo proporia o 1º lote a partir de um `sentToday` que
   * o passo 1 (ou o topbar) buscou minutos/horas atrás — não o teto de hoje
   * de verdade.
   */
  it('chama useProviders com refetchOnMount:"always" (quota fresca no passo final)', async () => {
    await renderWizardAtConfirmStep({ previewCount: 13400 });
    const chamouComRefetchOnMount = useProvidersMock.mock.calls.some(
      ([opts]) => (opts as { refetchOnMount?: string } | undefined)?.refetchOnMount === 'always',
    );
    expect(chamouComRefetchOnMount).toBe(true);
  });

  it('com o público menor que a quota, nasce com o público', async () => {
    await renderWizardAtConfirmStep({ previewCount: 40 });
    expect(screen.getByTestId('first-batch-size')).toHaveValue(40);
  });

  /**
   * ★ NUNCA UM CAMPO COM 0. Teto esgotado é a hora em que o operador MAIS
   * precisa de um número — e de saber que o lote sai sozinho no reset.
   */
  it('com o teto de hoje esgotado, nasce com o teto diário inteiro e avisa', async () => {
    setCanalGozap({ sentToday: 500 });
    await renderWizardAtConfirmStep({ previewCount: 13400 });
    expect(screen.getByTestId('first-batch-size')).toHaveValue(500);
    // Texto exato de `avisoDeQuota` (channel-quota.ts, T6 — já testado em
    // channel-quota.spec.ts): "O teto de hoje deste canal acabou: este lote
    // fica em fila e sai a partir de {reset}."
    expect(screen.getByTestId('first-batch-notice').textContent).toContain(
      'teto de hoje deste canal acabou',
    );
  });

  it('acima da quota, avisa mas não bloqueia', async () => {
    const user = userEvent.setup();
    await renderWizardAtConfirmStep({ previewCount: 13400 });
    const campo = screen.getByTestId('first-batch-size');
    await user.clear(campo);
    await user.type(campo, '900');
    // Texto exato de `avisoDeQuota`: "Acima do teto de hoje: N ficam em
    // fila e saem a partir de {reset}."
    expect(screen.getByTestId('first-batch-notice').textContent).toContain(
      'Acima do teto de hoje',
    );
    expect(screen.getByTestId('create-and-send')).not.toBeDisabled();
  });

  it('"Criar e enviar 1º lote" cria e chama o lote com o tamanho escolhido', async () => {
    const user = userEvent.setup();
    await renderWizardAtConfirmStep({ previewCount: 13400 });
    await user.click(screen.getByTestId('create-and-send'));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({ limit: expect.anything() }),
    );
    expect(sendBatchMutateAsync).toHaveBeenCalledWith({
      campaignId: CREATED_ID,
      size: 380,
    });
    expect(runMutateAsync).not.toHaveBeenCalled();
  });

  /**
   * Minor 8 (review final) — "Criar e enviar 1º lote — 1000" (número cru,
   * sem separador de milhar) ao lado de "Restam 12.900" (já formatado em
   * pt-BR) na MESMA tela. O botão tem de usar a mesma régua.
   */
  it('o botão mostra o tamanho do lote formatado em pt-BR (milhar com ponto)', async () => {
    setCanalGozap({ dailySendLimit: 5000, sentToday: 0 });
    await renderWizardAtConfirmStep({ previewCount: 13400 });

    expect(
      screen.getByRole('button', { name: /Criar e enviar 1º lote — 5\.000$/ }),
    ).toBeInTheDocument();
  });

  it('"Criar sem enviar" NÃO chama o lote', async () => {
    const user = userEvent.setup();
    await renderWizardAtConfirmStep({ previewCount: 13400 });
    await user.click(screen.getByTestId('create-without-sending'));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(sendBatchMutateAsync).not.toHaveBeenCalled();
    expect(runMutateAsync).not.toHaveBeenCalled();
  });

  /**
   * Fix round 1 (#3) — `useInstances()` faz polling a cada 30s. Sem a flag
   * `tocado`, um recálculo de `sugerido` NO MEIO do preenchimento (o operador
   * decidiu mandar mais do que a sugestão, por exemplo) apagava o número dele
   * em silêncio — o pior tipo de bug de formulário: o campo muda sozinho.
   */
  it('depois que o operador digita, um recálculo da sugestão não sobrescreve o campo', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedDraftAtConfirmStep();
    previewMutateAsync.mockResolvedValue({ count: 13400, sample: [] });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <NewCampaignPage />
      </QueryClientProvider>,
    );
    await screen.findByTestId('first-batch-size');
    expect(screen.getByTestId('first-batch-size')).toHaveValue(380);

    const campo = screen.getByTestId('first-batch-size');
    await user.clear(campo);
    await user.type(campo, '2000');
    expect(campo).toHaveValue(2000);

    // O "poll" muda a quota do canal — a sugestão MUDARIA (450, não mais
    // 380) se o efeito de sincronização rodasse de novo.
    setCanalGozap({ sentToday: 50 });
    rerender(
      <QueryClientProvider client={qc}>
        <NewCampaignPage />
      </QueryClientProvider>,
    );

    // O campo continua com o que o operador digitou — não com a nova sugestão.
    expect(screen.getByTestId('first-batch-size')).toHaveValue(2000);
  });
});

/**
 * Fix round 1 (#1) — CANAL DESCONHECIDO NÃO PODE VIRAR "SUGERE 1".
 *
 * `tamanhoInicialDoLote` nunca devolve 0 com público > 0 (★ NUNCA UM CAMPO COM
 * 0, channel-quota.ts) — uma regra pensada para "quota esgotada de verdade".
 * Aplicada a um canal que a tela simplesmente ainda não CONHECE (carregando,
 * sem correspondência na lista, ou uma falha ao consultar `useProviders()`),
 * ela produzia "1" do nada: o assistente oferecia e mandava 1 mensagem sem
 * saber se aquele canal tinha QUALQUER quota. Enquanto o canal não é
 * conhecido, o campo fica vazio e o botão de enviar trava — com um estado
 * explícito (`resolveCampaignChannel`, T15), não um silêncio.
 */
describe('Fix round 1 (#1) — canal ainda não carregou (ou é desconhecido)', () => {
  it('canal ainda carregando: campo vazio, aviso explícito, botão de enviar travado', async () => {
    providersState.isPending = true;
    providersState.data = undefined;
    seedDraftAtConfirmStep();
    previewMutateAsync.mockResolvedValue({ count: 13400, sample: [] });
    wrap(<NewCampaignPage />);

    await screen.findByTestId('first-batch-size');
    expect((screen.getByTestId('first-batch-size') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Carregando o teto do canal/i)).toBeTruthy();
    expect(screen.getByTestId('create-and-send')).toBeDisabled();
    // "Criar sem enviar" continua livre — só cria, nada depende da quota.
    expect(screen.getByTestId('create-without-sending')).not.toBeDisabled();
  });

  it('canal não encontrado na lista: campo vazio, aviso explícito, botão de enviar travado', async () => {
    providersState.isPending = false;
    providersState.data = { providers: [{ provider: 'GOZAP', channels: [] }] };
    seedDraftAtConfirmStep();
    previewMutateAsync.mockResolvedValue({ count: 13400, sample: [] });
    wrap(<NewCampaignPage />);

    await screen.findByTestId('first-batch-size');
    expect((screen.getByTestId('first-batch-size') as HTMLInputElement).value).toBe('');
    expect(
      screen.getByText(/O canal desta campanha não foi encontrado — verifique em Canais/i),
    ).toBeTruthy();
    expect(screen.getByTestId('create-and-send')).toBeDisabled();
    expect(screen.getByTestId('create-without-sending')).not.toBeDisabled();
  });

  /**
   * T15 — uma FALHA DE REDE na consulta de canais não pode virar "Canal não
   * encontrado": são causas diferentes (rede caída vs. canal que realmente
   * não existe) e pedem respostas diferentes do operador.
   */
  it('consulta de canais falhou: campo vazio, aviso de erro (nunca "canal não encontrado"), botão travado', async () => {
    providersState.isPending = false;
    providersState.isError = true;
    providersState.data = undefined;
    seedDraftAtConfirmStep();
    previewMutateAsync.mockResolvedValue({ count: 13400, sample: [] });
    wrap(<NewCampaignPage />);

    await screen.findByTestId('first-batch-size');
    expect((screen.getByTestId('first-batch-size') as HTMLInputElement).value).toBe('');
    expect(
      screen.getByText(/Não deu para consultar os canais — tente de novo/i),
    ).toBeTruthy();
    expect(screen.queryByText(/canal não foi encontrado/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('create-and-send')).toBeDisabled();
    expect(screen.getByTestId('create-without-sending')).not.toBeDisabled();
  });
});

/**
 * Fix round 1 (#2) — O LOTE EM VOO TAMBÉM PRECISA TRAVAR OS BOTÕES.
 *
 * `create.isPending` volta a `false` assim que o create resolve — mas o
 * `sendFirstBatch.mutateAsync` só começa DEPOIS disso. Nessa janela (curta,
 * mas real: uma rede lenta a alarga), os dois botões liam só `create.isPending`
 * e reabilitavam, permitindo um segundo clique disparar um SEGUNDO
 * `sendFirstBatch` para a MESMA campanha antes do primeiro terminar.
 */
describe('Fix round 1 (#2) — o lote em voo trava os dois botões', () => {
  it('com sendFirstBatch.isPending, os dois botões ficam desabilitados e o rótulo muda', async () => {
    sendBatchState.isPending = true;
    await renderWizardAtConfirmStep({ previewCount: 13400 });

    expect(screen.getByTestId('create-and-send')).toBeDisabled();
    expect(screen.getByTestId('create-without-sending')).toBeDisabled();
    expect(screen.getByTestId('create-and-send')).toHaveTextContent(
      'Enviando 1º lote…',
    );
  });
});

/**
 * Fix round 1 (CRÍTICO) — UM AGENDAMENTO ÚNICO E FUTURO NÃO VIRA ENVIO AGORA.
 *
 * A 1ª rodada apagou o branch que preservava ONCE_AT ("Enviar uma vez em
 * 20/09 09:00"): o único botão do passo final chamava `sendFirstBatch` na
 * hora, para QUALQUER schedule — e `campaigns.service.ts` (`sendBatch` →
 * `disarmSchedule: !isRecurring`) desarma o agendamento ao enviar. Um
 * operador que escolhesse "agendar" veria a campanha inteira sair NA HORA, e
 * a data escolhida jogada fora sem aviso — o oposto do que ele pediu.
 *
 * DAILY_AT/WEEKLY/INTERVAL são RECORRENTES: o 1º lote sai agora (como
 * IMMEDIATE) e o agendamento continua armado para os próximos — por isso
 * eles seguem o caminho normal do A.3, e só ONCE_AT precisa do desvio.
 */
describe('Fix round 1 (CRÍTICO) — agendamento (ONCE_AT) nunca dispara na hora', () => {
  it('ONCE_AT: cria e agenda, NUNCA manda o 1º lote — botão "Agendar campanha"', async () => {
    seedDraftAtConfirmStep({
      schedule: { type: 'ONCE_AT', runAt: '2026-09-20T13:00:00.000Z' },
    });
    previewMutateAsync.mockResolvedValue({ count: 13400, sample: [] });
    wrap(<NewCampaignPage />);

    // O campo "Enviar agora" nem aparece — não há "quanto enviar agora" para
    // um agendamento que, por definição, não é para agora.
    await screen.findByRole('button', { name: /Agendar campanha/ });
    expect(screen.queryByTestId('first-batch-size')).toBeNull();
    expect(screen.queryByTestId('create-and-send')).toBeNull();
    expect(screen.queryByTestId('create-without-sending')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Agendar campanha/ }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(sendBatchMutateAsync).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Campanha agendada/i),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({
        to: '/campaigns/$campaignId',
        params: { campaignId: CREATED_ID },
      }),
    );
  });

  it('DAILY_AT: continua o comportamento novo — cria, manda o 1º lote agora, e o agendamento segue armado', async () => {
    const user = userEvent.setup();
    // Canal padrão de DEFAULT_PROVIDERS (dailySendLimit 5000, sentToday 0) —
    // este describe não tem beforeEach próprio, então roda com o canal
    // padrão global.
    await renderWizardAtConfirmStep({
      previewCount: 13400,
      schedule: { type: 'DAILY_AT', time: '09:00' },
    });

    // O campo/lote continuam visíveis — DAILY_AT não é "agendamento único".
    // 5000 = teto do canal padrão, menor que o público de 13400.
    expect(screen.getByTestId('first-batch-size')).toHaveValue(5000);
    await user.click(screen.getByTestId('create-and-send'));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    // `schedule` vai para o create tal como o operador escolheu — o backend
    // é quem mantém o agendamento armado para campanhas recorrentes
    // (`disarmSchedule: !isRecurring`, `campaigns.service.ts`).
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: { type: 'DAILY_AT', time: '09:00' } }),
    );
    expect(sendBatchMutateAsync).toHaveBeenCalledWith({
      campaignId: CREATED_ID,
      size: 5000,
    });
  });
});

describe('Assistente — "Excluir inválidos confirmados" ligado por padrão (B.4)', () => {
  it('campanha NOVA já nasce com o grupo de exclusão no filtro efetivo', () => {
    const filtros = initialCampaignFilters(undefined);
    expect(hasExcludeInvalid(filtros)).toBe(true);
  });

  // Uma campanha/segmento que já existe NÃO é retro-modificada: o operador
  // salvou aquele recorte e ele não pode mudar de público sozinho.
  it('filtro carregado de campanha existente passa intacto', () => {
    const salvo = {
      combinator: 'and' as const,
      rules: [{ field: 'city' as const, op: 'eq' as const, value: 'Manaus' }],
    };
    expect(initialCampaignFilters(salvo)).toEqual(salvo);
  });
});

/**
 * Pedido do cliente (2026-08-25) — o operador confirma, ao criar a campanha,
 * que concorda com a janela de horário comercial (8h–20h) do canal. Ligado
 * por padrão; o operador pode desligar.
 */
describe('Assistente — "Enviar apenas em horário comercial" (passo 4)', () => {
  it('nasce LIGADO e vai no payload de criação como respeitarJanelaDeEnvio: true', async () => {
    const user = userEvent.setup();
    await renderWizardAtConfirmStep({ previewCount: 3400 });

    const toggle = screen.getByRole('checkbox', {
      name: /Enviar apenas em horário comercial/i,
    });
    expect(toggle).toBeChecked();

    await user.click(screen.getByTestId('create-and-send'));

    await waitFor(() =>
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ respeitarJanelaDeEnvio: true }),
      ),
    );
  });

  it('desligado pelo operador, vai no payload como respeitarJanelaDeEnvio: false', async () => {
    const user = userEvent.setup();
    await renderWizardAtConfirmStep({ previewCount: 3400 });

    const toggle = screen.getByRole('checkbox', {
      name: /Enviar apenas em horário comercial/i,
    });
    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    await user.click(screen.getByTestId('create-and-send'));

    await waitFor(() =>
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ respeitarJanelaDeEnvio: false }),
      ),
    );
  });
});

/**
 * ★ Pedido do cliente 2026-08-25 — "excluir quem já recebeu parece não
 * funcionar". O backend ganhou `excludeAnyPreviousCampaign`
 * (`backend/src/schemas/contracts/campaign.schema.ts:77` no preview e `:162`
 * no create) e o serviço já percorre `resolveAudience`, os quatro caminhos de
 * disparo e a prévia — mas `grep -rn "excludeAnyPreviousCampaign" frontend/src`
 * não devolvia NADA: o assistente nunca enviava o campo, toda campanha nascia
 * `false` e a correção era inalcançável pelo operador. Este describe fecha
 * essa lacuna.
 */
describe('Assistente — "Excluir quem já recebeu qualquer campanha anterior" (passo 3)', () => {
  it('a opção existe como checkbox e nasce DESLIGADA', () => {
    renderWizardAtFilterStep();
    expect(
      screen.getByRole('checkbox', { name: /qualquer campanha anterior/i }),
    ).not.toBeChecked();
  });

  it('(c) desligada (padrão): a PRÉVIA do "Próximo" leva excludeAnyPreviousCampaign: false', async () => {
    renderWizardAtFilterStep();

    await avancarAoPasso4();

    await waitFor(() =>
      expect(previewMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAnyPreviousCampaign: false }),
      ),
    );
  });

  it('(c) desligada (padrão): o create final vai com excludeAnyPreviousCampaign: false', async () => {
    const user = userEvent.setup();
    await renderWizardAtConfirmStep({ previewCount: 3400 });

    await user.click(screen.getByTestId('create-and-send'));

    await waitFor(() =>
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAnyPreviousCampaign: false }),
      ),
    );
  });

  it('(a) ligada pelo operador: a PRÉVIA do "Próximo" (passo 3) leva excludeAnyPreviousCampaign: true', async () => {
    const user = userEvent.setup();
    renderWizardAtFilterStep();

    await user.click(
      screen.getByRole('checkbox', { name: /qualquer campanha anterior/i }),
    );
    await avancarAoPasso4();

    await waitFor(() =>
      expect(previewMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAnyPreviousCampaign: true }),
      ),
    );
  });

  it('(b) ligada pelo operador: o create final vai com excludeAnyPreviousCampaign: true', async () => {
    const user = userEvent.setup();
    renderWizardAtFilterStep();

    await user.click(
      screen.getByRole('checkbox', { name: /qualquer campanha anterior/i }),
    );
    await avancarAoPasso4();
    await screen.findByTestId('first-batch-size');

    await user.click(screen.getByTestId('create-and-send'));

    await waitFor(() =>
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAnyPreviousCampaign: true }),
      ),
    );
  });

  /**
   * (d) `send-analysis-panel.tsx:100-101` afirmava "este mesmo template"
   * incondicionalmente. Ligada a opção, isso vira falso — o painel de
   * análise (passo 4) tem de trocar a frase. Escopado com `within` porque
   * `SameTemplateExclusionNotice` (componente IRMÃO, fora do escopo desta
   * tarefa) também menciona "mesmo template" na mesma tela.
   */
  it('(d) ligada, o painel de análise troca "este mesmo template" por "alguma campanha anterior"', async () => {
    const user = userEvent.setup();
    previewMutateAsync.mockResolvedValue({
      count: 88,
      sample: [],
      excludedSameTemplate: 412,
    });
    renderWizardAtFilterStep();

    await user.click(
      screen.getByRole('checkbox', { name: /qualquer campanha anterior/i }),
    );
    await avancarAoPasso4();
    await screen.findByTestId('first-batch-size');

    const panel = await screen.findByTestId('send-analysis');
    expect(
      within(panel).getByText(/já receberam alguma campanha anterior/i),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText(/este mesmo template/i),
    ).not.toBeInTheDocument();
  });
});

/**
 * Pedido do cliente (2026-08-25) — "explicar como funciona o filtro modo
 * Avançado". O texto (regra vs. grupo, exemplo com E/OU) já existe na tela;
 * esta suíte fecha a lacuna de cobertura apontada no plano da Fase D (§6.2)
 * — sem ela, um refactor do `FilterStep` pode devolver o texto antigo em
 * silêncio.
 */
describe('Assistente — explicação do modo avançado (passo 3)', () => {
  it('ao entrar no modo avançado, explica regra vs. grupo e mostra um exemplo com E/OU', async () => {
    const user = userEvent.setup();
    renderWizardAtFilterStep();

    await user.click(
      screen.getByRole('button', { name: /Modo avançado \(AND\/OR\)/i }),
    );

    expect(screen.getByText(/é um critério isolado/i)).toBeInTheDocument();
    expect(screen.getByText(/reúne regras/i)).toBeInTheDocument();
    // `getByText(/Voluntários/)` bateria em DOIS nós (o `<span
    // class="font-mono">` do exemplo e o "(Voluntários ou Doadores)" em texto
    // corrido) — regex mais específica para casar só o `<span>` do exemplo.
    expect(screen.getByText(/grupo = Voluntários/)).toBeInTheDocument();
    expect(screen.getByText(/grupo = Doadores/)).toBeInTheDocument();
  });

  it('não aparece no modo simples (padrão)', () => {
    renderWizardAtFilterStep();
    expect(screen.queryByText(/é um critério isolado/i)).not.toBeInTheDocument();
  });
});

/**
 * Pedido do cliente (2026-08-25), §6.4 — "adicionar contato específico". A
 * regra pura (`materializeExtraContacts`, `extra-contacts.spec.ts`) e a busca
 * do componente (`extra-contacts-picker.spec.tsx`) já têm cobertura própria;
 * faltava provar a COSTURA: o contato escolhido no picker chega ao filtro que
 * a prévia recebe. Sem este teste, `new.spec.tsx` substitui o picker por um
 * `<div>` vazio e nunca exercita `picker → finalFilters → preview.mutateAsync`
 * de ponta a ponta.
 */
describe('Assistente — contato avulso chega ao filtro da prévia (§6.4)', () => {
  it('escolher um contato no picker soma phoneE164 (OU no topo) ao filtro que a prévia recebe', async () => {
    const user = userEvent.setup();
    renderWizardAtFilterStep();

    await user.click(
      screen.getByRole('button', { name: /Adicionar Zeca Avulso/i }),
    );
    await avancarAoPasso4();

    await waitFor(() =>
      expect(previewMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            combinator: 'or',
            rules: expect.arrayContaining([
              expect.objectContaining({
                field: 'phoneE164',
                op: 'in',
                value: [STUB_EXTRA_CONTACT.phoneE164],
              }),
            ]),
          }),
        }),
      ),
    );
  });
});
