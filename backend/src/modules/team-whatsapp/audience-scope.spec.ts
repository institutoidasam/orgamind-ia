import { describe, expect, it, vi } from 'vitest';
import { requireLevels, requireShifts } from './audience-scope';
import { SHIFT_FIRST, SHIFT_SECOND } from './team-whatsapp.test-fixtures';

const NIGHT = {
  id: 'shift_night',
  name: 'Noturno',
  startTime: '22:00',
  endTime: '06:00',
};
const ACTIVE = [SHIFT_FIRST, SHIFT_SECOND, NIGHT];
const L1 = { id: 'l1', name: 'Pleno' };
const L2 = { id: 'l2', name: 'Sênior' };

const levelsWith = (active: { id: string; name: string }[]) => ({
  listActive: vi.fn(() => Promise.resolve(active)),
});

describe('requireShifts — turnos pedidos contra os ativos (D9)', () => {
  it('requireShifts: sem shiftIds devolve []; id inativo 422 invalid_shift; ordem dos ativos', () => {
    expect(requireShifts(ACTIVE, undefined)).toEqual([]);
    expect(() => requireShifts(ACTIVE, ['shift_old'])).toThrow(
      expect.objectContaining({ code: 'team_whatsapp.invalid_shift' }),
    );
    expect(requireShifts(ACTIVE, [NIGHT.id, SHIFT_FIRST.id])).toEqual([
      SHIFT_FIRST,
      NIGHT,
    ]);
  });
});

describe('requireLevels — níveis pedidos contra os ativos (C5)', () => {
  it('requireLevels: sem levelIds não lê o repositório; inexistente ou inativo 422 invalid_level', async () => {
    const levels = levelsWith([L1, L2]);

    await expect(
      requireLevels(levels, { withoutLevel: true }),
    ).resolves.toMatchObject({ names: ['Sem nível'], levels: [] });
    expect(levels.listActive).not.toHaveBeenCalled();
    await expect(
      requireLevels(levels, { levelIds: ['l9'] }),
    ).rejects.toMatchObject({ code: 'team_whatsapp.invalid_level' });
  });

  it('devolve os níveis escolhidos (id e nome) na ordem dos ativos', async () => {
    const picked = await requireLevels(levelsWith([L1, L2]), {
      levelIds: [L2.id, L1.id],
    });

    expect(picked.levels).toEqual([L1, L2]);
    expect(picked.names).toEqual(['Pleno', 'Sênior']);
  });
});
