import { describe, expect, it, vi } from 'vitest';
import type { LevelsRepository } from '../levels/levels.repository';
import type { ShiftsRepository } from '../shifts/shifts.repository';
import type { PeopleActor } from './sector-people.policy';
import type {
  SectorPeopleRepository,
  SectorPersonRow,
} from './sector-people.repository';
import { SectorPeopleService } from './sector-people.service';

const ADMIN: PeopleActor = {
  id: 'user_admin',
  role: 'ADMIN',
  isActive: true,
  hasAccess: true,
};
const MANAGER: PeopleActor = {
  id: 'user_manager',
  role: 'SUPERVISOR',
  isActive: true,
  hasAccess: true,
};
const SECTORS = [
  {
    id: 'sector_operation',
    name: 'Operação',
    code: 'OPE',
    isActive: true,
    managerId: MANAGER.id,
    manager: { id: MANAGER.id, name: 'Marta' },
  },
  {
    id: 'sector_it',
    name: 'TI',
    code: 'TI',
    isActive: true,
    managerId: 'user_other',
    manager: null,
  },
];
const [OPERATION, IT] = SECTORS;

function row(over: Partial<SectorPersonRow> = {}): SectorPersonRow {
  return {
    id: 'user_ana',
    name: 'Ana',
    email: null,
    phoneE164: '+5592999990001',
    hasAccess: false,
    role: 'VIEWER',
    jobTitle: null,
    level: null,
    workShift: { id: 'shift_day', name: 'Dia' },
    ...over,
  };
}

const NO_SECTOR = {
  id: 'user_new',
  name: 'Nova',
  hasAccess: false,
  sector: null,
};
const FROM_IT = {
  id: 'user_it',
  name: 'Tiago',
  hasAccess: true,
  sector: { id: IT.id, name: IT.name },
};

function harness(people: SectorPersonRow[] = [row()]) {
  const actors = [ADMIN, MANAGER];
  const repo = {
    findActor: vi.fn((id: string) =>
      Promise.resolve(actors.find((a) => a.id === id) ?? null),
    ),
    findSector: vi.fn((id: string) =>
      Promise.resolve(SECTORS.find((s) => s.id === id) ?? null),
    ),
    listPeople: vi.fn().mockResolvedValue(people),
    listCandidates: vi.fn().mockResolvedValue([NO_SECTOR, FROM_IT]),
    listContactCandidates: vi.fn().mockResolvedValue([]),
  };
  const levels = {
    listActive: vi
      .fn()
      .mockResolvedValue([{ id: 'level_leader', name: 'Líder' }]),
  };
  const shifts = {
    listAll: vi.fn().mockResolvedValue([
      { id: 'shift_day', name: 'Dia', isActive: true },
      { id: 'shift_old', name: 'Antigo', isActive: false },
    ]),
  };
  const service = new SectorPeopleService(
    repo as unknown as SectorPeopleRepository,
    levels as unknown as LevelsRepository,
    shifts as unknown as ShiftsRepository,
  );
  return { service, repo, levels };
}

describe('SectorPeopleService — leitura', () => {
  it('gestor de Operação lista Operação com options de níveis e turnos ativos (sem o inativo)', async () => {
    const { service, repo, levels } = harness();

    const result = await service.list(MANAGER.id, OPERATION.id);

    expect(repo.listPeople).toHaveBeenCalledWith(OPERATION.id);
    expect(levels.listActive).toHaveBeenCalled();
    expect(result.sector).toEqual({
      id: OPERATION.id,
      name: 'Operação',
      code: 'OPE',
      isActive: true,
      manager: { id: MANAGER.id, name: 'Marta' },
    });
    expect(result.people.map((p) => p.id)).toEqual(['user_ana']);
    expect(result.options).toEqual({
      levels: [{ id: 'level_leader', name: 'Líder' }],
      shifts: [{ id: 'shift_day', name: 'Dia' }],
    });
  });
});

describe('SectorPeopleService — telefone (GC8)', () => {
  it.each([
    {
      viewer: 'gestor',
      actorId: MANAGER.id,
      hasAccess: false,
      phone: '+5592999990001',
    },
    { viewer: 'gestor', actorId: MANAGER.id, hasAccess: true, phone: null },
    {
      viewer: 'ADMIN',
      actorId: ADMIN.id,
      hasAccess: true,
      phone: '+5592999990002',
    },
  ])(
    'telefone por quem vê: $viewer × com acesso $hasAccess → $phone',
    async ({ actorId, hasAccess, phone }) => {
      const person = row({
        hasAccess,
        role: hasAccess ? 'OPERATOR' : 'VIEWER',
        phoneE164: hasAccess ? '+5592999990002' : '+5592999990001',
      });
      const { service } = harness([person]);

      const [seen] = (await service.list(actorId, OPERATION.id)).people;

      expect(seen).toMatchObject({
        phoneE164: phone,
        editable: hasAccess ? 'limited' : 'full',
        role: hasAccess ? 'OPERATOR' : null,
      });
    },
  );
});

describe('SectorPeopleService — autorização', () => {
  it.each<[string, (s: SectorPeopleService) => Promise<unknown>]>([
    ['list', (s) => s.list(MANAGER.id, IT.id)],
    ['candidates', (s) => s.candidates(MANAGER.id, IT.id, '')],
    ['contactCandidates', (s) => s.contactCandidates(MANAGER.id, IT.id, '')],
  ])(
    'gestor de Operação em TI → 403 sector_people.forbidden (%s)',
    async (_method, call) => {
      const { service, repo } = harness();

      await expect(call(service)).rejects.toMatchObject({
        status: 403,
        code: 'sector_people.forbidden',
      });
      expect(repo.listPeople).not.toHaveBeenCalled();
      expect(repo.listCandidates).not.toHaveBeenCalled();
      expect(repo.listContactCandidates).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['ADMIN', ADMIN.id, 404, 'sector_people.sector_not_found'],
    ['gestor', MANAGER.id, 403, 'sector_people.forbidden'],
    ['ator inexistente', 'user_ghost', 403, 'sector_people.forbidden'],
  ])('setor inexistente: %s → %s', async (_label, actorId, status, code) => {
    const { service } = harness();

    await expect(
      service.requireManageable(actorId, 'sector_ghost'),
    ).rejects.toMatchObject({ status, code });
  });
});

describe('SectorPeopleService — candidatos', () => {
  it.each([
    ['ADMIN', ADMIN.id, false, [NO_SECTOR, FROM_IT]],
    ['gestor', MANAGER.id, true, [NO_SECTOR]],
  ])(
    '%s: só sem setor e sem acesso = %s (D6)',
    async (_label, actorId, restricted, expected) => {
      const { service, repo } = harness();

      const result = await service.candidates(actorId, OPERATION.id, 'a');

      expect(repo.listCandidates).toHaveBeenCalledWith({
        sectorId: OPERATION.id,
        q: 'a',
        onlyUnassignedWithoutAccess: restricted,
      });
      expect(result.items).toEqual(expected);
    },
  );

  it('contact-candidates do gestor devolve a busca do repositório', async () => {
    const { service, repo } = harness();
    const item = {
      contactId: 'contact_1',
      name: 'Carla',
      phoneE164: '+5592988880000',
      person: null,
    };
    repo.listContactCandidates.mockResolvedValue([item]);

    const result = await service.contactCandidates(
      MANAGER.id,
      OPERATION.id,
      '9288',
    );

    expect(repo.listContactCandidates).toHaveBeenCalledWith('9288');
    expect(result).toEqual({ items: [item] });
  });
});
