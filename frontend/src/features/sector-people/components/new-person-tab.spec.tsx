import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, chooseAuthorization, pickOption, sectorOptions } from './test-helpers';

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

const NO_AUTHORIZATION = 'Sem autorização registrada';
const add = () => userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar' }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({});
});

describe('NewPersonTab: matrícula e autorização', () => {
  it('sem autorização escolhida não envia e pede a escolha', async () => {
    renderTab();
    await fillIdentity();
    await pickOption('Turno', 'Dia');
    await add();
    expect(await screen.findByText('Escolha a autorização de contato')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('data futura da autorização não envia e mostra o erro', async () => {
    renderTab();
    await fillIdentity();
    await pickOption('Turno', 'Dia');
    await chooseAuthorization('Aceite pelo WhatsApp', '2999-01-01');
    await add();
    expect(await screen.findByText('A data da autorização não pode ser futura')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('matrícula e autorização escolhida vão no corpo', async () => {
    renderTab();
    await fillIdentity();
    await userEvent.setup().type(screen.getByLabelText('Matrícula'), 'A-12');
    await pickOption('Turno', 'Dia');
    await chooseAuthorization('Ficha de admissão');
    await add();
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Beatriz',
        phone: '92977776666',
        registration: 'A-12',
        contactAuthorization: { status: 'AUTORIZADO', source: 'FICHA_ADMISSAO', date: '2026-11-10' },
        levelId: null,
        jobTitle: null,
        shiftId: 'dia',
      }),
    );
  });
});

describe('NewPersonTab: envio', () => {
  it('envia nome, telefone, nível, função e turno', async () => {
    renderTab();
    await fillIdentity();
    await pickOption('Nível', 'Líder');
    await userEvent.setup().type(screen.getByLabelText('Função (opcional)'), 'Conferente');
    await pickOption('Turno', 'Noite');
    await chooseAuthorization(NO_AUTHORIZATION);
    await add();
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Beatriz',
        phone: '92977776666',
        contactAuthorization: { status: 'NAO_AUTORIZADO' },
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
    await chooseAuthorization(NO_AUTHORIZATION);
    await add();
    expect(await screen.findByText('Este telefone já está em uso por outro usuário.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('erro que não é de telefone vira toast com a mensagem do código', async () => {
    mocks.create.mockRejectedValue(apiError(422, 'users.invalid_level'));
    renderTab();
    await fillIdentity();
    await pickOption('Turno', 'Dia');
    await chooseAuthorization(NO_AUTHORIZATION);
    await add();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Nível inválido. Atualize a página e tente de novo.'));
  });
});
