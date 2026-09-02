import { render, screen, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HTTPError } from 'ky';
import type { ContactValidity } from '@/features/contacts/validity';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
// Sem estes polyfills o trigger não abre e o teste do filtro de motivo de
// falha falharia por motivo errado.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// B.3 — jsdom não implementa `URL.createObjectURL`/`revokeObjectURL`, e um
// clique de verdade num `<a href="blob:...">` dispara a ativação de
// navegação do jsdom (não implementada, e assíncrona via setTimeout — podendo
// vazar um erro para o teste seguinte). O botão "Exportar planilha" usa os
// três; sem estes stubs o teste de clique dependeria de comportamento não
// determinístico do jsdom em vez do fluxo de exportação em si.
//
// Fix round 1 — viraram spies (não só stubs inertes) porque o teste de
// exportação bem-sucedida agora assere sobre as três chamadas: o Blob que
// entrou em `createObjectURL`, o clique de fato disparado, e a URL liberada
// em `revokeObjectURL`. `lastAnchorDownload` guarda o `download` do `<a>` no
// momento do clique (o elemento é destacado do DOM, então `screen` não o
// encontra) para checar o nome do arquivo baixado — só a PROPRIEDADE, não o
// elemento (`no-this-alias` recusa aliasing de `this` para uma variável).
const MOCK_EXPORT_BLOB_URL = 'blob:mock-export-url';
const createObjectURLSpy = vi.fn(() => MOCK_EXPORT_BLOB_URL);
const revokeObjectURLSpy = vi.fn();
URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
URL.revokeObjectURL = revokeObjectURLSpy;
let lastAnchorDownload: string | null = null;
const anchorClickSpy = vi
  .spyOn(HTMLAnchorElement.prototype, 'click')
  .mockImplementation(function (this: HTMLAnchorElement) {
    lastAnchorDownload = this.download;
  });

// B.3 T9 — o botão de apagar inválidos confirmados é ADMIN-only. Mock mínimo
// do auth store: um seletor que lê `user.role` do estado fixado por teste.
let authRole = 'ADMIN';
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) =>
    sel({ user: { role: authRole } }),
}));

// --- Router mock ----------------------------------------------------------
// ContactsPage relies on `Route.useSearch()` and `useNavigate`. We capture
// the search params + a navigate spy so each test can drive the component.
const searchState = {
  page: 1,
  pageSize: 50,
  search: undefined as string | undefined,
  failureReason: undefined as string | undefined,
  receivedCampaignId: undefined as string | undefined,
  validity: undefined as string | undefined,
};
const navigateSpy = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
    useSearch: () => searchState,
  }),
  useNavigate: () => navigateSpy,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// `import { z } from 'zod'` resolves to undefined under this vitest/zod-v4
// setup, which would crash contacts.tsx's module-level `validateSearch`
// schema at import time. The schema is irrelevant here (our router mock
// supplies search params directly), so stub zod with a chainable no-op.
vi.mock('zod', () => {
  // A callable proxy where every property access AND every call returns the
  // same proxy, so arbitrary chains like z.coerce.number().int().default(1)
  // resolve without error.
  const handler: ProxyHandler<() => unknown> = {
    get: () => zStub,
    apply: () => zStub,
  };
  const zStub: unknown = new Proxy(function () {} as () => unknown, handler);
  return { z: zStub };
});

// --- Feature API mocks ----------------------------------------------------
const useContactsMock = vi.fn();
const deleteOneMutate = vi.fn();
const bulkDeleteMutate = vi.fn();
const exportMutate = vi.fn();
vi.mock('@/features/contacts/api', () => ({
  useContacts: (q: unknown) => useContactsMock(q),
  useDeleteContact: () => ({ mutateAsync: deleteOneMutate, isPending: false }),
  useBulkDeleteContacts: () => ({
    mutateAsync: bulkDeleteMutate,
    isPending: false,
  }),
  useExportContacts: () => ({ mutateAsync: exportMutate, isPending: false }),
}));

// Fix round 1 — o caminho de erro do export (`onExport`'s catch) chama
// `toast.error` de verdade; sem mock, isso bateria no `sonner` real sem
// `<Toaster/>` montado. Mesmo padrão de
// `save-as-segment-dialog.spec.tsx`/`contact-form-dialog.spec.tsx`.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: [] }),
}));

// F3 T2 — quem alimenta o <select> de "Recebeu a campanha" é a LISTA de
// campanhas (endpoint próprio): a agregação da célula não traz ids de
// propósito. Definido inline porque o factory do vi.mock é içado acima de
// qualquer const do módulo.
vi.mock('@/features/campaigns/api', () => ({
  useCampaigns: () => ({
    data: [
      { id: 'camp-1', name: 'Boas-vindas' },
      { id: 'camp-2', name: 'Segundo turno' },
    ],
  }),
}));

// Dialog components are irrelevant to error/pagination behavior — stub them.
vi.mock('@/features/contacts/components/contact-form-dialog', () => ({
  ContactFormDialog: () => null,
}));
vi.mock('@/features/contacts/components/labels-dialog', () => ({
  LabelsDialog: () => null,
}));
vi.mock('@/features/contacts/components/sync-contacts-dialog', () => ({
  SyncContactsDialog: () => null,
}));

import { Route } from './contacts';

const ContactsPage = (Route as unknown as { component: React.ComponentType })
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

function makeContact(id: string) {
  return {
    id,
    phoneE164: `+55119${id}`,
    name: `Contato ${id}`,
    city: null,
    group: null,
    tags: [],
    customFields: null,
    optedOut: false,
    whatsappValid: null,
    whatsappCheckedAt: null,
    profilePictureUrl: null,
    waLabels: [],
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    marketingUndeliverableAt: null,
    marketingUndeliverableCode: null,
    marketingUndeliverableReason: null,
    lastFailureReason: null as string | null,
    lastFailureCode: null as string | null,
    lastFailureAt: null,
    failureCount: 0,
    // B.6, review (achado 1) — ausente (undefined) por padrão nas fixtures
    // antigas: `contactValidityOf` cai na derivação de 2 campos quando não
    // está presente, o mesmo comportamento de uma resposta em cache de antes
    // desta mudança.
    validity: undefined as ContactValidity | undefined,
    // Sempre presente na listagem, inclusive para quem não recebeu nada.
    campaignsReceived: { count: 0, names: [] as string[] },
  };
}

