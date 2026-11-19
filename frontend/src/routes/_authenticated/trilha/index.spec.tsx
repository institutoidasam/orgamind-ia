import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' } as { role: string } | null,
  redirect: vi.fn((opts: Record<string, unknown>) => ({ __redirect: opts })),
  get: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: mocks.redirect,
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: { getState: () => ({ user: mocks.user }) },
}));
vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));

import { Route } from './index';

const route = Route as unknown as { component: ComponentType; beforeLoad: () => void };

const edited = {
  id: 'a1',
  createdAt: '2026-11-19T14:30:00.000Z',
  action: 'user.profile_updated',
  category: 'PERSON',
  actor: { id: 'u1', name: 'Ana Admin' },
  subject: { id: 'u2', name: 'Maria Souza', registration: '1234' },
  reason: 'Troca de número',
  changes: [
    { field: 'phone', before: '•••• 1234', after: '•••• 5678' },
    { field: 'contactAuthorization', before: 'NAO_AUTORIZADO', after: 'AUTORIZADO' },
  ],
};
const legacy = {
  id: 'a2',
  createdAt: '2026-10-01T12:00:00.000Z',
  action: 'user.updated',
  category: 'PERSON',
  actor: { id: 'u1', name: 'Ana Admin' },
  subject: { id: 'u3', name: 'João Lima', registration: null },
  reason: null,
  changes: null,
};

function pageOf(items: unknown[], extra: { total?: number; page?: number } = {}) {
  return { items, total: extra.total ?? items.length, page: extra.page ?? 1, pageSize: 20 };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <route.component />
    </QueryClientProvider>,
  );
}

function lastSearchParams() {
  return mocks.get.mock.lastCall?.[1].searchParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { role: 'ADMIN' };
  mocks.get.mockImplementation((_path: string, options: { searchParams: { page: number } }) => ({
    json: () => Promise.resolve(pageOf([edited, legacy], { page: options.searchParams.page })),
  }));
});

describe('/trilha: guarda de acesso', () => {
  it.each(['SUPERVISOR', 'OPERATOR', 'VIEWER'])('%s é redirecionado para /dashboard', (role) => {
    mocks.user = { role };
    expect(() => route.beforeLoad()).toThrow();
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/dashboard' });
  });

  it('ADMIN entra', () => {
    expect(() => route.beforeLoad()).not.toThrow();
  });
});

describe('/trilha: lista', () => {
  it('mostra autor, data e hora, tipo, pessoa, motivo e o antes e depois por extenso', async () => {
    renderScreen();
    const row = within(await screen.findByRole('row', { name: /Maria Souza/ }));
    expect(row.getByText('Ana Admin')).toBeInTheDocument();
    expect(row.getByText('19/11/2026 10:30')).toBeInTheDocument();
    expect(row.getByText('Dados da pessoa alterados')).toBeInTheDocument();
    expect(row.getByText('Matrícula 1234')).toBeInTheDocument();
    expect(row.getByText('Troca de número')).toBeInTheDocument();
    expect(row.getByText('Telefone: •••• 1234 → •••• 5678')).toBeInTheDocument();
    expect(row.getByText('Autorização de contato: Sem autorização → Autorizado')).toBeInTheDocument();
    expect(screen.queryByText(/NAO_AUTORIZADO/)).not.toBeInTheDocument();
  });

  it('registro antigo, sem antes e depois, avisa que não há detalhe', async () => {
    renderScreen();
    const row = within(await screen.findByRole('row', { name: /João Lima/ }));
    expect(row.getByText('Sem detalhe das alterações')).toBeInTheDocument();
  });

  it('sem registros mostra o aviso', async () => {
    mocks.get.mockReturnValue({ json: () => Promise.resolve(pageOf([])) });
    renderScreen();
    expect(await screen.findByText('Nenhum registro encontrado.')).toBeInTheDocument();
  });
});

describe('/trilha: filtros e páginas', () => {
  it('pessoa, período e tipo viram a consulta; limpar volta ao começo', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole('row', { name: /Maria Souza/ });
    expect(lastSearchParams()).toEqual({ page: 1, pageSize: 20 });

    await user.type(screen.getByLabelText('Pessoa (nome ou matrícula)'), ' maria ');
    await user.type(screen.getByLabelText('De'), '2026-11-01');
    await user.type(screen.getByLabelText('Até'), '2026-11-19');
    await user.selectOptions(screen.getByLabelText('Tipo'), 'Pessoa');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(lastSearchParams()).toEqual({
        q: 'maria', from: '2026-11-01', to: '2026-11-19', category: 'PERSON', page: 1, pageSize: 20,
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Limpar' }));
    await waitFor(() => expect(lastSearchParams()).toEqual({ page: 1, pageSize: 20 }));
    expect(screen.getByLabelText('Pessoa (nome ou matrícula)')).toHaveValue('');
  });

  it('pagina: Próxima pede a página 2 e Anterior volta', async () => {
    mocks.get.mockImplementation((_path: string, options: { searchParams: { page: number } }) => ({
      json: () => Promise.resolve(pageOf([edited], { total: 45, page: options.searchParams.page })),
    }));
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 2 de 3')).toBeInTheDocument();
    expect(lastSearchParams()).toMatchObject({ page: 2 });

    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(await screen.findByText('Página 1 de 3')).toBeInTheDocument();
  });
});
