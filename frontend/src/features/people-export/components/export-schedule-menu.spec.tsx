import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

const mocks = vi.hoisted(() => ({ get: vi.fn(), toastError: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { ExportScheduleMenu } from './export-schedule-menu';

// Radix (dropdown) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const blob = new Blob(['planilha']);

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
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExportScheduleMenu sectorId="s1" from="2026-11-16" to="2026-11-22" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

// `findBy`: enquanto a exportação anterior baixa o botão se chama "Exportando…".
const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: 'Exportar' }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    headers: new Headers(),
    blob: () => Promise.resolve(blob),
  });
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

describe('ExportScheduleMenu', () => {
  it('não aparece sem pessoas.exportar', () => {
    setup(['escala.alterar']);

    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
  });

  it('CSV e XLSX exportam o setor e o período recebidos', async () => {
    const user = setup(['pessoas.exportar']);

    await openMenu(user);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['CSV', 'XLSX']);
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'XLSX' }));

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    const query = (format: string) => ({
      searchParams: {
        format,
        sectorId: 's1',
        from: '2026-11-16',
        to: '2026-11-22',
      },
      timeout: 120_000,
      retry: 0,
    });
    expect(mocks.get).toHaveBeenNthCalledWith(1, 'internal/people-export/schedule', query('csv'));
    expect(mocks.get).toHaveBeenNthCalledWith(2, 'internal/people-export/schedule', query('xlsx'));
  });

  it('erro chama toast.error com o texto da API', async () => {
    const detail = 'Período de até 42 dias.';
    const error = new HTTPError(new Response(null, { status: 422 }), new Request('http://localhost/x'), {} as never);
    error.data = { detail } as HTTPError['data'];
    mocks.get.mockRejectedValue(error);
    const user = setup(['pessoas.exportar']);

    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'XLSX' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(detail));
  });
});
