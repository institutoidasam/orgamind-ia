import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SectorShiftPicker } from './sector-shift-picker';

const sectors = [
  { id: 'ti', name: 'TI', code: 'TI' },
  { id: 'op', name: 'Operação', code: 'OP' },
];
const levels = [{ id: 'l1', name: 'Coordenador' }, { id: 'l2', name: 'Funcionário' }];

function setup(props: Partial<React.ComponentProps<typeof SectorShiftPicker>> = {}) {
  const onSectorsChange = vi.fn();
  const onLevelsChange = vi.fn();
  render(
    <SectorShiftPicker
      sectors={sectors} levels={levels} shifts={[]} sectorIds={[]} levelIds={[]} withoutLevel={false}
      date="2026-10-21" choice={null}
      onSectorsChange={onSectorsChange} onLevelsChange={onLevelsChange} onDateChange={vi.fn()} onChoiceChange={vi.fn()}
      {...props}
    />,
  );
  return { user: userEvent.setup(), onSectorsChange, onLevelsChange };
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
