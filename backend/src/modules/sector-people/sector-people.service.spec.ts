import { describe, expect, it, vi } from 'vitest';
import type { SectorPerson } from '../../schemas/contracts/sector-people.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { LevelsRepository } from '../levels/levels.repository';
import type { ShiftsRepository } from '../shifts/shifts.repository';
import type { PeopleActor } from './sector-people.policy';
import {
  SectorPeopleRepository,
  type SectorPersonRow,
} from './sector-people.repository';
import { SectorPeopleService } from './sector-people.service';

const ADMIN: PeopleActor = actorWith('ADMIN', { id: 'user_admin' });
const MANAGER: PeopleActor = actorWith('SUPERVISOR', { id: 'user_manager' });
const SECTORS = [
  {
    id: 'sector_operation',
    name: 'Operação',
    code: 'OPE',
    isActive: true,
    managerId: MANAGER.id,
    manager: { id: MANAGER.id, name: 'Marta' },
    channel: {
      id: 'channel_ope',
      name: 'Operação Zap',
      phoneE164: '+5592999990001',
      provider: 'EVOLUTION',
      isActive: true,
    },
  },
  {
    id: 'sector_it',
    name: 'TI',
    code: 'TI',
    isActive: true,
    managerId: 'user_other',
    manager: null,
    channel: null,
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
    registration: null,
    isActive: true,
    contactAuthorization: 'NAO_AUTORIZADO',
    authorizationSource: null,
    authorizationNote: null,
    authorizationDate: null,
    authorizationRecordedAt: null,
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

function harness(
  people: SectorPersonRow[] = [row()],
  actors: PeopleActor[] = [ADMIN, MANAGER],
) {
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

// Mesmo id do gestor de Operação, sem a chave: gerencia o setor, mas só vê a máscara.
const NO_KEY: PeopleActor = actorWith('SUPERVISOR', {
  id: MANAGER.id,
  revoke: ['telefone.ver_completo'],
});
// Quem o repositório recebe como leitor: gestor com a chave (`MANAGER`).
const KEY_VIEW = { isAdmin: false, fullPhone: true };
const LOGIN = { hasAccess: true, role: 'OPERATOR' } as const;
const PHONE_ROWS = [
  row({ id: 'user_ana', phoneE164: '+5592999997777' }),
  row({ id: 'user_bruno', phoneE164: '+5592999990002', ...LOGIN }),
  row({ id: 'user_carol', phoneE164: null, ...LOGIN }),
];
const phoneFields = (p: SectorPerson) => [
  p.phoneE164,
  p.hasPhone,
  p.phoneMasked,
];

// D11: contato sem nome virou pessoa com o número como nome.
const PHONE_NAME = '+5592988881234';
const LOGIN_PHONE_NAME = '(92) 98888-5678';
const PHONE_NAMED = [
  row({ id: 'user_phone', name: PHONE_NAME, phoneE164: PHONE_NAME }),
  row({ id: 'user_login', name: LOGIN_PHONE_NAME, ...LOGIN }),
];
const nameList = (items: readonly { name: string }[]) =>
  items.map((item) => item.name);

// I2: sem ver o telefone completo a ordem é a do nome exibido (desempate pelo id),
// nunca a do número. Reais: a < b < c; máscaras: b (0000) < a (1111) < c (9999).
const BY_NUMBER = [
  row({ id: 'user_c', name: '+5592999999999', ...LOGIN }),
  row({ id: 'user_b', name: '+5592911110000' }),
  row({ id: 'user_a', name: '+5592900001111' }),
];

/** Lista pela ordenação de verdade do repositório (Prisma falso devolve fora de ordem). */
function orderHarness(actor: PeopleActor) {
  const h = harness([], [actor]);
  const findMany = vi.fn(() => Promise.resolve([...BY_NUMBER]));
  const prisma = { user: { findMany } };
  const real = new SectorPeopleRepository(prisma as never);
  h.repo.listPeople.mockImplementation(
    (...args: Parameters<SectorPeopleRepository['listPeople']>) =>
      real.listPeople(...args),
  );
  return h;
}

describe('SectorPeopleService — ordem pelo nome exibido (I2), lista', () => {
  it.each([
    ['sem a chave: pelas máscaras', NO_KEY, ['user_b', 'user_a', 'user_c']],
    [
      'gestor com a chave: a pessoa com login entra pela máscara',
      MANAGER,
      ['user_c', 'user_a', 'user_b'],
    ],
    ['ADMIN: pelo nome real, como hoje', ADMIN, ['user_a', 'user_b', 'user_c']],
  ])('%s', async (_label, actor, expected) => {
    const { service } = orderHarness(actor);

    const { people } = await service.list(actor.id, OPERATION.id);

    expect(people.map((person) => person.id)).toEqual(expected);
  });
});

describe('SectorPeopleService — ordem pelo nome exibido (I2), candidatos', () => {
  // Como o repositório devolve (nome real): z < b < a; máscaras: b (0000) < a = z (1111).
  const realOrder = [
    { id: 'user_z', name: '+5592900001111', hasAccess: false, sector: null },
    { id: 'user_b', name: '+5592911110000', hasAccess: false, sector: null },
    { id: 'user_a', name: '+5592999991111', hasAccess: false, sector: null },
  ];

  it.each([
    [
      'sem a chave: pelas máscaras, empate pelo id',
      NO_KEY,
      ['user_b', 'user_a', 'user_z'],
    ],
    [
      'com a chave: pelo nome real, como hoje',
      MANAGER,
      ['user_z', 'user_b', 'user_a'],
    ],
    ['ADMIN: como hoje', ADMIN, ['user_z', 'user_b', 'user_a']],
  ])('%s', async (_label, actor, expected) => {
    const { service, repo } = harness([], [actor]);
    repo.listCandidates.mockResolvedValue(realOrder);

    const { items } = await service.candidates(actor.id, OPERATION.id, '');

    expect(items.map((item) => item.id)).toEqual(expected);
  });
});

describe('SectorPeopleService — nome que é telefone (D11), lista', () => {
  it('sem a chave: nenhum nome da lista traz o número', async () => {
    const { service } = harness(PHONE_NAMED, [NO_KEY]);

    const { people } = await service.list(NO_KEY.id, OPERATION.id);

    expect(nameList(people)).toEqual(['•••• 1234', '•••• 5678']);
    expect(JSON.stringify(people)).not.toMatch(/88881234|88885678/);
  });

  it('com a chave sai como gravado, menos a pessoa com login para quem não é ADMIN; ADMIN vê tudo', async () => {
    const { service } = harness(PHONE_NAMED, [ADMIN, MANAGER]);

    const manager = await service.list(MANAGER.id, OPERATION.id);
    const admin = await service.list(ADMIN.id, OPERATION.id);

    expect(nameList(manager.people)).toEqual([PHONE_NAME, '•••• 5678']);
    expect(nameList(admin.people)).toEqual([PHONE_NAME, LOGIN_PHONE_NAME]);
  });
});

describe('SectorPeopleService — nome que é telefone (D11), candidatos', () => {
  it.each([
    ['sem a chave', NO_KEY, NO_SECTOR, '•••• 1234'],
    ['com a chave', MANAGER, NO_SECTOR, PHONE_NAME],
    ['ADMIN, pessoa com login', ADMIN, FROM_IT, PHONE_NAME],
  ])('%s', async (_label, actor, candidate, expected) => {
    const { service, repo } = harness([], [actor]);
    repo.listCandidates.mockResolvedValue([{ ...candidate, name: PHONE_NAME }]);

    const { items } = await service.candidates(actor.id, OPERATION.id, '');

    expect(nameList(items)).toEqual([expected]);
  });

  it('contact-candidates recebe quem lê (ADMIN e chave) para mascarar o nome no repositório', async () => {
    const { service, repo } = harness([], [ADMIN, NO_KEY]);

    await service.contactCandidates(ADMIN.id, OPERATION.id, '');
    await service.contactCandidates(NO_KEY.id, OPERATION.id, '');

    expect(repo.listContactCandidates.mock.calls).toEqual([
      ['', { isAdmin: true, fullPhone: true }],
      ['', { isAdmin: false, fullPhone: false }],
    ]);
  });
});

describe('SectorPeopleService — telefone por permissão', () => {
  it('matriz inicial: lista do setor igual a hoje, inclusive pessoa com login sem telefone para o gestor', async () => {
    const { service } = harness(PHONE_ROWS, [ADMIN, MANAGER]);

    const manager = await service.list(MANAGER.id, OPERATION.id);
    const admin = await service.list(ADMIN.id, OPERATION.id);

    expect(manager.people.map(phoneFields)).toEqual([
      ['+5592999997777', true, '•••• 7777'],
      [null, true, null],
      [null, false, null],
    ]);
    expect(admin.people[1].phoneE164).toBe('+5592999990002');
  });

  it('sem a chave: phoneE164 null, phoneMasked "•••• 7777", hasPhone true; pessoa com login segue oculta', async () => {
    const { service } = harness(PHONE_ROWS, [NO_KEY]);

    const { people } = await service.list(NO_KEY.id, OPERATION.id);

    expect(people.map(phoneFields)).toEqual([
      [null, true, '•••• 7777'],
      [null, true, null],
      [null, false, null],
    ]);
  });

  it.each([
    ['com a chave', MANAGER],
    ['sem a chave', NO_KEY],
  ])(
    'pessoa sem telefone: hasPhone false e phoneMasked null, %s',
    async (_label, actor) => {
      const { service } = harness([row({ phoneE164: null })], [actor]);

      const { people } = await service.list(actor.id, OPERATION.id);

      expect(people.map(phoneFields)).toEqual([[null, false, null]]);
    },
  );
});

describe('SectorPeopleService — telefone por permissão, busca', () => {
  it.each([
    ['com a chave', MANAGER, true],
    ['sem a chave', NO_KEY, false],
  ])(
    'busca por telefone nos candidatos e nos contatos: %s',
    async (_label, actor, full) => {
      const { service, repo } = harness([], [actor]);

      await service.candidates(actor.id, OPERATION.id, '9999');
      await service.contactCandidates(actor.id, OPERATION.id, '9999');

      expect(repo.listCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ searchPhone: full }),
      );
      expect(repo.listContactCandidates).toHaveBeenCalledWith('9999', {
        isAdmin: false,
        fullPhone: full,
      });
    },
  );
});

describe('SectorPeopleService — lista com inativos (A3)', () => {
  it('com includeInactive o repositório recebe a flag e a resposta traz o inativo com isActive false', async () => {
    const inactive = row({ id: 'user_olga', name: 'Olga', isActive: false });
    const { service, repo } = harness([row(), inactive]);

    const result = await service.list(MANAGER.id, OPERATION.id, true);

    expect(repo.listPeople).toHaveBeenCalledWith(OPERATION.id, true, KEY_VIEW);
    expect(result.people.map((p) => [p.id, p.isActive])).toEqual([
      ['user_ana', true],
      ['user_olga', false],
    ]);
  });
});

describe('SectorPeopleService — ficha na resposta', () => {
  it('traz matrícula, situação e autorização (C6) e mantém o telefone escondido de quem tem login', async () => {
    const person = row({
      hasAccess: true,
      role: 'OPERATOR',
      registration: 'M-100',
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'OUTRO',
      authorizationNote: 'Combinado por e-mail',
      authorizationDate: new Date('2026-11-10T00:00:00.000Z'),
      authorizationRecordedAt: new Date('2026-11-10T12:00:00.000Z'),
    });
    const { service } = harness([person]);

    const [seen] = (await service.list(MANAGER.id, OPERATION.id)).people;

    expect(seen).toMatchObject({
      phoneE164: null,
      registration: 'M-100',
      isActive: true,
      contactAuthorization: {
        status: 'AUTORIZADO',
        source: 'OUTRO',
        note: 'Combinado por e-mail',
        date: '2026-11-10',
        recordedAt: '2026-11-10T12:00:00.000Z',
      },
    });
  });

  it('pessoa sem registro devolve matrícula nula e NAO_AUTORIZADO', async () => {
    const { service } = harness([row()]);

    const [seen] = (await service.list(ADMIN.id, OPERATION.id)).people;

    expect(seen.registration).toBeNull();
    expect(seen.contactAuthorization).toMatchObject({
      status: 'NAO_AUTORIZADO',
      source: null,
      date: null,
    });
  });
});

describe('SectorPeopleService — leitura', () => {
  it('gestor de Operação lista Operação com options de níveis e turnos ativos (sem o inativo)', async () => {
    const { service, repo, levels } = harness();

    const result = await service.list(MANAGER.id, OPERATION.id);

    expect(repo.listPeople).toHaveBeenCalledWith(OPERATION.id, false, KEY_VIEW);
    expect(levels.listActive).toHaveBeenCalled();
    expect(result.sector).toEqual({
      id: OPERATION.id,
      name: 'Operação',
      code: 'OPE',
      isActive: true,
      manager: { id: MANAGER.id, name: 'Marta' },
      channel: {
        id: 'channel_ope',
        name: 'Operação Zap',
        phoneE164: '+5592999990001',
      },
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
        searchPhone: true,
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

    expect(repo.listContactCandidates).toHaveBeenCalledWith('9288', {
      isAdmin: false,
      fullPhone: true,
    });
    expect(result).toEqual({ items: [item] });
  });
});
