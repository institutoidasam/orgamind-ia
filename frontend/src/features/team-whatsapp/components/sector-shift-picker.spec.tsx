import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SectorShiftPicker } from './sector-shift-picker';

const sectors = [
  { id: 'ti', name: 'TI', code: 'TI' },
  { id: 'op', name: 'Operação', code: 'OP' },
];
const levels = [{ id: 'l1', name: 'Coordenador' }, { id: 'l2', name: 'Funcionário' }];
const shifts = [
  { id: 'dia', name: 'Dia', startTime: '06:00', endTime: '18:00' },
  { id: 'noite', name: 'Noite', startTime: '18:00', endTime: '06:00' },
];

function setup(props: Partial<React.ComponentProps<typeof SectorShiftPicker>> = {}) {
  const onSectorsChange = vi.fn();
  const onLevelsChange = vi.fn();
  const onShiftsChange = vi.fn();
  render(
    <SectorShiftPicker
      sectors={sectors} levels={levels} shifts={shifts} sectorIds={[]} levelIds={[]} withoutLevel={false}
      date="2026-10-21" shiftIds={[]} shiftsPicked={false}
      onSectorsChange={onSectorsChange} onLevelsChange={onLevelsChange} onDateChange={vi.fn()} onShiftsChange={onShiftsChange}
      {...props}
    />,
  );
  return { user: userEvent.setup(), onSectorsChange, onLevelsChange, onShiftsChange };
}

describe('SectorShiftPicker', () => {
  it('Todos os setores marca todos, na ordem dos setores', async () => {
    const { user, onSectorsChange } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'Todos os setores' }));
    expect(onSectorsChange).toHaveBeenCalledWith(['ti', 'op']);
  });

  it('com todos marcados, Todos os setores desmarca; marcar um setor acrescenta sem trocar a ordem', async () => {
    const all = setup({ sectorIds: ['ti', 'op'] });
    expect(screen.getByRole('checkbox', { name: 'Todos os setores' })).toBeChecked();
    await all.user.click(screen.getByRole('checkbox', { name: 'Todos os setores' }));
    expect(all.onSectorsChange).toHaveBeenCalledWith([]);
  });

  it('marcar Operação com TI já marcado devolve [ti, op]', async () => {
    const { user, onSectorsChange } = setup({ sectorIds: ['ti'] });
    await user.click(screen.getByRole('checkbox', { name: 'Operação' }));
    expect(onSectorsChange).toHaveBeenCalledWith(['ti', 'op']);
  });

  it('um setor possível já vem marcado, sem a opção Todos os setores', () => {
    setup({ sectors: [sectors[0]], sectorIds: ['ti'] });
    expect(screen.getByRole('checkbox', { name: 'TI' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Todos os setores' })).not.toBeInTheDocument();
  });

  it('níveis ativos vêm de targets.levels, com Sem nível no fim; marcar emite ids e withoutLevel', async () => {
    const { user, onLevelsChange } = setup();
    const group = screen.getByRole('group', { name: 'Níveis' });
    expect(Array.from(group.querySelectorAll('label')).map((l) => l.textContent)).toEqual([
      'Coordenador', 'Funcionário', 'Sem nível',
    ]);
    await user.click(screen.getByRole('checkbox', { name: 'Coordenador' }));
    expect(onLevelsChange).toHaveBeenLastCalledWith(['l1'], false);
    await user.click(screen.getByRole('checkbox', { name: 'Sem nível' }));
    expect(onLevelsChange).toHaveBeenLastCalledWith([], true);
  });

  it('sem níveis cadastrados não mostra o filtro de nível', () => {
    setup({ levels: [] });
    expect(screen.queryByRole('group', { name: 'Níveis' })).not.toBeInTheDocument();
  });

});

describe('SectorShiftPicker: turnos', () => {
  it('marcar Dia e depois Noite emite os turnos na ordem dos turnos, e Todos os turnos emite lista vazia', async () => {
    const first = setup();
    await first.user.click(screen.getByRole('checkbox', { name: 'Dia' }));
    expect(first.onShiftsChange).toHaveBeenLastCalledWith(['dia']);
    cleanup();
    const second = setup({ shiftIds: ['dia'], shiftsPicked: true });
    await second.user.click(screen.getByRole('checkbox', { name: 'Noite' }));
    expect(second.onShiftsChange).toHaveBeenLastCalledWith(['dia', 'noite']);
    cleanup();
    const all = setup();
    await all.user.click(screen.getByRole('checkbox', { name: 'Todos os turnos' }));
    expect(all.onShiftsChange).toHaveBeenLastCalledWith([]);
  });

  it('Todos os turnos só vem marcado depois de escolhido; desmarcar o último turno ou Todos volta a não escolhido', async () => {
    const none = setup();
    expect(screen.getByRole('checkbox', { name: 'Todos os turnos' })).not.toBeChecked();
    cleanup();
    const all = setup({ shiftsPicked: true });
    expect(screen.getByRole('checkbox', { name: 'Todos os turnos' })).toBeChecked();
    await all.user.click(screen.getByRole('checkbox', { name: 'Todos os turnos' }));
    expect(all.onShiftsChange).toHaveBeenLastCalledWith(null);
    cleanup();
    const one = setup({ shiftIds: ['noite'], shiftsPicked: true });
    expect(screen.getByRole('checkbox', { name: 'Noite' })).toBeChecked();
    await one.user.click(screen.getByRole('checkbox', { name: 'Noite' }));
    expect(one.onShiftsChange).toHaveBeenLastCalledWith(null);
    expect(none.onShiftsChange).not.toHaveBeenCalled();
  });

  it('avisa que os filtros do quadro da escala não mudam quem recebe', () => {
    setup();
    expect(
      screen.getByText('Os filtros do quadro da escala não mudam quem recebe: o envio usa só as escolhas abaixo.'),
    ).toBeVisible();
  });
});
