import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError } from './test-helpers';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN',
  candidates: vi.fn(),
  move: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: { user: { role: string } }) => unknown) => select({ user: { role: mocks.role } }),
}));
vi.mock('../api', () => ({
  useSectorPersonCandidates: (sectorId: string, q: string) => mocks.candidates(sectorId, q),
  useMoveSectorPeople: () => ({ mutateAsync: mocks.move, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { ExistingPersonTab } from './existing-person-tab';

const ana = { id: 'u1', name: 'Ana', hasAccess: false, sector: { id: 's2', name: 'TI' } };
const caio = { id: 'u2', name: 'Caio', hasAccess: true, sector: null };

const onDone = vi.fn();
const renderTab = () => render(<ExistingPersonTab sectorId="s1" onDone={onDone} />);
const check = (name: string) => userEvent.setup().click(screen.getByRole('checkbox', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.candidates.mockReturnValue({ data: { items: [ana, caio] }, isPending: false, isError: false });
  mocks.move.mockResolvedValue({ moved: [{}] });
});

describe('ExistingPersonTab', () => {
  it('pessoa de TI pede "Ana sai de TI" antes de chamar move', async () => {
    renderTab();
    await check('Ana');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar (1)' }));
    expect(screen.getByText('Ana sai de TI')).toBeInTheDocument();
    expect(mocks.move).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith(['u1']));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('1 pessoa(s) adicionada(s)');
    expect(onDone).toHaveBeenCalled();
  });

  it('pessoa sem setor move sem confirmação', async () => {
    renderTab();
    expect(screen.getByText('Sem setor')).toBeInTheDocument();
    await check('Caio');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar (1)' }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith(['u2']));
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  });

  it('403 do move mostra a mensagem do código e mantém o diálogo', async () => {
    mocks.move.mockRejectedValue(apiError(403, 'sector_people.forbidden'));
    renderTab();
    await check('Caio');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar (1)' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Você não pode mexer nesta pessoa.'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('gestor é avisado de que só vê quem está sem setor', () => {
    mocks.role = 'SUPERVISOR';
    renderTab();
    expect(screen.getByText('Você vê só quem está sem setor.')).toBeInTheDocument();
  });
});
