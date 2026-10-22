import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, pickOption, sectorOptions } from './test-helpers';

const mocks = vi.hoisted(() => ({ create: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('../api', () => ({ useCreateSectorPerson: () => ({ mutateAsync: mocks.create, isPending: false }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { NewPersonTab } from './new-person-tab';

const onDone = vi.fn();
const renderTab = () => render(<NewPersonTab sectorId="s1" options={sectorOptions} onDone={onDone} />);

async function fillIdentity() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Nome'), 'Beatriz');
  await user.type(screen.getByLabelText('Telefone (WhatsApp)'), '92977776666');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({});
});

describe('NewPersonTab: envio', () => {
  it('envia nome, telefone, nível, função e turno', async () => {
    renderTab();
    await fillIdentity();
    await pickOption('Nível', 'Líder');
    await userEvent.setup().type(screen.getByLabelText('Função (opcional)'), 'Conferente');
    await pickOption('Turno', 'Noite');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Beatriz',
        phone: '92977776666',
        levelId: 'level_leader',
        jobTitle: 'Conferente',
        shiftId: 'noite',
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('1 pessoa(s) adicionada(s)');
    expect(onDone).toHaveBeenCalled();
  });

  it.each([
    ['sem nível', false],
    ['com nível', true],
  ])('sem turno (%s), Adicionar desabilitado e nenhuma chamada', async (_label, withLevel) => {
    renderTab();
    await fillIdentity();
    if (withLevel) await pickOption('Nível', 'Líder');
    const button = screen.getByRole('button', { name: 'Adicionar' });
    expect(button).toBeDisabled();
    await userEvent.setup().click(button);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('NewPersonTab: erros do servidor', () => {
  it('erro de telefone mostra a mensagem do servidor no campo', async () => {
    mocks.create.mockRejectedValue(apiError(409, 'user.phone_taken'));
    renderTab();
    await fillIdentity();
    await pickOption('Turno', 'Dia');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar' }));
    expect(await screen.findByText('Este telefone já está em uso por outro usuário.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('erro que não é de telefone vira toast com a mensagem do código', async () => {
    mocks.create.mockRejectedValue(apiError(422, 'users.invalid_level'));
    renderTab();
    await fillIdentity();
    await pickOption('Turno', 'Dia');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Nível inválido. Atualize a página e tente de novo.'));
  });
});
