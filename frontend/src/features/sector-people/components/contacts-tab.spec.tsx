import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, pickOption, sectorOptions } from './test-helpers';

const mocks = vi.hoisted(() => ({ candidates: vi.fn(), add: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('../api', () => ({
  useSectorContactCandidates: (sectorId: string, q: string) => mocks.candidates(sectorId, q),
  useAddPeopleFromContacts: () => ({ mutateAsync: mocks.add, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { ContactsTab } from './contacts-tab';

const items = [
  { contactId: 'c1', name: 'Bia', phoneE164: '+5592988887771', person: null },
  { contactId: 'c2', name: 'Caio', phoneE164: '+5592988887772', person: null },
  { contactId: 'c3', name: null, phoneE164: '+5592988887773', person: null },
  { contactId: 'c4', name: 'Ana Silva', phoneE164: '+5592988887774', person: { userId: 'u9', name: 'Ana', sectorName: 'TI' } },
];

const onDone = vi.fn();
const renderTab = () => render(<ContactsTab sectorId="s1" options={sectorOptions} onDone={onDone} />);
const check = (name: string) => userEvent.setup().click(screen.getByRole('checkbox', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidates.mockReturnValue({ data: { items }, isPending: false, isError: false });
  mocks.add.mockResolvedValue({ created: [{}, {}, {}], failed: [] });
});
afterEach(() => vi.useRealTimers());

describe('ContactsTab: seleção e busca', () => {
  it('seleciona 3 contatos, escolhe Funcionário e o turno Noite e envia contactIds, levelId e shiftId', async () => {
    renderTab();
    await check('Bia');
    await check('Caio');
    await check('(92) 98888-7773'); // D11: contato sem nome aparece pelo número
    await pickOption('Nível', 'Funcionário');
    await pickOption('Turno', 'Noite');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar (3)' }));
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith({ contactIds: ['c1', 'c2', 'c3'], levelId: 'level_employee', shiftId: 'noite' }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('3 pessoa(s) adicionada(s)');
    expect(onDone).toHaveBeenCalled();
  });

  it.each([
    ['TI', 'já é Ana · TI'],
    [null, 'já é Ana · Sem setor'],
  ])('contato que já é pessoa (setor %s) fica desabilitado com "%s"', (sectorName, label) => {
    const person = { userId: 'u9', name: 'Ana', sectorName };
    mocks.candidates.mockReturnValue({ data: { items: [{ ...items[3], person }] }, isPending: false, isError: false });
    renderTab();
    expect(screen.getByRole('checkbox', { name: 'Ana Silva' })).toBeDisabled();
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('ContactsTab: resultado e erros do envio', () => {
  it('resultado com 1 phone_taken mostra "Número já usado por outra pessoa" e o toast "2 pessoa(s) adicionada(s)"', async () => {
    mocks.add.mockResolvedValue({ created: [{}, {}], failed: [{ contactId: 'c2', reason: 'phone_taken' }] });
    renderTab();
    await check('Bia');
    await check('Caio');
    await check('(92) 98888-7773');
    await pickOption('Turno', 'Noite');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar (3)' }));
    expect(await screen.findByText('Número já usado por outra pessoa')).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('2 pessoa(s) adicionada(s)');
    expect(onDone).not.toHaveBeenCalled();
    // quem deu certo sai da seleção; só o que falhou continua para nova tentativa
    expect(screen.getByRole('button', { name: 'Adicionar (1)' })).toBeEnabled();
  });

  it.each([1, 3])('sem turno, Adicionar (%i) desabilitado e nenhuma chamada', async (count) => {
    renderTab();
    for (const name of ['Bia', 'Caio', '(92) 98888-7773'].slice(0, count)) await check(name);
    await pickOption('Nível', 'Funcionário');
    const button = screen.getByRole('button', { name: `Adicionar (${count})` });
    expect(button).toBeDisabled();
    await userEvent.setup().click(button);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('422 de turno inválido mostra a mensagem do código e mantém o diálogo', async () => {
    mocks.add.mockRejectedValue(apiError(422, 'users.invalid_shift'));
    renderTab();
    await check('Bia');
    await pickOption('Turno', 'Dia');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar (1)' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Turno inválido. Atualize a página.'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('busca com debounce de 300 ms', () => {
    vi.useFakeTimers();
    renderTab();
    fireEvent.change(screen.getByLabelText('Buscar contato por nome ou número'), { target: { value: 'ana' } });
    act(() => vi.advanceTimersByTime(299));
    expect(mocks.candidates).not.toHaveBeenCalledWith('s1', 'ana');
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.candidates).toHaveBeenLastCalledWith('s1', 'ana');
  });
});
