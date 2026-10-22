import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../api', () => ({
  useCreateException: () => ({ mutateAsync: mocks.create, isPending: false }),
  useDeleteException: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));

import { ExceptionDialog, type ExceptionTarget } from './exception-dialog';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const options = {
  sectors: [{ id: 's1', name: 'Produção' }, { id: 's2', name: 'Logística' }],
  shifts: [
    { id: 'manha', name: 'Manhã', startTime: '06:00', endTime: '14:00' },
    { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' },
  ],
};
const target: ExceptionTarget = { userId: 'u1', name: 'Ana', date: '2026-10-20', exceptionId: null };

type User = ReturnType<typeof userEvent.setup>;

function setup(overrides: Partial<ExceptionTarget> = {}) {
  const user = userEvent.setup();
  render(<ExceptionDialog target={{ ...target, ...overrides }} options={options} onClose={mocks.onClose} />);
  return user;
}

async function pick(user: User, trigger: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(screen.getByRole('option', { name: option }));
}

const setDate = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = (user: User) => user.click(screen.getByRole('button', { name: 'Salvar' }));

function apiError(status: number, code: string) {
  return new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request('https://x'), {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ exception: {}, adjusted: 0 });
  mocks.remove.mockResolvedValue(undefined);
});

describe('ExceptionDialog: criação', () => {
  it('Férias de 2026-10-20 a 2026-10-24 envia POST só com kind e datas', async () => {
    const user = setup();
    await pick(user, 'Tipo', 'Férias');
    setDate('Até', '2026-10-24');
    await save(user);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).toStrictEqual({
      userId: 'u1', body: { kind: 'VACATION', startDate: '2026-10-20', endDate: '2026-10-24' },
    });
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
  });

  it.each([
    ['com espaços nas pontas vai aparada', '  troca combinada  ', { note: 'troca combinada' }],
    ['vazia não envia note', '   ', {}],
  ])('Observação %s', async (_name, typed, extra) => {
    const user = setup();
    await user.type(screen.getByLabelText('Observação'), typed);
    await save(user);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0].body).toStrictEqual({
      kind: 'DAY_OFF', startDate: '2026-10-20', endDate: '2026-10-20', ...extra,
    });
  });

});

describe('ExceptionDialog: validação antes de enviar', () => {
  it('Observação com 201 caracteres mostra o erro e não envia', async () => {
    const user = setup();
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'x'.repeat(201) } });
    await save(user);
    expect(await screen.findByText('A observação pode ter até 200 caracteres.')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('Troca de turno exige turno e envia shiftId sem sectorId', async () => {
    const user = setup();
    await pick(user, 'Tipo', 'Troca de turno');
    await save(user);
    expect(await screen.findByText('Escolha o turno.')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
    await pick(user, 'Turno', 'Noite');
    await save(user);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0].body).toStrictEqual({
      kind: 'SHIFT_SWAP', startDate: '2026-10-20', endDate: '2026-10-20', shiftId: 'noite',
    });
  });

});

describe('ExceptionDialog: outro setor e período', () => {
  it('Outro setor lista só options.sectors e exige turno', async () => {
    const user = setup();
    await pick(user, 'Tipo', 'Outro setor');
    await user.click(screen.getByRole('combobox', { name: 'Setor de destino' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Produção', 'Logística']);
    await user.click(screen.getByRole('option', { name: 'Logística' }));
    await save(user);
    expect(await screen.findByText('Escolha o turno.')).toBeInTheDocument();
    await pick(user, 'Turno', 'Manhã');
    await save(user);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0].body).toMatchObject({ kind: 'OTHER_SECTOR', sectorId: 's2', shiftId: 'manha' });
  });

  it('período final antes do inicial não envia', async () => {
    const user = setup();
    setDate('Até', '2026-10-19');
    await save(user);
    expect(await screen.findByText('A data final deve ser igual ou posterior à inicial.')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('ExceptionDialog: retorno do servidor', () => {
  it('adjusted 1 mostra o aviso de recorte e mantém o diálogo aberto', async () => {
    mocks.create.mockResolvedValue({ exception: {}, adjusted: 1 });
    const user = setup();
    await save(user);
    expect(
      await screen.findByText('1 exceção(ões) anterior(es) foram recortadas ou substituídas nesses dias.'),
    ).toBeInTheDocument();
    expect(mocks.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('403 staff_schedule.forbidden mostra a mensagem e não fecha', async () => {
    mocks.create.mockRejectedValue(apiError(403, 'staff_schedule.forbidden'));
    const user = setup();
    await save(user);
    expect(await screen.findByText('Você não pode editar a escala desta pessoa.')).toBeInTheDocument();
    expect(mocks.onClose).not.toHaveBeenCalled();
  });
});

describe('ExceptionDialog: remover', () => {
  it('célula sem exceção não oferece Remover exceção', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Remover exceção' })).not.toBeInTheDocument();
  });

  it('célula com exceção mostra Remover exceção e chama DELETE', async () => {
    const user = setup({ exceptionId: 'ex1' });
    await user.click(screen.getByRole('button', { name: 'Remover exceção' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('ex1'));
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
  });
});