beforeEach(() => {
  navigateSpy.mockReset();
  useContactsMock.mockReset();
  deleteOneMutate.mockReset();
  bulkDeleteMutate.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  searchState.page = 1;
  searchState.pageSize = 50;
  searchState.search = undefined;
  searchState.failureReason = undefined;
  searchState.receivedCampaignId = undefined;
});

function mockList(items: ReturnType<typeof makeContact>[], total = items.length) {
  useContactsMock.mockReturnValue({
    data: { items, total, page: searchState.page, pageSize: searchState.pageSize },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

describe('ContactsPage — error handling (A11)', () => {
  it('renders the error fallback with a retry button when the query fails', async () => {
    const refetch = vi.fn();
    useContactsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch,
    });

    wrap(<ContactsPage />);

    // QueryErrorFallback renders a "Tentar novamente" retry button.
    expect(
      await screen.findByRole('button', { name: /Tentar novamente/i }),
    ).toBeInTheDocument();

    // The empty-state message must NOT be shown on error.
    expect(
      screen.queryByText(/Nenhum contato ainda/i),
    ).not.toBeInTheDocument();
  });
});

describe('ContactsPage — pagination off-by-one', () => {
  it('disables "Próxima" on a full last page (page*pageSize === total)', () => {
    searchState.page = 2;
    searchState.pageSize = 2;
    useContactsMock.mockReturnValue({
      data: {
        items: [makeContact('3'), makeContact('4')],
        total: 4,
        page: 2,
        pageSize: 2,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<ContactsPage />);

    const next = screen.getByRole('button', { name: /Próxima/i });
    expect(next).toBeDisabled();
  });

  it('keeps "Próxima" enabled on a full page when more items exist', () => {
    searchState.page = 1;
    searchState.pageSize = 2;
    useContactsMock.mockReturnValue({
      data: {
        items: [makeContact('1'), makeContact('2')],
        total: 4,
        page: 1,
        pageSize: 2,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<ContactsPage />);

    const next = screen.getByRole('button', { name: /Próxima/i });
    expect(next).not.toBeDisabled();
  });
});

describe('ContactsPage — row rendering', () => {
  it('renders a row per contact with phone and name', () => {
    mockList([makeContact('1'), makeContact('2')]);

    wrap(<ContactsPage />);

    expect(screen.getByText('+551191')).toBeInTheDocument();
    expect(screen.getByText('+551192')).toBeInTheDocument();
    expect(screen.getByText('Contato 1')).toBeInTheDocument();
    expect(screen.getByText('Contato 2')).toBeInTheDocument();
  });

  it('renders the empty-state message when there are no contacts', () => {
    mockList([], 0);

    wrap(<ContactsPage />);

    expect(screen.getByText(/Nenhum contato ainda/i)).toBeInTheDocument();
    expect(screen.getByTestId('contacts-empty-base')).toBeInTheDocument();
  });
});

/**
 * O estado vazio precisa distinguir "a base está vazia" de "o filtro não
 * casou". Zero linhas COM filtro ativo é a resposta CORRETA e comum — o
 * <select> de campanhas é alimentado por `useCampaigns()`, que devolve TODAS
 * as campanhas incluindo as DRAFT/agendadas, então filtrar por uma que ainda
 * não disparou dá zero. Dizer "Nenhum contato ainda. Clique em Novo contato"
 * numa base de 13 mil contatos é mentir para o operador.
 */
describe('ContactsPage — estado vazio COM filtro ativo', () => {
  it.each([
    ['receivedCampaignId', 'camp-1'],
    ['failureReason', 'TELEFONE_INVALIDO'],
    ['search', 'ana'],
  ])('não diz "Nenhum contato ainda" quando %s está setado', (key, value) => {
    (searchState as Record<string, unknown>)[key] = value;
    mockList([], 0);

    wrap(<ContactsPage />);

    expect(screen.queryByText(/Nenhum contato ainda/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('contacts-empty-base')).not.toBeInTheDocument();
    expect(screen.getByTestId('contacts-empty-filtered')).toBeInTheDocument();
    expect(
      screen.getByText(/Nenhum contato corresponde aos filtros/i),
    ).toBeInTheDocument();
  });

  it('o botão "Limpar filtros" navega zerando os três filtros', () => {
    searchState.receivedCampaignId = 'camp-1';
    searchState.failureReason = 'TELEFONE_INVALIDO';
    searchState.search = 'ana';
    searchState.page = 4;
    mockList([], 0);

    wrap(<ContactsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Limpar filtros/i }));

    const arg = navigateSpy.mock.calls.at(-1)?.[0];
    const next = arg.search({
      page: 4,
      pageSize: 50,
      search: 'ana',
      failureReason: 'TELEFONE_INVALIDO',
      receivedCampaignId: 'camp-1',
    });
    expect(next.search).toBeUndefined();
    expect(next.failureReason).toBeUndefined();
    expect(next.receivedCampaignId).toBeUndefined();
    expect(next.page).toBe(1);
  });

  /**
   * `clearFilters` (contacts.tsx) chama `setSearchInput('')` ANTES do
   * `navigate`. O teste acima só cobre a chamada do `navigate` — não prova
   * que o campo VISÍVEL de busca esvazia. Sem o `setSearchInput('')`, o
   * campo (estado local, não controlado pela URL) continuaria mostrando
   * 'ana' e o debounce de `useContactSearchSync` reescreveria `search` de
   * volta na URL ~300ms depois, porque o efeito compara `searchInput` (ainda
   * 'ana') contra o `search` novo da URL (undefined) e os acha diferentes.
   *
   * O mock do router aqui (`searchState`) não é reativo a `navigate` — para
   * expor o "o filtro volta sozinho" é preciso simular o que o TanStack
   * Router faria de verdade: aplicar o `search()` que o `navigate` recebeu de
   * volta em `searchState` e re-renderizar o MESMO componente montado (por
   * isso `rerender`, não um novo `wrap`, que perderia o estado local do
   * campo).
   */
  it('depois de "Limpar filtros" o campo de busca fica vazio e não volta sozinho após o debounce', async () => {
    searchState.receivedCampaignId = 'camp-1';
    searchState.failureReason = 'TELEFONE_INVALIDO';
    searchState.search = 'ana';
    searchState.page = 4;
    mockList([], 0);

    vi.useFakeTimers();
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const page = () => (
        <QueryClientProvider client={qc}>
          <ContactsPage />
        </QueryClientProvider>
      );
      const { rerender } = render(page());

      const searchBox = screen.getByPlaceholderText(
        /Buscar por nome ou telefone/i,
      ) as HTMLInputElement;
      expect(searchBox.value).toBe('ana');

      fireEvent.click(screen.getByRole('button', { name: /Limpar filtros/i }));

      // O campo esvazia IMEDIATAMENTE — antes de qualquer debounce, e sem
      // depender do round-trip pelo router.
      expect(searchBox.value).toBe('');

      // Simula o router aplicando o `navigate` do clique: a URL passa a
      // refletir os filtros zerados. `rerender` recebe um elemento NOVO (não
      // o mesmo objeto do `render` inicial) para forçar o React a de fato
      // reprocessar `Route.useSearch()` com o `searchState` já mutado —
      // reutilizar o mesmo elemento faz o React pular o re-render.
      const clearArg = navigateSpy.mock.calls.at(-1)?.[0];
      const cleared = clearArg.search({
        page: 4,
        pageSize: 50,
        search: 'ana',
        failureReason: 'TELEFONE_INVALIDO',
        receivedCampaignId: 'camp-1',
      });
      searchState.page = cleared.page;
      searchState.pageSize = cleared.pageSize ?? searchState.pageSize;
      searchState.search = cleared.search;
      searchState.failureReason = cleared.failureReason;
      searchState.receivedCampaignId = cleared.receivedCampaignId;
      navigateSpy.mockClear();
      await act(async () => {
        rerender(page());
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      // Sem `setSearchInput('')`, o campo continuaria em 'ana' e o efeito de
      // debounce, vendo `searchInput` ('ana') divergir do `search` já limpo
      // da URL (undefined), reescreveria `search: 'ana'` de volta — o filtro
      // "limpo" voltando sozinho. Com o fix, `searchInput` já é '' e bate com
      // a URL: nenhuma navegação nova acontece.
      expect(navigateSpy).not.toHaveBeenCalled();
      expect(searchBox.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem filtro nenhum, mantém a mensagem de base vazia', () => {
    mockList([], 0);

    wrap(<ContactsPage />);

    expect(screen.getByTestId('contacts-empty-base')).toBeInTheDocument();
    expect(
      screen.queryByTestId('contacts-empty-filtered'),
    ).not.toBeInTheDocument();
  });
});

describe('ContactsPage — whatsappValid 3-way cell', () => {
  it('shows ✓ (Válido) when whatsappValid === true', () => {
    const c = makeContact('1');
    c.whatsappValid = true;
    mockList([c]);

    wrap(<ContactsPage />);

    const cell = screen.getByLabelText('Válido');
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveTextContent('✓');
    // B.3 — o title agora usa o mesmo vocabulário do filtro/planilha
    // (CONTACT_VALIDITY_HINTS), não mais um texto próprio da célula.
    expect(cell).toHaveAttribute(
      'title',
      'Válido — o WhatsApp confirmou este número, ou uma mensagem já foi entregue nele.',
    );
  });

  it('shows ✗ (Inválido confirmado) when whatsappValid === false', () => {
    const c = makeContact('1');
    c.whatsappValid = false;
    mockList([c]);

    wrap(<ContactsPage />);

    // B.3 — o aria-label passou de "Inválido" para "Inválido confirmado":
    // o mesmo rótulo que o filtro e a planilha usam para esta classe.
    const cell = screen.getByLabelText('Inválido confirmado');
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveTextContent('✗');
    expect(cell).toHaveAttribute(
      'title',
      'Inválido confirmado — o WhatsApp recusou este número, ou um envio falhou por número inexistente/telefone inválido.',
    );
  });

  it('shows the "Não validado" badge when whatsappValid === null', () => {
    const c = makeContact('1');
    c.whatsappValid = null;
    mockList([c]);

    wrap(<ContactsPage />);

    expect(screen.getByText('Não validado')).toBeInTheDocument();
    expect(screen.queryByLabelText('Válido')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Inválido confirmado')).not.toBeInTheDocument();
  });

  // B.6, review (achado 1) — a linha original do bug: `whatsappValid: null`
  // (nunca validado ativamente) e o back já manda `validity: 'valid'` (sonda
  // de entrega provada). Antes desta correção, a célula só olhava
  // `whatsappValid`/`lastFailureReason` e mostrava "Não validado" enquanto o
  // filtro `?validity=valid`, o export e o N do diálogo de sincronização já
  // contavam esta linha como válida.
  it('usa contact.validity do back (sonda de entrega) mesmo com whatsappValid null', () => {
    const c = makeContact('1');
    c.whatsappValid = null;
    c.validity = 'valid';
    mockList([c]);

    wrap(<ContactsPage />);

    const cell = screen.getByLabelText('Válido');
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveTextContent('✓');
    expect(screen.queryByText('Não validado')).not.toBeInTheDocument();
  });
});

describe('ContactsPage — selection + bulk delete', () => {
  it('does not show the selection toolbar until a row is checked', () => {
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    expect(screen.queryByText(/selecionado\(s\)/i)).not.toBeInTheDocument();
  });

  it('toggling a row checkbox enables bulk delete and reflects the count', async () => {
    const user = userEvent.setup();
    mockList([makeContact('1'), makeContact('2')]);

    wrap(<ContactsPage />);

    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar Contato 1' }),
    );

    expect(screen.getByText('1 selecionado(s)')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Excluir selecionados/i }),
    ).not.toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar Contato 2' }),
    );
    expect(screen.getByText('2 selecionado(s)')).toBeInTheDocument();
  });

  it('"select all" header checkbox selects every row on the page', async () => {
    const user = userEvent.setup();
    mockList([makeContact('1'), makeContact('2')]);

    wrap(<ContactsPage />);

    await user.click(
      screen.getByRole('checkbox', { name: /Selecionar todos da página/i }),
    );

    expect(screen.getByText('2 selecionado(s)')).toBeInTheDocument();
  });

  it('confirming bulk delete calls the mutation with selected ids', async () => {
    const user = userEvent.setup();
    bulkDeleteMutate.mockResolvedValue({ deleted: 1 });
    mockList([makeContact('1'), makeContact('2')]);

    wrap(<ContactsPage />);

    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar Contato 1' }),
    );
    await user.click(
      screen.getByRole('button', { name: /Excluir selecionados/i }),
    );

    // Confirm in the AlertDialog.
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Excluir 1$/ }));

    expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ['1'] });
  });
});

