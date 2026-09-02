import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// --- Router mock ----------------------------------------------------------
// TemplatesPage only needs `createFileRoute` to register its component; we
// pass the options straight through so `Route.component` is the page itself.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
}));

// --- Feature API mocks ----------------------------------------------------
const useTemplatesMock = vi.fn();
const syncMutateAsync = vi.fn();
const syncState = { isPending: false };
const syncZernioMutateAsync = vi.fn();
const syncZernioState = { isPending: false };

vi.mock('@/features/templates/api', () => ({
  useTemplates: (provider?: string) => useTemplatesMock(provider),
  useSyncTemplates: () => ({
    mutateAsync: syncMutateAsync,
    isPending: syncState.isPending,
  }),
  useSyncZernioTemplates: () => ({
    mutateAsync: syncZernioMutateAsync,
    isPending: syncZernioState.isPending,
  }),
  // A module mock replaces the WHOLE module, so EVERY hook the page's tree
  // calls must be stubbed here — the Twilio create/submit/edit dialogs the page
  // now renders call these on mount, and omitting one throws
  // "No <hook> export is defined on the mock", failing every test in the file.
  useCreateTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateTwilioTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSubmitTwilioTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTwilioDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The provider tabs are gated to the CONFIGURED providers, so the page reads
// useProviders(). Default: all four configured, so the existing tab assertions
// hold; individual tests narrow it to prove the gating.
const useProvidersMock = vi.fn();
vi.mock('@/features/whatsapp/api', async () => {
  const actual =
    await vi.importActual<typeof import('@/features/whatsapp/api')>(
      '@/features/whatsapp/api',
    );
  return { ...actual, useProviders: () => useProvidersMock() };
});

// --- Provider scope mock ---------------------------------------------------
// Keep the real PROVIDER_LABEL/ProviderBadge (plain, hook-free) so the tests
// exercise the real badge/label text; only `useProviderScope` needs mocking
// since it requires the context provider mounted at the authenticated root.
const useProviderScopeMock = vi.fn();
vi.mock('@/features/whatsapp/provider-scope', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/whatsapp/provider-scope')
  >('@/features/whatsapp/provider-scope');
  return {
    ...actual,
    useProviderScope: () => useProviderScopeMock(),
  };
});

// --- Dialog mocks ---------------------------------------------------------
// Capture the props the page passes so we can assert which dialog is open and
// with what mode/template, without pulling in the real form internals.
const formDialogSpy = vi.fn();
vi.mock('@/features/templates/components/template-form-dialog', () => ({
  TemplateFormDialog: (props: Record<string, unknown>) => {
    formDialogSpy(props);
    return (
      <div data-testid="form-dialog" data-mode={String(props.mode)}>
        form-dialog
      </div>
    );
  },
}));

const deleteDialogSpy = vi.fn();
vi.mock('@/features/templates/components/delete-template-dialog', () => ({
  DeleteTemplateDialog: (props: Record<string, unknown>) => {
    deleteDialogSpy(props);
    return (
      <div data-testid="delete-dialog" data-open={String(props.open)}>
        delete-dialog
      </div>
    );
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const extractApiErrorMock = vi.fn();
vi.mock('@/lib/api-error', () => ({
  extractApiError: (err: unknown) => extractApiErrorMock(err),
}));

import { Route } from './templates';
import type { Template } from '@/features/templates/schemas';

const TemplatesPage = (Route as unknown as { component: React.ComponentType })
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

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 't1',
    metaName: 'welcome_message',
    language: 'pt_BR',
    body: 'Olá, seja bem-vindo!',
    variables: [],
    status: 'APPROVED',
    category: 'UTILITY',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    kind: 'TEXT',
    interactiveConfig: null,
    provider: 'EVOLUTION',
    twilioApprovalStatus: null,
    twilioRejectionReason: null,
    lastTwilioSyncAt: null,
    ...overrides,
  };
}

function mockList(items: Template[]) {
  useTemplatesMock.mockReturnValue({
    data: items,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  useTemplatesMock.mockReset();
  useProvidersMock.mockReset();
  useProvidersMock.mockReturnValue({
    data: {
      providers: [
        { provider: 'EVOLUTION', channels: [] },
        { provider: 'TWILIO', channels: [] },
        { provider: 'ZERNIO', channels: [] },
        { provider: 'META', channels: [] },
      ],
    },
  });
  syncMutateAsync.mockReset();
  syncState.isPending = false;
  syncZernioMutateAsync.mockReset();
  syncZernioState.isPending = false;
  formDialogSpy.mockReset();
  deleteDialogSpy.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  extractApiErrorMock.mockReset();
  // `extractApiError` is async in the real module; default to a resolved
  // promise so consumers (e.g. QueryErrorFallback) can `.then()` on it.
  extractApiErrorMock.mockResolvedValue({ title: 'Erro', message: 'erro' });
  useProviderScopeMock.mockReset();
  useProviderScopeMock.mockReturnValue({ scope: 'all', setScope: vi.fn() });
});

describe('TemplatesPage — error handling', () => {
  it('renders the error fallback with a retry button when the query fails', async () => {
    const refetch = vi.fn();
    useTemplatesMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch,
    });

    wrap(<TemplatesPage />);

    expect(
      await screen.findByRole('button', { name: /Tentar novamente/i }),
    ).toBeInTheDocument();
    // The catalog header is not rendered on the error path.
    expect(screen.queryByText('Catálogo.')).not.toBeInTheDocument();
  });
});

describe('TemplatesPage — loading / empty / list states', () => {
  it('shows the loading indicator while the query is pending', () => {
    useTemplatesMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<TemplatesPage />);

    expect(screen.getByText('Carregando...')).toBeInTheDocument();
    // Header chrome (count + actions) is always present.
    expect(screen.getByText(/templates · 0/)).toBeInTheDocument();
  });

  it('shows the empty-state message when the list is empty', () => {
    mockList([]);

    wrap(<TemplatesPage />);

    expect(
      screen.getByText(/Nenhum template ainda/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/templates · 0/)).toBeInTheDocument();
  });

  it('renders one card per template with the header count', () => {
    mockList([
      makeTemplate({ id: 'a', metaName: 'alpha' }),
      makeTemplate({ id: 'b', metaName: 'bravo' }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.getByText(/templates · 2/)).toBeInTheDocument();
  });
});

describe('TemplatesPage — status badge', () => {
  // twilio-platform T3 — each status gets a distinct colored badge:
  // Aprovado verde (emerald), Pendente âmbar, Rejeitado vermelho (red),
  // Pausado laranja (orange). The color token in the className is the
  // contract the assertion pins down.
  it.each([
    ['APPROVED', 'Aprovado', 'emerald'],
    ['PENDING', 'Pendente', 'amber'],
    ['REJECTED', 'Rejeitado', 'red'],
    ['PAUSED', 'Pausado', 'orange'],
  ] as const)(
    'maps status %s to the label %s with the %s color',
    (status, label, colorToken) => {
      mockList([makeTemplate({ status })]);

      wrap(<TemplatesPage />);

      const badge = screen.getByText(label);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain(colorToken);
    },
  );

  it('falls back to the raw status when unknown', () => {
    // Force an out-of-enum status to exercise the `?? t.status` fallback.
    mockList([makeTemplate({ status: 'WEIRD' as Template['status'] })]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('WEIRD')).toBeInTheDocument();
  });
});

describe('TemplatesPage — rejection/pause reason (twilioRejectionReason)', () => {
  it('shows the reason line for a REJECTED template carrying a reason', () => {
    mockList([
      makeTemplate({
        status: 'REJECTED',
        provider: 'TWILIO',
        twilioRejectionReason: 'Categoria incorreta',
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText(/Motivo: Categoria incorreta/)).toBeInTheDocument();
  });

  it('shows the reason line for a PAUSED template carrying a reason', () => {
    mockList([
      makeTemplate({
        status: 'PAUSED',
        provider: 'TWILIO',
        twilioRejectionReason: 'Pausado pela Meta por qualidade',
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(
      screen.getByText(/Motivo: Pausado pela Meta por qualidade/),
    ).toBeInTheDocument();
  });

  it('omits the reason line when the template is REJECTED without a reason', () => {
    mockList([
      makeTemplate({
        status: 'REJECTED',
        provider: 'TWILIO',
        twilioRejectionReason: null,
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.queryByText(/Motivo:/)).not.toBeInTheDocument();
  });

  it('omits the reason line for a non-rejected/non-paused status even if a stale reason exists', () => {
    // A template rejected once and later re-approved via clone/sync may keep
    // the old reason in the column — the card must not surface it.
    mockList([
      makeTemplate({
        status: 'APPROVED',
        provider: 'TWILIO',
        twilioRejectionReason: 'Motivo antigo',
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.queryByText(/Motivo:/)).not.toBeInTheDocument();
  });
});

describe('TemplatesPage — Twilio catalog sync freshness', () => {
  it('shows "sincronizado há X min" for a TWILIO template with lastTwilioSyncAt', () => {
    // 5.5 min ago floors to 5 — the 30s of slack keeps the assertion from
    // flaking across a minute boundary during the render.
    mockList([
      makeTemplate({
        provider: 'TWILIO',
        lastTwilioSyncAt: new Date(Date.now() - 5.5 * 60_000),
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText(/sincronizado há 5 min/)).toBeInTheDocument();
  });

  it('shows "sincronizado agora" for a sync younger than a minute', () => {
    mockList([
      makeTemplate({
        provider: 'TWILIO',
        lastTwilioSyncAt: new Date(Date.now() - 10_000),
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText(/sincronizado agora/)).toBeInTheDocument();
  });

  it('falls back to hours when the sync is older than an hour', () => {
    mockList([
      makeTemplate({
        provider: 'TWILIO',
        lastTwilioSyncAt: new Date(Date.now() - 2.5 * 3_600_000),
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText(/sincronizado há 2 h/)).toBeInTheDocument();
  });

  it('omits the indicator for a TWILIO template never touched by the sync', () => {
    mockList([makeTemplate({ provider: 'TWILIO', lastTwilioSyncAt: null })]);

    wrap(<TemplatesPage />);

    expect(screen.queryByText(/sincronizado/)).not.toBeInTheDocument();
  });

  it('omits the indicator for EVOLUTION templates even if the column carries a value', () => {
    // The freshness indicator is about the TWILIO catalog — an Evolution
    // template must render exactly as before.
    mockList([
      makeTemplate({
        provider: 'EVOLUTION',
        lastTwilioSyncAt: new Date(Date.now() - 5.5 * 60_000),
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.queryByText(/sincronizado/)).not.toBeInTheDocument();
  });
});

describe('TemplatesPage — card body (language/category/kind badges + preview)', () => {
  it('renders language and category badges, no kind badge for TEXT', () => {
    mockList([
      makeTemplate({
        language: 'en_US',
        category: 'MARKETING',
        kind: 'TEXT',
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('en_US')).toBeInTheDocument();
    expect(screen.getByText('MARKETING')).toBeInTheDocument();
    // No kind label badges for TEXT.
    expect(screen.queryByText('texto')).not.toBeInTheDocument();
    expect(screen.queryByText('lista')).not.toBeInTheDocument();
  });

  it('renders the TEXT body as preview', () => {
    mockList([makeTemplate({ kind: 'TEXT', body: 'Corpo da mensagem' })]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('Corpo da mensagem')).toBeInTheDocument();
  });

  it('renders the LIST kind badge and title preview', () => {
    mockList([
      makeTemplate({
        kind: 'LIST',
        interactiveConfig: { title: 'Menu principal' },
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('lista')).toBeInTheDocument();
    expect(screen.getByText('Lista: Menu principal')).toBeInTheDocument();
  });

  it('renders the LIST preview placeholder when no title', () => {
    mockList([makeTemplate({ kind: 'LIST', interactiveConfig: null })]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('Lista: (sem título)')).toBeInTheDocument();
  });

  it('renders the BUTTONS kind badge and description preview', () => {
    mockList([
      makeTemplate({
        kind: 'BUTTONS',
        interactiveConfig: { description: 'Escolha uma opção' },
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('botões')).toBeInTheDocument();
    expect(screen.getByText('Botões: Escolha uma opção')).toBeInTheDocument();
  });

  it('renders the BUTTONS preview placeholder when no description', () => {
    mockList([makeTemplate({ kind: 'BUTTONS', interactiveConfig: {} })]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('Botões: (sem descrição)')).toBeInTheDocument();
  });

  it('renders the POLL kind badge and question preview', () => {
    mockList([
      makeTemplate({
        kind: 'POLL',
        interactiveConfig: { question: 'Você gostou?' },
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('enquete')).toBeInTheDocument();
    expect(screen.getByText('Enquete: Você gostou?')).toBeInTheDocument();
  });

  it('renders the POLL preview placeholder when no question', () => {
    mockList([makeTemplate({ kind: 'POLL', interactiveConfig: null })]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('Enquete: (sem pergunta)')).toBeInTheDocument();
  });

  it('does not render the variáveis block when there are no variables', () => {
    mockList([makeTemplate({ variables: [] })]);

    wrap(<TemplatesPage />);

    expect(screen.queryByText('variáveis')).not.toBeInTheDocument();
  });

  it('renders the variáveis block with formatted placeholders', () => {
    mockList([makeTemplate({ variables: ['nome', 'data'] })]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('variáveis')).toBeInTheDocument();
    expect(screen.getByText('{{nome}} · {{data}}')).toBeInTheDocument();
  });
});

describe('TemplatesPage — create / edit / delete actions', () => {
  it('opens the create dialog with mode="create"', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    expect(screen.queryByTestId('form-dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Novo template/i }));

    const dialog = screen.getByTestId('form-dialog');
    expect(dialog).toHaveAttribute('data-mode', 'create');
  });

  it('opens the edit dialog with the row template and mode="edit"', async () => {
    const user = userEvent.setup();
    const tpl = makeTemplate({ id: 'edit-me', metaName: 'editable' });
    mockList([tpl]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('button', { name: /Editar/i }));

    const dialog = screen.getByTestId('form-dialog');
    expect(dialog).toHaveAttribute('data-mode', 'edit');
    const lastCall = formDialogSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.initialData).toBe(tpl);
  });

  it('passes the selected template to the delete dialog and marks it open', async () => {
    const user = userEvent.setup();
    const tpl = makeTemplate({ id: 'del-me', metaName: 'deletable' });
    mockList([tpl]);

    wrap(<TemplatesPage />);

    // Delete dialog is rendered but closed (template null) initially.
    expect(screen.getByTestId('delete-dialog')).toHaveAttribute(
      'data-open',
      'false',
    );

    await user.click(screen.getByRole('button', { name: /Excluir/i }));

    const lastCall = deleteDialogSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBe(true);
    expect(lastCall?.template).toBe(tpl);
  });
});

// Pedido do cliente (2026-08-25): "sincronizar com a Meta" só aparece/roda
// pelo ZERNIO — é o único provedor cujo template nasce e vive na Meta por
// aqui. Nos demais provedores/abas o botão não existe mais.
describe('TemplatesPage — sync button (ZERNIO only)', () => {
  it('shows no sync button by default (no provider tab selected)', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'all', setScope: vi.fn() });
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    expect(
      screen.queryByRole('button', { name: /Sincronizar/i }),
    ).not.toBeInTheDocument();
  });

  it('shows no sync button on a non-ZERNIO provider tab (e.g. Evolution)', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Evolution' }));

    expect(
      screen.queryByRole('button', { name: /Sincronizar/i }),
    ).not.toBeInTheDocument();
  });

  it('shows "Sincronizar Zernio" when the Zernio tab is active', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Zernio' }));

    expect(
      screen.getByRole('button', { name: /Sincronizar Zernio/i }),
    ).toBeInTheDocument();
  });

  it('seeding the filter from a Zernio global scope shows the Zernio button immediately', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'ZERNIO', setScope: vi.fn() });
    mockList([makeTemplate({ provider: 'ZERNIO' })]);

    wrap(<TemplatesPage />);

    expect(
      screen.getByRole('button', { name: /Sincronizar Zernio/i }),
    ).toBeInTheDocument();
  });

  it('clicking the Zernio button calls useSyncZernioTemplates (not the Meta sync) and toasts synced+skipped', async () => {
    const user = userEvent.setup();
    syncZernioMutateAsync.mockResolvedValue({ synced: 5, skipped: 2 });
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Zernio' }));
    await user.click(
      screen.getByRole('button', { name: /Sincronizar Zernio/i }),
    );

    expect(syncZernioMutateAsync).toHaveBeenCalledTimes(1);
    expect(syncMutateAsync).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(
      'Sincronizados 5 templates (2 pulados)',
    );
  });

  it('shows an error toast when the Zernio sync fails', async () => {
    const user = userEvent.setup();
    syncZernioMutateAsync.mockRejectedValue(new Error('nope'));
    extractApiErrorMock.mockResolvedValue({
      title: 'Falhou',
      message: 'detalhe zernio',
    });
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Zernio' }));
    await user.click(
      screen.getByRole('button', { name: /Sincronizar Zernio/i }),
    );

    expect(toastError).toHaveBeenCalledWith('Falhou', {
      description: 'detalhe zernio',
    });
  });

  it('disables the sync button and shows the pending label while the Zernio sync runs', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'ZERNIO', setScope: vi.fn() });
    syncZernioState.isPending = true;
    mockList([makeTemplate({ provider: 'ZERNIO' })]);

    wrap(<TemplatesPage />);

    const btn = screen.getByRole('button', { name: /Sincronizando.../i });
    expect(btn).toBeDisabled();
  });

  it('switching back to "Todos" hides the sync button again', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Zernio' }));
    await user.click(screen.getByRole('tab', { name: 'Todos' }));

    expect(
      screen.queryByRole('button', { name: /Sincronizar/i }),
    ).not.toBeInTheDocument();
  });
});

describe('TemplatesPage — provider badge', () => {
  it('renders a ProviderBadge with the provider label on each card', () => {
    mockList([
      makeTemplate({ id: 'a', metaName: 'alpha', provider: 'EVOLUTION' }),
      makeTemplate({ id: 'b', metaName: 'bravo', provider: 'TWILIO' }),
    ]);

    wrap(<TemplatesPage />);

    // Scope to each card (not the provider-filter tabs, which repeat the same
    // provider labels) via the closest `.rounded-xl` card wrapper.
    const alphaCard = screen.getByText('alpha').closest('.rounded-xl');
    const bravoCard = screen.getByText('bravo').closest('.rounded-xl');
    expect(alphaCard).not.toBeNull();
    expect(bravoCard).not.toBeNull();
    expect(within(alphaCard as HTMLElement).getByText('Evolution')).toBeInTheDocument();
    expect(within(bravoCard as HTMLElement).getByText('Twilio')).toBeInTheDocument();
  });
});

describe('TemplatesPage — provider filter', () => {
  it('queries with no provider (undefined) when the global scope is "all"', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'all', setScope: vi.fn() });
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    expect(useTemplatesMock).toHaveBeenLastCalledWith(undefined);
  });

  it('seeds the filter from a specific initial global scope', () => {
    useProviderScopeMock.mockReturnValue({ scope: 'TWILIO', setScope: vi.fn() });
    mockList([makeTemplate({ provider: 'TWILIO' })]);

    wrap(<TemplatesPage />);

    expect(useTemplatesMock).toHaveBeenLastCalledWith('TWILIO');
  });

  // Evolution (não Twilio): a aba Twilio agora é condicional (ver describe
  // dedicado abaixo) — este teste só quer o comportamento genérico de troca
  // de aba, então usa uma aba sempre disponível.
  it('re-queries with the selected provider when a tab is clicked', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Evolution' }));

    expect(useTemplatesMock).toHaveBeenLastCalledWith('EVOLUTION');
  });

  it('switches back to no filter when "Todos" is clicked again', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Evolution' }));
    await user.click(screen.getByRole('tab', { name: 'Todos' }));

    expect(useTemplatesMock).toHaveBeenLastCalledWith(undefined);
  });

  // An Evolution-only deploy must not carry three permanently-empty tabs; a
  // template prepared before its channel exists still shows under "Todos".
  it('only offers tabs for configured providers', () => {
    useProvidersMock.mockReturnValue({
      data: { providers: [{ provider: 'EVOLUTION', channels: [] }] },
    });
    mockList([makeTemplate()]);

    wrap(<TemplatesPage />);

    expect(screen.getByRole('tab', { name: 'Todos' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Evolution' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Twilio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Zernio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Meta' })).not.toBeInTheDocument();
  });
});

// Pedido do cliente (2026-08-25, complemento): a aba Twilio e o botão "Novo
// template Twilio" só existem enquanto houver pelo menos um template TWILIO
// já cadastrado (legado) — sem nenhum, a Twilio some da tela inteira.
describe('TemplatesPage — Twilio tab (legacy-only)', () => {
  it('hides the Twilio tab and the "Novo template Twilio" button when no TWILIO template exists', () => {
    mockList([makeTemplate({ provider: 'EVOLUTION' })]);

    wrap(<TemplatesPage />);

    expect(screen.queryByRole('tab', { name: 'Twilio' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Novo template Twilio/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the Twilio tab visible when at least one TWILIO template exists', () => {
    mockList([makeTemplate({ provider: 'TWILIO' })]);

    wrap(<TemplatesPage />);

    expect(screen.getByRole('tab', { name: 'Twilio' })).toBeInTheDocument();
  });

  it('never shows "Novo template Twilio", even with a legacy TWILIO template (read/edit-only)', async () => {
    const user = userEvent.setup();
    mockList([makeTemplate({ provider: 'TWILIO' })]);

    wrap(<TemplatesPage />);

    await user.click(screen.getByRole('tab', { name: 'Twilio' }));

    expect(
      screen.queryByRole('button', { name: /Novo template Twilio/i }),
    ).not.toBeInTheDocument();
    // O "Novo template" genérico segue existindo (agora sem Twilio como
    // opção de provedor — ver template-form-dialog.render.spec.tsx).
    expect(
      screen.getByRole('button', { name: /^Novo template$/i }),
    ).toBeInTheDocument();
  });
});

// ZC — o catálogo do ZERNIO aparece IGUAL ao da Twilio: badge de status,
// categoria, idioma, motivo e "sincronizado há X".
describe('TemplatesPage — catálogo ZERNIO (ZC)', () => {
  it('mostra status, categoria e idioma de um template ZERNIO', () => {
    mockList([
      makeTemplate({
        provider: 'ZERNIO',
        metaName: 'bem_vindo_mg',
        status: 'APPROVED',
        category: 'MARKETING',
        language: 'pt_BR',
        zernioTemplateId: '833669913010819',
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText('bem_vindo_mg')).toBeInTheDocument();
    expect(screen.getByText('Aprovado')).toBeInTheDocument();
    expect(screen.getByText('MARKETING')).toBeInTheDocument();
    expect(screen.getByText('pt_BR')).toBeInTheDocument();
  });

  it('mostra "sincronizado há X" para um template ZERNIO', () => {
    mockList([
      makeTemplate({
        provider: 'ZERNIO',
        lastZernioSyncAt: new Date(Date.now() - 5.5 * 60_000),
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(screen.getByText(/sincronizado há 5 min/)).toBeInTheDocument();
  });

  // O enum tem PERDA (DISABLED e PENDING_DELETION viram ambos PAUSED); o motivo
  // vindo do webhook é o que diz ao operador o que de fato aconteceu.
  it('mostra o motivo da pausa/rejeição vindo do Zernio', () => {
    mockList([
      makeTemplate({
        provider: 'ZERNIO',
        status: 'PAUSED',
        zernioStatusRaw: 'DISABLED',
        zernioRejectionReason: 'Desabilitado pela Meta por qualidade',
      }),
    ]);

    wrap(<TemplatesPage />);

    expect(
      screen.getByText(/Motivo: Desabilitado pela Meta por qualidade/),
    ).toBeInTheDocument();
  });
});
