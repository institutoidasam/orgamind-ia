import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' } as { role: string } | null,
  redirect: vi.fn((opts: Record<string, unknown>) => ({ __redirect: opts })),
  useShifts: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: mocks.redirect,
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: { getState: () => ({ user: mocks.user }) },
}));
vi.mock('@/features/shifts/api', () => ({
  useShifts: () => mocks.useShifts(),
  useCreateShift: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateShift: () => ({ mutateAsync: mocks.update, isPending: false }),
  useReorderShifts: () => ({ mutateAsync: mocks.reorder, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));

import { Route } from './index';

const route = Route as unknown as { component: ComponentType; beforeLoad: () => void };

const first = { id: 'shift_first', name: '1º turno', startTime: '06:00', endTime: '14:00', isActive: true, sortOrder: 1, crossesMidnight: false, inUse: [] };
const second = { id: 'shift_second', name: '2º turno', startTime: '14:00', endTime: '22:00', isActive: true, sortOrder: 2, crossesMidnight: false, inUse: [{ kind: 'users', count: 3 }] };
const night = { id: 'shift_night', name: 'Noite', startTime: '22:00', endTime: '06:00', isActive: false, sortOrder: 3, crossesMidnight: true, inUse: [] };

function conflict(code: string) {
  const response = new Response(JSON.stringify({ code }), { status: 409 });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

function rowOf(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) });
}

type User = ReturnType<typeof userEvent.setup>;

/** Abre "Novo turno" e preenche Noite 22:00–06:00; devolve o diálogo. */
async function fillNewNightShift(user: User) {
  await user.click(screen.getByRole('button', { name: 'Novo turno' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Nome'), 'Noite');
  await user.type(within(dialog).getByLabelText('Início'), '22:00');
  await user.type(within(dialog).getByLabelText('Fim'), '06:00');
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { role: 'ADMIN' };
  mocks.useShifts.mockReturnValue({ data: [first, second, night], isLoading: false, isError: false });
  for (const fn of [mocks.create, mocks.update, mocks.reorder]) fn.mockResolvedValue(undefined);
});

describe('/turnos: lista e ações', () => {
  it('lista na ordem com "22:00–06:00" e o selo "atravessa a meia-noite"', () => {
    render(<route.component />);
    const rows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual([
      expect.stringContaining('1º turno'),
      expect.stringContaining('2º turno'),
      expect.stringContaining('Noite'),
    ]);
    expect(within(rowOf('Noite')).getByText('22:00–06:00')).toBeInTheDocument();
    expect(within(rowOf('Noite')).getByText('atravessa a meia-noite')).toBeInTheDocument();
    expect(screen.getAllByText('atravessa a meia-noite')).toHaveLength(1);
  });

  it('"Desativar" fica desabilitado e mostra o texto de em uso', () => {
    render(<route.component />);
    const row = rowOf('2º turno');
    expect(within(row).getByRole('button', { name: 'Desativar' })).toBeDisabled();
    expect(within(row).getByText('Em uso: 3 pessoa(s) com este turno no cadastro')).toBeInTheDocument();
    expect(within(rowOf('1º turno')).getByRole('button', { name: 'Desativar' })).toBeEnabled();
  });

  it('"Reativar" envia { isActive: true }', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(within(rowOf('Noite')).getByRole('button', { name: 'Reativar' }));
    expect(mocks.update).toHaveBeenCalledWith({ id: 'shift_night', isActive: true });
  });

  it('"Subir" no 2º turno envia a ordem [shift_second, shift_first, shift_night]', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    expect(within(rowOf('1º turno')).getByRole('button', { name: 'Subir' })).toBeDisabled();
    await user.click(within(rowOf('2º turno')).getByRole('button', { name: 'Subir' }));
    expect(mocks.reorder).toHaveBeenCalledWith(['shift_second', 'shift_first', 'shift_night']);
  });

  it('409 shifts.in_use ao desativar vira o aviso "Este turno está em uso e não pode ser desativado."', async () => {
    mocks.update.mockRejectedValue(conflict('shifts.in_use'));
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(within(rowOf('1º turno')).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Este turno está em uso e não pode ser desativado.'));
  });
});

describe('/turnos: formulário', () => {
  it('"Novo turno" envia { name, startTime, endTime }', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    const dialog = await fillNewNightShift(user);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ name: 'Noite', startTime: '22:00', endTime: '06:00' }));
  });

  it('"Editar" abre o turno preenchido e envia o PATCH com o id', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(within(rowOf('1º turno')).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Início')).toHaveValue('06:00');
    await user.clear(within(dialog).getByLabelText('Nome'));
    await user.type(within(dialog).getByLabelText('Nome'), 'Manhã');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: 'shift_first', name: 'Manhã', startTime: '06:00', endTime: '14:00' }));
  });

  it('409 shifts.name_taken mostra "Já existe um turno com esse nome."', async () => {
    mocks.create.mockRejectedValue(conflict('shifts.name_taken'));
    const user = userEvent.setup();
    render(<route.component />);
    const dialog = await fillNewNightShift(user);
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Já existe um turno com esse nome.')).toBeInTheDocument();
  });
});

describe('/turnos: acesso', () => {
  it('não ADMIN não vê a tela: é redirecionado para /dashboard', () => {
    mocks.user = { role: 'OPERATOR' };
    expect(() => route.beforeLoad()).toThrow();
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/dashboard' });
  });

  it('ADMIN entra', () => {
    expect(() => route.beforeLoad()).not.toThrow();
  });
});
