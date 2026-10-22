import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' } as { role: string } | null,
  redirect: vi.fn((opts: Record<string, unknown>) => ({ __redirect: opts })),
  useLevels: vi.fn(),
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
vi.mock('@/features/levels/api', () => ({
  useLevels: () => mocks.useLevels(),
  useCreateLevel: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateLevel: () => ({ mutateAsync: mocks.update, isPending: false }),
  useReorderLevels: () => ({ mutateAsync: mocks.reorder, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));

import { Route } from './index';

const route = Route as unknown as { component: ComponentType; beforeLoad: () => void };

const coordinator = { id: 'lvl_coord', name: 'Coordenador', isActive: true, sortOrder: 1, userCount: 2 };
const leader = { id: 'lvl_leader', name: 'Líder', isActive: true, sortOrder: 2, userCount: 5 };
const staff = { id: 'lvl_staff', name: 'Funcionário', isActive: true, sortOrder: 3, userCount: 12 };
const operator = { id: 'lvl_operator', name: 'Operador', isActive: true, sortOrder: 4, userCount: 0 };

function conflict(code: string) {
  const response = new Response(JSON.stringify({ code }), { status: 409 });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

function rowOf(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { role: 'ADMIN' };
  mocks.useLevels.mockReturnValue({ data: [coordinator, leader, staff, operator], isLoading: false, isError: false });
  for (const fn of [mocks.create, mocks.update, mocks.reorder]) fn.mockResolvedValue(undefined);
});

describe('/niveis: lista e ações', () => {
  it('lista Coordenador, Líder, Funcionário, Operador na ordem com a contagem de pessoas', () => {
    render(<route.component />);
    const rows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual([
      expect.stringContaining('Coordenador'),
      expect.stringContaining('Líder'),
      expect.stringContaining('Funcionário'),
      expect.stringContaining('Operador'),
    ]);
    expect(within(rowOf('Funcionário')).getByText('12 pessoa(s)')).toBeInTheDocument();
    expect(within(rowOf('Operador')).getByText('0 pessoa(s)')).toBeInTheDocument();
  });

  it('"Desativar" envia { isActive: false } e o nível inativo mostra "Reativar"', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<route.component />);
    await user.click(within(rowOf('Operador')).getByRole('button', { name: 'Desativar' }));
    expect(mocks.update).toHaveBeenCalledWith({ id: 'lvl_operator', isActive: false });
    mocks.useLevels.mockReturnValue({ data: [coordinator, leader, staff, { ...operator, isActive: false }], isLoading: false, isError: false });
    rerender(<route.component />);
    expect(within(rowOf('Operador')).getByText('Inativo')).toBeInTheDocument();
    await user.click(within(rowOf('Operador')).getByRole('button', { name: 'Reativar' }));
    expect(mocks.update).toHaveBeenLastCalledWith({ id: 'lvl_operator', isActive: true });
  });

  it('"Subir" no Líder envia a ordem [lvl_leader, lvl_coord, lvl_staff, lvl_operator]', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    expect(within(rowOf('Coordenador')).getByRole('button', { name: 'Subir' })).toBeDisabled();
    expect(within(rowOf('Operador')).getByRole('button', { name: 'Descer' })).toBeDisabled();
    await user.click(within(rowOf('Líder')).getByRole('button', { name: 'Subir' }));
    expect(mocks.reorder).toHaveBeenCalledWith(['lvl_leader', 'lvl_coord', 'lvl_staff', 'lvl_operator']);
  });

  it('422 levels.invalid_order ao reordenar vira o aviso de lista desatualizada', async () => {
    mocks.reorder.mockRejectedValue(new HTTPError(new Response(JSON.stringify({ code: 'levels.invalid_order' }), { status: 422 }), new Request('https://x'), {} as never));
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(within(rowOf('Líder')).getByRole('button', { name: 'Descer' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('A lista de níveis mudou. Atualize a página e tente de novo.'));
  });
});

describe('/niveis: formulário', () => {
  it('"Novo nível" chama POST com o nome aparado', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(screen.getByRole('button', { name: 'Novo nível' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), '  Gerente  ');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ name: 'Gerente' }));
  });

  it('renomear Funcionário chama PATCH { name }', async () => {
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(within(rowOf('Funcionário')).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Nome')).toHaveValue('Funcionário');
    await user.clear(within(dialog).getByLabelText('Nome'));
    await user.type(within(dialog).getByLabelText('Nome'), 'Colaborador');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: 'lvl_staff', name: 'Colaborador' }));
  });

  it('409 levels.name_taken mostra "Já existe um nível com esse nome."', async () => {
    mocks.create.mockRejectedValue(conflict('levels.name_taken'));
    const user = userEvent.setup();
    render(<route.component />);
    await user.click(screen.getByRole('button', { name: 'Novo nível' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Nome'), 'Líder');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Já existe um nível com esse nome.')).toBeInTheDocument();
  });
});

describe('/niveis: acesso', () => {
  it('não ADMIN é redirecionado para /dashboard', () => {
    mocks.user = { role: 'OPERATOR' };
    expect(() => route.beforeLoad()).toThrow();
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/dashboard' });
  });

  it('ADMIN entra', () => {
    expect(() => route.beforeLoad()).not.toThrow();
  });
});