describe('ContactsPage — search sync', () => {
  it('debounces and navigates with the typed search term, resetting to page 1', async () => {
    vi.useFakeTimers();
    try {
      mockList([makeContact('1')]);

      wrap(<ContactsPage />);

      fireEvent.change(
        screen.getByPlaceholderText(/Buscar por nome ou telefone/i),
        { target: { value: 'ana' } },
      );

      // Debounce window (300ms) has not elapsed yet → no navigation.
      navigateSpy.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(navigateSpy).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const arg = navigateSpy.mock.calls.at(-1)?.[0];
      expect(arg.replace).toBe(true);
      expect(arg.search()).toEqual({ page: 1, pageSize: 50, search: 'ana' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not navigate when the typed term equals the current search', async () => {
    searchState.search = 'ana';
    vi.useFakeTimers();
    try {
      mockList([makeContact('1')]);

      wrap(<ContactsPage />);

      navigateSpy.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(navigateSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * F2 T9 — coluna/chip do motivo da última falha. Rótulo PT-BR do
 * `lastFailureReason`; INDETERMINADO e null (quando houve falha) mostram o
 * MESMO texto de fallback — §2.5 da spec de design (Evolution não emite
 * código nem mensagem no webhook; Twilio só emite código sem texto), para que
 * "campo vazio" nunca pareça bug em vez de limitação declarada do provedor.
 */
describe('ContactsPage — coluna de motivo de falha', () => {
  it('mostra o cabeçalho da coluna', () => {
    mockList([makeContact('1')]);
    wrap(<ContactsPage />);
    expect(screen.getByText('Motivo da falha')).toBeInTheDocument();
  });

  it('mostra o rótulo PT-BR do lastFailureReason conhecido', () => {
    const c = makeContact('1');
    c.lastFailureReason = 'TELEFONE_INVALIDO';
    c.failureCount = 1;
    mockList([c]);

    wrap(<ContactsPage />);

    expect(screen.getByText('Telefone inválido')).toBeInTheDocument();
  });

  it('mostra "motivo não informado pelo canal" para INDETERMINADO', () => {
    const c = makeContact('1');
    c.lastFailureReason = 'INDETERMINADO';
    c.failureCount = 1;
    mockList([c]);

    wrap(<ContactsPage />);

    expect(
      screen.getByText('motivo não informado pelo canal'),
    ).toBeInTheDocument();
  });

  it('mostra "motivo não informado pelo canal" quando lastFailureReason é null mas houve falha', () => {
    const c = makeContact('1');
    c.lastFailureReason = null;
    c.failureCount = 2;
    mockList([c]);

    wrap(<ContactsPage />);

    expect(
      screen.getByText('motivo não informado pelo canal'),
    ).toBeInTheDocument();
  });

  it('mostra "—" (não chip de falha) quando o contato nunca falhou', () => {
    const c = makeContact('1');
    c.lastFailureReason = null;
    c.failureCount = 0;
    mockList([c]);

    wrap(<ContactsPage />);

    expect(
      screen.queryByText('motivo não informado pelo canal'),
    ).not.toBeInTheDocument();
  });
});

describe('ContactsPage — filtro por motivo de falha', () => {
  it('passa failureReason da URL para useContacts', () => {
    searchState.failureReason = 'TELEFONE_INVALIDO';
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    expect(useContactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'TELEFONE_INVALIDO' }),
    );
  });

  it('escolher um motivo no filtro navega com failureReason e reseta para a página 1', async () => {
    searchState.page = 3;
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    fireEvent.click(
      screen.getByRole('combobox', { name: /Motivo da falha/i }),
    );
    fireEvent.click(
      await screen.findByRole('option', { name: /Telefone inválido/i }),
    );

    expect(navigateSpy).toHaveBeenCalled();
    const arg = navigateSpy.mock.calls.at(-1)?.[0];
    expect(arg.search({ page: 3, pageSize: 50 })).toEqual(
      expect.objectContaining({ page: 1, failureReason: 'TELEFONE_INVALIDO' }),
    );
  });

  it('escolher "Todos" limpa o filtro', async () => {
    searchState.failureReason = 'TELEFONE_INVALIDO';
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    fireEvent.click(
      screen.getByRole('combobox', { name: /Motivo da falha/i }),
    );
    fireEvent.click(await screen.findByRole('option', { name: /^Todos$/i }));

    const arg = navigateSpy.mock.calls.at(-1)?.[0];
    expect(arg.search({ page: 1, pageSize: 50 }).failureReason).toBeUndefined();
  });
});

/**
 * F3 T2 — "quais campanhas este contato RECEBEU". "Recebeu" é o MESMO
 * critério da exclusão do wizard (REACHED_STATUSES: SENT/DELIVERED/READ), e o
 * back já entrega o resumo pronto em `campaignsReceived`.
 *
 * A regra de ausência é herdada do F2: zero campanhas mostra o traço neutro,
 * NUNCA um chip vazio — "não recebeu nada" e "recebeu algo sem nome" não podem
 * parecer a mesma coisa na tela.
 */
/**
 * A célula de campanhas da PRIMEIRA linha do corpo, localizada pela POSIÇÃO do
 * cabeçalho "Campanhas recebidas" — e não por um índice fixo, que apontaria em
 * silêncio para a coluna errada assim que alguém inserisse uma coluna antes
 * dela (e o teste do traço passaria lendo o "—" de outra coluna).
 */
function campaignsCell(): HTMLElement {
  const headers = screen.getAllByRole('columnheader');
  const index = headers.findIndex((h) =>
    /Campanhas recebidas/i.test(h.textContent ?? ''),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const [, firstBodyRow] = screen.getAllByRole('row');
  return within(firstBodyRow).getAllByRole('cell')[index];
}

describe('ContactsPage — coluna de campanhas recebidas', () => {
  // "Campanhas recebidas", não "Campanhas": a coluna conta REACHED_STATUSES.
  // Quem foi ALVO de 3 campanhas e falhou nas 3 mostra "—", que ao lado da
  // coluna "Motivo da falha" se leria como "nunca foi alvo".
  it('mostra o cabeçalho da coluna dizendo que é o que o contato RECEBEU', () => {
    mockList([makeContact('1')]);
    wrap(<ContactsPage />);
    const header = screen.getByRole('columnheader', {
      name: /Campanhas recebidas/i,
    });
    expect(header).toBeInTheDocument();
    expect(header).toHaveAttribute('title', expect.stringMatching(/RECEBEU/));
  });

  it('mostra "—" (não um badge vazio) quando o contato não recebeu nenhuma', () => {
    const c = makeContact('1');
    c.campaignsReceived = { count: 0, names: [] };
    mockList([c]);

    wrap(<ContactsPage />);

    // Asserção POSITIVA e ESCOPADA na célula: um <Badge> vazio, ou a célula não
    // renderizando nada, passariam por um `queryByText` negativo sozinho.
    const cell = campaignsCell();
    expect(cell).toHaveTextContent('—');
    expect(within(cell).queryByText(/campanhas?/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ campanhas?$/)).not.toBeInTheDocument();
  });

  // O tipo diz que `campaignsReceived` é obrigatório, mas `contactsQueries.list`
  // faz só `.json<ContactsListResponse>()` — um cast, ZERO validação em runtime.
  // Num redeploy em que o bundle novo chega antes do backend novo (imagens
  // Docker separadas no compose) a API responde sem o campo. Desestruturar
  // `undefined` lançaria, e como não há `errorComponent` em rota nenhuma o
  // throw sobe até o Sentry.ErrorBoundary global e derruba o APP INTEIRO.
  it('degrada para "—" (não quebra) quando a API não manda campaignsReceived', () => {
    const c = makeContact('1') as Record<string, unknown>;
    delete c.campaignsReceived;
    mockList([c as ReturnType<typeof makeContact>]);

    wrap(<ContactsPage />);

    // A linha inteira continua de pé — não é só a célula que sobrevive.
    expect(screen.getByText('Contato 1')).toBeInTheDocument();
    expect(campaignsCell()).toHaveTextContent('—');
  });

  it('mostra o badge com a contagem e os nomes no title quando recebeu', () => {
    const c = makeContact('1');
    c.campaignsReceived = {
      count: 2,
      names: ['Segundo turno', 'Boas-vindas'],
    };
    mockList([c]);

    wrap(<ContactsPage />);

    const badge = screen.getByText('2 campanhas');
    expect(badge).toBeInTheDocument();
    // Hover por `title` nativo: o design system deste repo não tem Tooltip.
    expect(badge).toHaveAttribute('title', 'Segundo turno\nBoas-vindas');
  });

  it('singulariza para uma única campanha', () => {
    const c = makeContact('1');
    c.campaignsReceived = { count: 1, names: ['Boas-vindas'] };
    mockList([c]);

    wrap(<ContactsPage />);

    expect(screen.getByText('1 campanha')).toBeInTheDocument();
    expect(screen.queryByText('1 campanhas')).not.toBeInTheDocument();
  });

  // Pedido do cliente (2026-08-25): o aviso de "pontos cegos" da contagem de
  // campanhas virou ruído na tela — removido (a funcionalidade da coluna/
  // filtro continua intacta, só o texto de alerta saiu).
  it('NÃO mostra mais o aviso de pontos cegos da contagem (removido a pedido do cliente)', () => {
    mockList([makeContact('1')]);
    wrap(<ContactsPage />);
    expect(
      screen.queryByTestId('campaigns-received-blind-spot'),
    ).not.toBeInTheDocument();
  });
});

describe('ContactsPage — filtro por campanha recebida', () => {
  it('passa receivedCampaignId da URL para useContacts', () => {
    searchState.receivedCampaignId = 'camp-1';
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    expect(useContactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ receivedCampaignId: 'camp-1' }),
    );
  });

  it('escolher uma campanha navega com receivedCampaignId e volta para a página 1', async () => {
    searchState.page = 3;
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    fireEvent.click(
      screen.getByRole('combobox', { name: /Recebeu a campanha/i }),
    );
    fireEvent.click(
      await screen.findByRole('option', { name: /Segundo turno/i }),
    );

    expect(navigateSpy).toHaveBeenCalled();
    const arg = navigateSpy.mock.calls.at(-1)?.[0];
    expect(arg.search({ page: 3, pageSize: 50 })).toEqual(
      expect.objectContaining({ page: 1, receivedCampaignId: 'camp-2' }),
    );
  });

  it('escolher "Todas as campanhas" limpa o filtro', async () => {
    searchState.receivedCampaignId = 'camp-1';
    mockList([makeContact('1')]);

    wrap(<ContactsPage />);

    fireEvent.click(
      screen.getByRole('combobox', { name: /Recebeu a campanha/i }),
    );
    fireEvent.click(
      await screen.findByRole('option', { name: /^Todas as campanhas$/i }),
    );

    const arg = navigateSpy.mock.calls.at(-1)?.[0];
    expect(
      arg.search({ page: 1, pageSize: 50 }).receivedCampaignId,
    ).toBeUndefined();
  });

  /**
   * A ARMADILHA. O debounce da busca reconstrói o objeto de search inteiro (não
   * faz merge com `prev`), então todo filtro novo precisa ser reinjetado ali —
   * senão digitar uma letra na busca apaga silenciosamente o filtro escolhido.
   * O F2 já tropeçou nisto com `failureReason`; este teste tranca os dois.
   */
  it('digitar na busca NÃO apaga o filtro de campanha selecionado', async () => {
    searchState.receivedCampaignId = 'camp-1';
    searchState.failureReason = 'TELEFONE_INVALIDO';
    vi.useFakeTimers();
    try {
      mockList([makeContact('1')]);

      wrap(<ContactsPage />);

      fireEvent.change(
        screen.getByPlaceholderText(/Buscar por nome ou telefone/i),
        { target: { value: 'ana' } },
      );

      navigateSpy.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const arg = navigateSpy.mock.calls.at(-1)?.[0];
      expect(arg.search()).toEqual({
        page: 1,
        pageSize: 50,
        search: 'ana',
        failureReason: 'TELEFONE_INVALIDO',
        receivedCampaignId: 'camp-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ContactsPage — filtro de validação (B.3)', () => {
  beforeEach(() => {
    searchState.page = 1;
    searchState.search = undefined;
    searchState.failureReason = undefined;
    searchState.receivedCampaignId = undefined;
    searchState.validity = undefined;
    navigateSpy.mockClear();
    useContactsMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
    });
  });

  it('o valor do filtro vai para a query da lista', () => {
    searchState.validity = 'invalid';
    wrap(<ContactsPage />);
    expect(useContactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ validity: 'invalid' }),
    );
  });

  it('o <select> "Validação" existe e oferece as três classes + Todos', async () => {
    wrap(<ContactsPage />);
    const trigger = screen.getByLabelText('Validação');
    await userEvent.click(trigger);
    // `role="option"`, e não `getByText`: com o valor default ("all"), o
    // Radix Select espelha o texto do item selecionado no próprio trigger
    // (`data-slot="select-value"`) — "Todos os números" aparece DUAS vezes
    // na tela (trigger + opção da lista) e `getByText` acharia ambíguo. O
    // trigger tem role "combobox", não "option", então escopar por role
    // resolve sem mudar o que o teste verifica.
    expect(
      screen.getByRole('option', { name: 'Todos os números' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Válidos' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Inválidos confirmados' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Não validados' }),
    ).toBeInTheDocument();
  });

  it('escolher "Inválidos confirmados" navega com validity e volta para a página 1', async () => {
    searchState.page = 3;
    wrap(<ContactsPage />);
    await userEvent.click(screen.getByLabelText('Validação'));
    await userEvent.click(screen.getByText('Inválidos confirmados'));

    const arg = navigateSpy.mock.calls.at(-1)![0] as {
      search: (p: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(arg.search({ page: 3, pageSize: 50 })).toEqual(
      expect.objectContaining({ page: 1, validity: 'invalid' }),
    );
  });

  /**
   * ★ A ARMADILHA JÁ DOCUMENTADA EM `useContactSearchSync`: o debounce da busca
   * RECONSTRÓI o objeto de busca inteiro. Todo filtro novo precisa ser
   * reinjetado ali, senão digitar no campo de busca o apaga em silêncio.
   */
  it('digitar na busca NÃO apaga o filtro de validação', async () => {
    vi.useFakeTimers();
    try {
      searchState.validity = 'invalid';
      wrap(<ContactsPage />);
      fireEvent.change(
        screen.getByPlaceholderText('Buscar por nome ou telefone...'),
        { target: { value: 'ana' } },
      );
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const arg = navigateSpy.mock.calls.at(-1)![0] as {
        search: () => Record<string, unknown>;
      };
      expect(arg.search()).toEqual(
        expect.objectContaining({ search: 'ana', validity: 'invalid' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('o filtro de validação conta como filtro ativo no estado vazio', () => {
    searchState.validity = 'invalid';
    wrap(<ContactsPage />);
    expect(screen.getByTestId('contacts-empty-filtered')).toBeInTheDocument();
  });
});

/**
 * Fix round 1 — mesmo padrão de `contact-form-dialog.spec.tsx`: um
 * `HTTPError` de verdade (não um objeto qualquer) cujo
 * `response.clone().json()` resolve para `body`, para exercitar o caminho
 * real de `extractApiError` (`error instanceof HTTPError`) em vez de mockar
 * o extrator.
 */
function httpError(status: number, body: unknown): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, {
    name: 'HTTPError',
    response: {
      status,
      clone: () => ({ json: () => Promise.resolve(body) }),
    },
  });
  return err;
}

describe('ContactsPage — Exportar planilha (B.3)', () => {
  beforeEach(() => {
    searchState.page = 1;
    searchState.search = undefined;
    searchState.failureReason = undefined;
    searchState.receivedCampaignId = undefined;
    searchState.validity = undefined;
    exportMutate.mockClear();
    exportMutate.mockResolvedValue(new Blob(['x']));
    createObjectURLSpy.mockClear();
    revokeObjectURLSpy.mockClear();
    anchorClickSpy.mockClear();
    lastAnchorDownload = null;
    authRole = 'ADMIN';
    useContactsMock.mockReturnValue({
      data: { items: [], total: 10, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
    });
  });

  // Achado 3 (revisão) — o back só serve GET /contacts/export.xlsx para
  // ADMIN (@Roles('ADMIN')); antes o botão aparecia para qualquer operador,
  // que só descobria a recusa depois de clicar.
  it('quem não é ADMIN não vê o botão', () => {
    authRole = 'OPERATOR';
    wrap(<ContactsPage />);
    expect(
      screen.queryByRole('button', { name: /Exportar planilha/i }),
    ).not.toBeInTheDocument();
  });

  it('exporta com os filtros que a tela está usando', async () => {
    searchState.validity = 'invalid';
    searchState.search = 'ana';
    wrap(<ContactsPage />);
    await userEvent.click(screen.getByRole('button', { name: /Exportar planilha/i }));
    expect(exportMutate).toHaveBeenCalledWith(
      expect.objectContaining({ validity: 'invalid', search: 'ana' }),
    );
  });

  /**
   * Sem filtro E com a base acima do teto, o clique só produziria um 400. Vale
   * mais dizer isso ANTES, com o motivo no `title`, do que depois de 30
   * segundos de espera.
   */
  it('sem filtro e com a base acima do teto, o botão fica desabilitado e explica', () => {
    useContactsMock.mockReturnValue({
      data: { items: [], total: 50_001, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
    });
    wrap(<ContactsPage />);
    const btn = screen.getByRole('button', { name: /Exportar planilha/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/filtro/i);
  });

  it('com filtro ativo o botão volta a funcionar mesmo numa base grande', () => {
    searchState.validity = 'invalid';
    useContactsMock.mockReturnValue({
      data: { items: [], total: 50_001, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
    });
    wrap(<ContactsPage />);
    expect(
      screen.getByRole('button', { name: /Exportar planilha/i }),
    ).toBeEnabled();
  });

  // Fix round 1 — o teste acima só provava que `useExportContacts().mutateAsync`
  // foi chamado com os filtros certos; nada provava que o Blob resolvido de
  // fato vira um download. Este cobre o mecanismo inteiro: `createObjectURL`
  // recebe o Blob, o `<a>` é clicado com o nome de arquivo certo, e a URL é
  // liberada — sem isso, um Blob URL vazaria a cada exportação bem-sucedida.
  it('exportação com sucesso: cria a URL do blob, clica no link com o nome certo e libera a URL', async () => {
    const blob = new Blob(['xlsx-bytes']);
    exportMutate.mockResolvedValue(blob);
    wrap(<ContactsPage />);

    await userEvent.click(screen.getByRole('button', { name: /Exportar planilha/i }));

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy).toHaveBeenCalledWith(blob);

    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(lastAnchorDownload).toMatch(/^contatos-\d{4}-\d{2}-\d{2}\.xlsx$/);

    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(MOCK_EXPORT_BLOB_URL);

    expect(toastError).not.toHaveBeenCalled();
  });

  // Fix round 1 — o caminho de erro (400: teto sem filtro) nunca tinha sido
  // exercitado. `httpError` monta um `HTTPError` de verdade com um corpo
  // problem+json real (mesmo formato do
  // `backend/src/shared/errors/domain-exception.filter.ts`), para provar que
  // `extractApiError` (não mockado) extrai `title`/`detail` e o toast os
  // mostra — e que o botão não fica preso desabilitado depois do erro.
  it('erro 400 (teto sem filtro): mostra o título/mensagem do servidor e o botão continua habilitado', async () => {
    exportMutate.mockRejectedValue(
      httpError(400, {
        type: 'urn:picoa:error:contact.export_too_large',
        title:
          'A seleção tem 51.000 contatos e o limite da planilha é 50.000. Aplique um filtro (cidade, grupo, validação) e exporte por partes.',
        status: 400,
        detail: 'export cap exceeded: 51000 > 50000',
        code: 'contact.export_too_large',
      }),
    );
    wrap(<ContactsPage />);
    const btn = screen.getByRole('button', { name: /Exportar planilha/i });

    await userEvent.click(btn);

    expect(toastError).toHaveBeenCalledWith(
      'A seleção tem 51.000 contatos e o limite da planilha é 50.000. Aplique um filtro (cidade, grupo, validação) e exporte por partes.',
      { description: 'export cap exceeded: 51000 > 50000' },
    );
    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('Exportar planilha');
  });

  // Fix round 1 — mesma forma do 400 acima, mas o 403 de "só ADMIN" que
  // `@Roles('ADMIN')`/`RolesGuard` produzem para um operador
  // (`backend/src/modules/auth/roles.guard.ts`).
  it('erro 403 (apenas ADMIN): mostra a mensagem do servidor e o botão continua habilitado', async () => {
    exportMutate.mockRejectedValue(
      httpError(403, {
        type: 'urn:picoa:error:auth.insufficient_role',
        title: 'Requires role: ADMIN',
        status: 403,
        detail: 'Apenas administradores podem exportar a planilha de contatos.',
        code: 'auth.insufficient_role',
      }),
    );
    wrap(<ContactsPage />);
    const btn = screen.getByRole('button', { name: /Exportar planilha/i });

    await userEvent.click(btn);

    expect(toastError).toHaveBeenCalledWith('Requires role: ADMIN', {
      description: 'Apenas administradores podem exportar a planilha de contatos.',
    });
    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('Exportar planilha');
  });
});

function makeInvalidListItem() {
  return {
    id: 'c1',
    phoneE164: '+5592995550101',
    name: 'Ana',
    city: null,
    group: null,
    tags: [],
    optedOut: false,
    whatsappValid: false,
    whatsappCheckedAt: null,
    profilePictureUrl: null,
    waLabels: [],
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-01T10:00:00Z',
    marketingUndeliverableAt: null,
    marketingUndeliverableCode: null,
    marketingUndeliverableReason: null,
    lastFailureReason: 'SEM_WHATSAPP',
    lastFailureCode: null,
    lastFailureAt: null,
    failureCount: 1,
    campaignsReceived: { count: 0, names: [] },
  };
}

describe('ContactsPage — apagar inválidos confirmados (B.3)', () => {
  const refetchSpy = vi.fn();

  beforeEach(() => {
    searchState.page = 1;
    searchState.search = undefined;
    searchState.failureReason = undefined;
    searchState.receivedCampaignId = undefined;
    searchState.validity = 'invalid';
    bulkDeleteMutate.mockClear();
    bulkDeleteMutate.mockResolvedValue({ deleted: 120 });
    refetchSpy.mockClear();
    authRole = 'ADMIN';
    useContactsMock.mockReturnValue({
      data: {
        items: [makeInvalidListItem()],
        total: 120,
        page: 1,
        pageSize: 50,
      },
      isLoading: false,
      isError: false,
      refetch: refetchSpy,
    });
  });

  it('o botão só existe com o filtro "inválidos" ativo, e traz a contagem', () => {
    wrap(<ContactsPage />);
    expect(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    ).toBeInTheDocument();
  });

  it('sem o filtro de inválidos, o botão não aparece', () => {
    searchState.validity = undefined;
    wrap(<ContactsPage />);
    expect(
      screen.queryByRole('button', { name: /Apagar inválidos confirmados/ }),
    ).not.toBeInTheDocument();
  });

  it('quem não é ADMIN não vê o botão', () => {
    authRole = 'OPERATOR';
    wrap(<ContactsPage />);
    expect(
      screen.queryByRole('button', { name: /Apagar inválidos confirmados/ }),
    ).not.toBeInTheDocument();
  });

  /**
   * Fix round 1 — a exclusão apaga por PREDICADO (`validity: 'invalid'`),
   * sempre TODOS os inválidos, nunca só o recorte de uma busca. Com "busca"
   * ligada junto de "inválidos", `data.total` é só o recorte (ex.: 3 de
   * 120) — mostrar/confirmar esse número faria o operador digitar um N que o
   * servidor NUNCA vê bater (ele conta TODOS os inválidos, sem o recorte), e
   * a resposta seria sempre 409. Por isso o botão some e vira uma nota.
   */
  it('com outro filtro (busca) ligado junto de "inválidos", o botão some e uma nota explica por quê', () => {
    searchState.search = 'ana';
    wrap(<ContactsPage />);
    expect(
      screen.queryByRole('button', { name: /Apagar inválidos confirmados/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/limpe os outros filtros/i)).toBeInTheDocument();
  });

  it('sem outro filtro além de "inválidos", o botão volta a aparecer', () => {
    wrap(<ContactsPage />);
    expect(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/limpe os outros filtros/i)).not.toBeInTheDocument();
  });

  /**
   * ★ O AVISO DUPLO da spec, mais a cláusula de consentimento (T9): apagar o
   * contato apaga também as mensagens dele — inclusive as falhas que PROVAVAM
   * a invalidez e as linhas de campanhas passadas — E os registros de
   * consentimento (`ContactConsent`, mesma cascata). O opt-out sobrevive à
   * exclusão porque mora na `SuppressionList` por `phoneHash`, não no
   * Contact. E uma reimportação da planilha traz todo mundo de volta.
   */
  it('a confirmação avisa do histórico apagado, do consentimento E da reimportação', async () => {
    wrap(<ContactsPage />);
    await userEvent.click(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Exporte a planilha antes/i);
    expect(dialog).toHaveTextContent(/histórico de mensagens/i);
    expect(dialog).toHaveTextContent(/consentimento/i);
    expect(dialog).toHaveTextContent(/reimportação/i);
  });

  it('só libera o botão depois de digitar a contagem exata', async () => {
    wrap(<ContactsPage />);
    await userEvent.click(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    );
    const confirm = screen.getByRole('button', { name: /^Apagar 120$/ });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Digite 120 para confirmar/i), '12');
    expect(screen.getByRole('button', { name: /^Apagar 120$/ })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Digite 120 para confirmar/i), '0');
    expect(screen.getByRole('button', { name: /^Apagar 120$/ })).toBeEnabled();
  });

  // Repo rule (T9): a confirmação aceita tanto o número puro quanto o
  // formato com separador de milhar — o mesmo que a tela mostra em toda
  // outra contagem (`toLocaleString('pt-BR')`).
  it('a confirmação aceita a contagem com separador de milhar ("1.234")', async () => {
    useContactsMock.mockReturnValue({
      data: {
        items: [makeInvalidListItem()],
        total: 1234,
        page: 1,
        pageSize: 50,
      },
      isLoading: false,
      isError: false,
      refetch: refetchSpy,
    });
    wrap(<ContactsPage />);
    await userEvent.click(
      screen.getByRole('button', {
        name: /Apagar inválidos confirmados \(1\.234\)/,
      }),
    );
    const confirm = screen.getByRole('button', { name: /^Apagar 1\.234$/ });
    const field = screen.getByLabelText(/Digite 1\.234 para confirmar/i);

    await userEvent.type(field, '1.234');
    expect(confirm).toBeEnabled();

    await userEvent.clear(field);
    await userEvent.type(field, '1234');
    expect(confirm).toBeEnabled();
  });

  it('confirmado, chama a API com { validity: "invalid", expectedCount } — nunca com ids', async () => {
    wrap(<ContactsPage />);
    await userEvent.click(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    );
    await userEvent.type(screen.getByLabelText(/Digite 120 para confirmar/i), '120');
    await userEvent.click(screen.getByRole('button', { name: /^Apagar 120$/ }));

    expect(bulkDeleteMutate).toHaveBeenCalledWith({
      validity: 'invalid',
      expectedCount: 120,
    });
  });

  /**
   * Fix round 1 — `deleted` PODE ser menor que `expectedCount`/N: o back trava
   * o delete em `updatedAt <= snapshot` (o instante ANTES de contar), então
   * uma linha que virou inválida DEPOIS do snapshot não entra no delete. O
   * mock usa 118 (≠ 120, o `total` mockado) de propósito — se o componente
   * mostrasse `invalidCount` em vez de `r.deleted` no toast, este teste
   * pegaria.
   */
  it('sucesso: toast mostra o que o SERVIDOR de fato apagou (pode ser menor que N)', async () => {
    bulkDeleteMutate.mockResolvedValue({ deleted: 118 });
    wrap(<ContactsPage />);
    await userEvent.click(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    );
    await userEvent.type(screen.getByLabelText(/Digite 120 para confirmar/i), '120');
    await userEvent.click(screen.getByRole('button', { name: /^Apagar 120$/ }));

    expect(toastSuccess).toHaveBeenCalledWith('118 contato(s) inválido(s) excluído(s)');
    // Sem refetch aqui: `useBulkDeleteContacts` já invalida a árvore de
    // contatos no `onSuccess` — um segundo refetch explícito seria redundante
    // (mantido só no ramo 409, onde nada foi invalidado).
    expect(refetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  /**
   * T9 (achado do controller depois do brief): `expectedCount` faz o back
   * recusar com 409 quando a contagem viva já não bate com o que o operador
   * confirmou — nada é apagado. A tela mostra a mensagem do servidor,
   * atualiza a lista (para o operador ver a contagem nova) e NUNCA reenvia a
   * mutação sozinha: fechar o diálogo e limpar o campo digitado já obrigam
   * reabrir e confirmar de novo.
   */
  it('erro 409 (a contagem mudou): mostra a mensagem do servidor, atualiza a lista e não reenvia sozinho', async () => {
    bulkDeleteMutate.mockRejectedValue(
      httpError(409, {
        type: 'urn:picoa:error:contact.bulk_delete_count_mismatch',
        title:
          'A lista mudou: agora são 115 contatos inválidos, e você confirmou 120. Atualize a página e confirme de novo.',
        status: 409,
        code: 'contact.bulk_delete_count_mismatch',
      }),
    );
    wrap(<ContactsPage />);
    await userEvent.click(
      screen.getByRole('button', { name: /Apagar inválidos confirmados \(120\)/ }),
    );
    await userEvent.type(screen.getByLabelText(/Digite 120 para confirmar/i), '120');
    await userEvent.click(screen.getByRole('button', { name: /^Apagar 120$/ }));

    // Fix round 1 — SEM `description`: em produção o `message` de
    // `extractApiError` seria o texto genérico do ky (`error.message`, em
    // inglês), não a explicação do servidor. A frase com os dois números —
    // o que importa aqui — está no `title`.
    expect(toastError).toHaveBeenCalledWith(
      'A lista mudou: agora são 115 contatos inválidos, e você confirmou 120. Atualize a página e confirme de novo.',
    );
    expect(refetchSpy).toHaveBeenCalled();
    expect(bulkDeleteMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
