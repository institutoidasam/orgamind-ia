import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toastError: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { ExportPeopleDialog } from './export-people-dialog';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const OPTIONS = {
  today: '2026-11-19',
  sectors: [
    { id: 's1', name: 'Produção' },
    { id: 's2', name: 'Logística' },
  ],
  shifts: [{ id: 'manha', name: 'Manhã', startTime: '06:00', endTime: '14:00' }],
};
const DATE_PHRASE =
  'Em data passada, setor, turno e nível são os que valiam naquele dia. Telefone, função e situação são sempre os atuais.';
const blob = new Blob(['planilha']);

type User = ReturnType<typeof userEvent.setup>;

function ky2Error(status: number, data: unknown) {
  const error = new HTTPError(new Response(null, { status }), new Request('http://localhost/x'), {} as never);
  error.data = data as HTTPError['data'];
  return error;
}

/** `get` responde como o ky: as opções por `.json()`, a planilha por `headers` e `.blob()`. */
function route(
  exportResult: () => unknown = () => ({
    headers: new Headers(),
    blob: () => Promise.resolve(blob),
  }),
) {
  mocks.get.mockImplementation((path: string) => {
    if (path.startsWith('internal/staff-schedule/options')) {
      return { json: () => Promise.resolve(OPTIONS) };
    }
    return Promise.resolve().then(exportResult);
  });
}

function setup(
  props: {
    defaultSectorId?: string;
    permissions?: AuthUser['permissions'];
  } = {},
) {
  const user: AuthUser = {
    id: 'u1',
    email: 'a@b.com',
    name: 'Ana',
    role: 'ADMIN',
    permissions: props.permissions,
  };
  useAuthStore.setState({
    accessToken: 'tok',
    user,
    mustChangePassword: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExportPeopleDialog open onOpenChange={mocks.onOpenChange} defaultSectorId={props.defaultSectorId} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const field = (name: string) => screen.findByRole('combobox', { name });
const exportButton = () => screen.getByRole('button', { name: /^Exporta/ });

async function optionsOf(user: User, name: string): Promise<string[]> {
  await user.click(await field(name));
  const labels = screen.getAllByRole('option').map((option) => option.textContent ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

beforeEach(() => {
  vi.clearAllMocks();
  route();
});

describe('ExportPeopleDialog: campos', () => {
  it('campos, opções e frase da data de referência com os textos da spec', async () => {
    const user = setup();

    expect(await screen.findByRole('heading', { name: 'Exportar pessoas' })).toBeInTheDocument();
    expect(await optionsOf(user, 'Formato')).toEqual(['CSV', 'XLSX']);
    expect(await optionsOf(user, 'Setor')).toEqual(['Todos os setores', 'Produção', 'Logística']);
    expect(await optionsOf(user, 'Turno')).toEqual(['Todos', 'Manhã']);
    expect(await optionsOf(user, 'Situação')).toEqual(['Ativas', 'Inativas', 'Todas']);
    expect(screen.getByLabelText('Data de referência')).toBeInTheDocument();
    expect(screen.getByText(DATE_PHRASE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('padrões: XLSX, Todos os setores, Todos, Ativas e a data de hoje das opções', async () => {
    setup();

    await waitFor(() => expect(screen.getByLabelText('Data de referência')).toHaveValue('2026-11-19'));
    expect(await field('Formato')).toHaveTextContent('XLSX');
    expect(await field('Setor')).toHaveTextContent('Todos os setores');
    expect(await field('Turno')).toHaveTextContent('Todos');
    expect(await field('Situação')).toHaveTextContent('Ativas');
  });

  it('defaultSectorId já vem escolhido', async () => {
    setup({ defaultSectorId: 's2' });

    await waitFor(async () => expect(await field('Setor')).toHaveTextContent('Logística'));
  });

  it('mostra "O telefone sairá mascarado." só sem telefone.ver_completo', async () => {
    setup({ permissions: ['pessoas.exportar'] });
    expect(await screen.findByText('O telefone sairá mascarado.')).toBeInTheDocument();
  });

  it('não mostra o aviso do telefone com telefone.ver_completo', async () => {
    setup({ permissions: ['pessoas.exportar', 'telefone.ver_completo'] });
    await field('Formato');
    expect(screen.queryByText('O telefone sairá mascarado.')).not.toBeInTheDocument();
  });
});

describe('ExportPeopleDialog: setor padrão fora das opções', () => {
  it('cai em "Todos os setores" e exporta sem sectorId', async () => {
    const user = setup({ defaultSectorId: 'setor-fora-da-lista' });
    await waitFor(() => expect(screen.getByLabelText('Data de referência')).toHaveValue('2026-11-19'));

    expect(await field('Setor')).toHaveTextContent('Todos os setores');
    await user.click(exportButton());

    await waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false));
    const [, options] = mocks.get.mock.calls.find(([path]) => path === 'internal/people-export/people') ?? [];
    expect(options.searchParams).not.toHaveProperty('sectorId');
  });
});

describe('ExportPeopleDialog: exportar', () => {
  it('Exportar envia os filtros e fecha', async () => {
    const user = setup();
    await waitFor(() => expect(screen.getByLabelText('Data de referência')).toHaveValue('2026-11-19'));
    await user.click(await field('Formato'));
    await user.click(screen.getByRole('option', { name: 'CSV' }));
    await user.click(await field('Setor'));
    await user.click(screen.getByRole('option', { name: 'Produção' }));
    await user.click(await field('Situação'));
    await user.click(screen.getByRole('option', { name: 'Todas' }));

    await user.click(exportButton());

    await waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.get).toHaveBeenCalledWith('internal/people-export/people', {
      searchParams: {
        format: 'csv',
        sectorId: 's1',
        status: 'all',
        date: '2026-11-19',
      },
      timeout: 120_000,
      retry: 0,
    });
  });

  it('erro chama toast.error com o texto da API e não fecha', async () => {
    const detail = 'A planilha passaria de 50 mil pessoas. Escolha um setor ou turno.';
    route(() => Promise.reject(ky2Error(422, { code: 'people_export.too_large', detail })));
    const user = setup();
    await waitFor(() => expect(screen.getByLabelText('Data de referência')).toHaveValue('2026-11-19'));

    await user.click(exportButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(detail));
    expect(mocks.onOpenChange).not.toHaveBeenCalled();
    expect(exportButton()).toBeEnabled();
  });
});

describe('ExportPeopleDialog: opções com falha', () => {
  it('falha ao carregar as opções mostra erro com o texto da API e desabilita Exportar', async () => {
    const detail = 'Você não gerencia nenhum setor.';
    mocks.get.mockReturnValue({
      json: () => Promise.reject(ky2Error(403, { detail })),
    });
    setup();

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(exportButton()).toBeDisabled();
  });

  it('sem texto da API usa "Não foi possível carregar as opções. Tente de novo."', async () => {
    mocks.get.mockReturnValue({
      json: () => Promise.reject(new Error('rede')),
    });
    setup();

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as opções. Tente de novo.');
  });
});
