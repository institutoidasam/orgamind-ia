import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));

import { ExportPeopleButton } from './export-people-button';

const OPTIONS = {
  today: '2026-11-19',
  sectors: [{ id: 's1', name: 'Produção' }],
  shifts: [],
};

function setup(permissions: AuthUser['permissions']) {
  const user: AuthUser = {
    id: 'u1',
    email: 'a@b.com',
    name: 'Ana',
    role: 'SUPERVISOR',
    permissions,
  };
  useAuthStore.setState({
    accessToken: 'tok',
    user,
    mustChangePassword: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExportPeopleButton defaultSectorId="s1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ json: () => Promise.resolve(OPTIONS) });
});

describe('ExportPeopleButton', () => {
  it('não aparece sem pessoas.exportar', () => {
    setup(['pessoas.editar']);

    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('abre o diálogo', async () => {
    setup(['pessoas.exportar']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Exportar' }));

    expect(await screen.findByRole('dialog', { name: 'Exportar pessoas' })).toBeInTheDocument();
  });
});
