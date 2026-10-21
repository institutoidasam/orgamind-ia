import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffSchedule } from '../schemas';
import { custom, weekly, weeklyRotation } from '../templates';

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  remove: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../api', () => ({
  usePutSchedule: () => ({ mutateAsync: mocks.put, isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));

import { ScheduleEditorDialog } from './schedule-editor-dialog';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const options = {
  today: '2026-10-21',
  shifts: [
    { id: 'manha', name: 'Manhã', startTime: '06:00', endTime: '14:00' },
    { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' },
  ],
};

type User = ReturnType<typeof userEvent.setup>;

function setup(schedule: StaffSchedule | null = null) {
  const user = userEvent.setup();
  render(
    <ScheduleEditorDialog target={{ userId: 'u1', name: 'Ana', schedule }} options={options} onClose={mocks.onClose} />,
  );
  return user;
}

async function pick(user: User, trigger: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(screen.getByRole('option', { name: option }));
}

const save = (user: User) => user.click(screen.getByRole('button', { name: 'Salvar' }));

function apiError(status: number, code: string) {
  return new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request('https://x'), {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({});
  mocks.remove.mockResolvedValue(undefined);
});

describe('ScheduleEditorDialog: edição', () => {
  it('abre com a escala existente (modelo, início, ciclo)', () => {
    setup(weeklyRotation({ shiftA: 'manha', shiftB: 'noite', anyDate: '2026-10-19' }));
    expect(screen.getByRole('combobox', { name: 'Modelo' })).toHaveTextContent('Rodízio semanal');
    expect(screen.getByLabelText('Início')).toHaveValue('2026-10-19');
    expect(screen.getByLabelText('Ciclo (dias)')).toHaveValue(14);
    expect(screen.getByRole('combobox', { name: 'Dia 1 (seg)' })).toHaveTextContent('Manhã');
    expect(screen.getByRole('combobox', { name: 'Dia 8 (seg)' })).toHaveTextContent('Noite');
    expect(screen.getByRole('combobox', { name: 'Dia 6 (sáb)' })).toHaveTextContent('Folga');
  });

  it('Rodízio semanal com Manhã/Noite preenche 14 dias e Salvar envia PUT com o corpo de weeklyRotation', async () => {
    const user = setup();
    await pick(user, 'Modelo', 'Rodízio semanal');
    await pick(user, 'Turno da semana A', 'Manhã');
    await pick(user, 'Turno da semana B', 'Noite');
    expect(screen.getAllByRole('combobox', { name: /^Dia \d+ / })).toHaveLength(14);
    await save(user);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put.mock.calls[0][0]).toStrictEqual({
      userId: 'u1',
      body: weeklyRotation({ shiftA: 'manha', shiftB: 'noite', anyDate: '2026-10-21' }),
    });
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
  });

  it('editar um dia depois do modelo altera só aquele dia', async () => {
    const user = setup(weekly('noite', '2026-10-19'));
    await pick(user, 'Dia 6 (sáb)', 'Manhã');
    await save(user);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    const expected = weekly('noite', '2026-10-19');
    expected.days[5] = 'manha';
    expect(mocks.put.mock.calls[0][0].body).toStrictEqual(expected);
  });

  it('mudar o ciclo mantém o prefixo e completa com folga', async () => {
    const user = setup(custom(2, '2026-10-21'));
    await pick(user, 'Dia 1 (qua)', 'Noite');
    await user.clear(screen.getByLabelText('Ciclo (dias)'));
    await user.type(screen.getByLabelText('Ciclo (dias)'), '3');
    await save(user);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put.mock.calls[0][0].body.days).toStrictEqual(['noite', null, null]);
  });
});

describe('ScheduleEditorDialog: remoção e erro', () => {
  it('Remover escala pede confirmação e chama DELETE', async () => {
    const user = setup(weekly('noite', '2026-10-19'));
    await user.click(screen.getByRole('button', { name: 'Remover escala' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('A pessoa volta a seguir o turno do cadastro.')).toBeInTheDocument();
    expect(mocks.remove).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('u1'));
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
  });

  it('sem escala não oferece Remover escala', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Remover escala' })).not.toBeInTheDocument();
  });

  it('422 staff_schedule.invalid_shift mostra a mensagem do turno e não fecha', async () => {
    mocks.put.mockRejectedValue(apiError(422, 'staff_schedule.invalid_shift'));
    const user = setup(weekly('noite', '2026-10-19'));
    await save(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Um dos turnos não está mais disponível. Atualize a página.',
    );
    expect(mocks.onClose).not.toHaveBeenCalled();
  });
});
