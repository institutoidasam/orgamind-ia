import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({ api: http }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }));

import { useLevels } from '../api';
import { LevelsTable } from './levels-table';

const base = { isActive: true, userCount: 0, activePeople: 0, inactivePeople: 0 };
const busy = { ...base, id: 'lvl_busy', name: 'Coordenador', sortOrder: 1, userCount: 3, activePeople: 3 };
const idle = { ...base, id: 'lvl_idle', name: 'Operador', sortOrder: 2, userCount: 2, inactivePeople: 2 };
const off = { ...base, id: 'lvl_off', name: 'Estagiário', sortOrder: 3, isActive: false, userCount: 1, activePeople: 1 };

function conflict(code: string) {
  return new HTTPError(new Response(JSON.stringify({ code }), { status: 409 }), new Request('https://x'), {} as never);
}

function Page() {
  const levels = useLevels();
  return <LevelsTable loading={levels.isLoading} items={levels.data ?? []} onEdit={vi.fn()} />;
}

function renderPage(items: unknown[]) {
  http.get.mockReturnValue({ json: () => Promise.resolve({ items }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => screen.findByRole('row', { name: new RegExp(name) });

beforeEach(() => {
  vi.clearAllMocks();
  http.patch.mockReturnValue({ json: () => Promise.resolve({ ...idle, isActive: false }) });
});

describe('levels-table: nível em uso (E4–E6, aceites 14 e 15)', () => {
  it('aceite 14: nível com pessoa ativa — Desativar desligado com Em uso e as linhas', async () => {
    renderPage([busy, idle]);
    const row = within(await rowOf('Coordenador'));
    expect(row.getByText('Em uso: não pode ser inativado')).toBeTruthy();
    expect(row.getByText('3 pessoa(s) ativa(s) com este nível')).toBeTruthy();
    expect(row.getByText('Para liberar:')).toBeTruthy();
    expect(row.getByText('Troque o nível no cadastro das pessoas.')).toBeTruthy();
    expect((row.getByRole('button', { name: 'Desativar' }) as HTMLButtonElement).disabled).toBe(true);
    const free = within(await rowOf('Operador'));
    expect(free.queryByText('Em uso: não pode ser inativado')).toBeNull();
    expect((free.getByRole('button', { name: 'Desativar' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('aceite 14: sem uso — Desativar abre a confirmação; Cancelar não grava; Desativar grava', async () => {
    const user = userEvent.setup();
    renderPage([busy, idle]);
    await user.click(within(await rowOf('Operador')).getByRole('button', { name: 'Desativar' }));
    expect(screen.getByText('Desativar o nível Operador? Ele sai do cadastro novo e do filtro de envio.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(http.patch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(within(await rowOf('Operador')).getByRole('button', { name: 'Desativar' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('internal/levels/lvl_idle', { json: { isActive: false } }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

});

describe('levels-table: recusa do servidor e estados sem bloqueio (E5, E6)', () => {
  it('aceite 15: 409 levels.in_use — mensagem e nova chamada à lista', async () => {
    const user = userEvent.setup();
    renderPage([busy, idle]);
    http.patch.mockReturnValue({ json: () => Promise.reject(conflict('levels.in_use')) });
    await user.click(within(await rowOf('Operador')).getByRole('button', { name: 'Desativar' }));
    expect(http.get).toHaveBeenCalledTimes(1);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Este nível está em uso e não pode ser desativado.'));
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Reativar sem confirmação, mesmo com pessoa ativa no nível', async () => {
    const user = userEvent.setup();
    renderPage([off]);
    await user.click(within(await rowOf('Estagiário')).getByRole('button', { name: 'Reativar' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('internal/levels/lvl_off', { json: { isActive: true } }));
  });

  it('mostra N pessoa(s) inativa(s) mantêm o vínculo só quando há', async () => {
    renderPage([busy, idle]);
    expect(within(await rowOf('Operador')).getByText('2 pessoa(s) inativa(s) mantêm o vínculo')).toBeTruthy();
    expect(within(await rowOf('Coordenador')).queryByText(/inativa\(s\) mantêm o vínculo/)).toBeNull();
  });
});
