import { describe, expect, it, vi } from 'vitest';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { TeamPanoramaService } from './team-panorama.service';
import { tooManyPeople } from './team-whatsapp.errors';
import type { TeamActor } from './team-whatsapp.policy';
import type { TeamWhatsappRepository } from './team-whatsapp.repository';
import { SHIFT_FIRST, dayPerson, onShift } from './team-whatsapp.test-fixtures';

// DJ2/DJ5 (aceites 2 e 8): o portão do remetente vem antes de qualquer leitura
// de setor ou pessoa; o alcance é do ator; `now` é explícito (GJ8).
const NOW = new Date('2026-11-20T03:00:00-04:00'); // 03h em Manaus
const TODAY = '2026-11-20';
const NIGHT: ShiftRef = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const SECTORS = [
  { id: 's1', name: 'Zeladoria', code: 'ZEL' },
  { id: 's2', name: 'Ética', code: 'ETI' },
  { id: 's3', name: 'Almoxarifado', code: 'ALM' },
];
const sender = (
  role: TeamActor['role'],
  managedSectorIds: string[] = [],
): TeamActor => ({ ...actorWith(role), managedSectorIds });

/** Repositório falso; `loadDayPeopleMany` estoura o teto para mais de um setor ou para `s3`. */
function setup(actor: TeamActor | null) {
  const repo = {
    findActor: vi.fn().mockResolvedValue(actor),
    listSectors: vi.fn((ids: readonly string[] | null) =>
      Promise.resolve(SECTORS.filter((s) => !ids || ids.includes(s.id))),
    ),
    listActiveShifts: vi.fn().mockResolvedValue([SHIFT_FIRST, NIGHT]),
    loadDayPeopleMany: vi.fn((ids: readonly string[]) => {
      if (ids.length > 1 || ids[0] === 's3')
        return Promise.reject(tooManyPeople());
      const ana = dayPerson({ sectorId: ids[0], ...onShift(SHIFT_FIRST) });
      return Promise.resolve(new Map([[ids[0], [ana]]]));
    }),
  };
  const service = new TeamPanoramaService(
    repo as unknown as TeamWhatsappRepository,
  );
  return { repo, service };
}

describe('TeamPanoramaService — remetente e alcance (DJ2, GJ4)', () => {
  it('aceite 2: ator nulo ou não remetente — 403 team_whatsapp.forbidden sem chamar listSectors nem loadDayPeopleMany', async () => {
    const outside = [
      null,
      sender('VIEWER', ['s1']),
      sender('OPERATOR'),
      sender('SUPERVISOR'),
      { ...sender('ADMIN'), isActive: false },
    ] as (TeamActor | null)[];
    for (const actor of outside) {
      const { repo, service } = setup(actor);
      await expect(
        service.panorama('actor-1', { date: TODAY }, NOW),
      ).rejects.toMatchObject({ status: 403, code: 'team_whatsapp.forbidden' });
      expect(repo.findActor).toHaveBeenCalledWith('actor-1');
      expect(repo.listSectors).not.toHaveBeenCalled();
      expect(repo.listActiveShifts).not.toHaveBeenCalled();
      expect(repo.loadDayPeopleMany).not.toHaveBeenCalled();
    }
  });

  it('ADMIN usa listSectors(null); SUPERVISOR usa managedSectorIds', async () => {
    const admin = setup(sender('ADMIN'));
    await admin.service.panorama('a', { date: TODAY }, NOW);
    expect(admin.repo.listSectors).toHaveBeenCalledWith(null);
    const sup = setup(sender('SUPERVISOR', ['s1', 's2']));
    const scope = await sup.service.panorama('s', { date: TODAY }, NOW);
    expect(sup.repo.listSectors).toHaveBeenCalledWith(['s1', 's2']);
    expect(scope.sectors.map((s) => s.sectorId)).toEqual(['s2', 's1']);
  });
});

describe('TeamPanoramaService — resposta (DJ2, DJ3, DJ5)', () => {
  it('aceite 8: inProgress só quando date === today', async () => {
    const { service } = setup(sender('ADMIN'));
    const today = await service.panorama('a', { date: TODAY }, NOW);
    expect(today.today).toBe(TODAY);
    expect(today.inProgress).toEqual({ date: '2026-11-19', shift: NIGHT });
    const yesterday = await service.panorama('a', { date: '2026-11-19' }, NOW);
    expect(yesterday).toMatchObject({ date: '2026-11-19', today: TODAY });
    expect(yesterday.inProgress).toBeNull();
  });

  it('setores ordenados por nome pt-BR', async () => {
    const { service } = setup(sender('ADMIN'));
    const res = await service.panorama('a', { date: TODAY }, NOW);
    expect(res.shifts).toEqual([SHIFT_FIRST, NIGHT]);
    expect(res.sectors.map((s) => [s.sectorId, s.name, s.overLimit])).toEqual([
      ['s3', 'Almoxarifado', true],
      ['s2', 'Ética', false],
      ['s1', 'Zeladoria', false],
    ]);
    expect(res.sectors[0].counts).toBeNull();
    expect(res.sectors[1].counts?.byShift).toEqual([
      { shiftId: SHIFT_FIRST.id, count: 1 },
      { shiftId: NIGHT.id, count: 0 },
    ]);
  });
});
