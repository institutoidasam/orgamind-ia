import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../shared/audit/audit.service';
import {
  ConflictError,
  ValidationError,
} from '../../shared/errors/domain.error';
import type { LevelsRepository } from '../levels/levels.repository';
import type { ShiftsRepository } from '../shifts/shifts.repository';
import type { UsersService } from '../users/users.service';
import type { PeopleActor, PeoplePerson } from './sector-people.policy';
import type {
  BatchContact,
  SectorPeopleRepository,
  SectorPersonRow,
} from './sector-people.repository';
import { SectorPeopleService } from './sector-people.service';
import { SectorPeopleWriteService } from './sector-people-write.service';

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
const sector = (id: string, managerId: string | null) => ({
  id,
  name: id,
  code: id,
  isActive: true,
  managerId,
  manager: null,
});
const OPERATION = sector('sector_operation', MANAGER.id);
const IT = sector('sector_it', 'user_other');
const HR = sector('sector_hr', null);
const SECTORS = [OPERATION, IT, HR];

const person = (
  id: string,
  over: Partial<PeoplePerson> = {},
): PeoplePerson & { name: string } => ({
  id,
  name: id,
  sectorId: null,
  hasAccess: false,
  isActive: true,
  ...over,
});
const PEOPLE = [
  person('user_ana', { sectorId: OPERATION.id }),
  person('user_bruno', { sectorId: OPERATION.id, hasAccess: true }),
  person('user_nina'),
  person('user_tiago', { sectorId: IT.id, hasAccess: true }),
  person('user_ivo', { isActive: false }),
];

const contact = (
  id: string,
  name: string | null,
  personId: string | null = null,
): BatchContact => ({
  id,
  name,
  phoneE164: `+559299111${id.slice(-4)}`,
  personId,
});
const CONTACTS = [
  contact('contact_0001', 'Rita'),
  contact('contact_0002', 'Sara'),
  contact('contact_0003', 'Téo'),
  contact('contact_0004', null),
  contact('contact_0005', 'Ana', 'user_ana'),
];

const LEVELS = [
  { id: 'level_employee', isActive: true },
  { id: 'level_old', isActive: false },
];
const SHIFTS = [
  { id: 'shift_night', isActive: true },
  { id: 'shift_old', isActive: false },
];
const find = <T extends { id: string }>(items: readonly T[], id: string) =>
  Promise.resolve(items.find((item) => item.id === id) ?? null);

function personRow(id: string): SectorPersonRow {
  const known = PEOPLE.find((p) => p.id === id);
  return {
    id,
    name: id,
    email: null,
    phoneE164: '+5592999990001',
    hasAccess: known?.hasAccess ?? false,
    role: known?.hasAccess ? 'OPERATOR' : 'VIEWER',
    jobTitle: null,
    level: null,
    workShift: null,
  };
}

function harness() {
  const repo = {
    findActor: vi.fn((id: string) => find([ADMIN, MANAGER], id)),
    findSector: vi.fn((id: string) => find(SECTORS, id)),
    findPerson: vi.fn((id: string) => find(PEOPLE, id)),
    findPeople: vi.fn((ids: string[]) =>
      Promise.resolve(PEOPLE.filter((p) => ids.includes(p.id))),
    ),
    findContactsForBatch: vi.fn((ids: string[]) =>
      Promise.resolve(CONTACTS.filter((c) => ids.includes(c.id))),
    ),
    isContactLinked: vi.fn().mockResolvedValue(false),
    findPersonRows: vi.fn((ids: string[]) =>
      Promise.resolve(ids.map(personRow)),
    ),
    findLevelAndShift: vi.fn(
      async (levelId: string | null, shiftId: string) => ({
        level: levelId ? await find(LEVELS, levelId) : null,
        shift: await find(SHIFTS, shiftId),
      }),
    ),
  };
  let created = 0;
  const users = {
    createPersonWithoutAccess: vi.fn(() =>
      Promise.resolve({ id: `user_created_${++created}` }),
    ),
    updateUser: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const people = new SectorPeopleService(
    repo as unknown as SectorPeopleRepository,
    {} as LevelsRepository,
    {} as ShiftsRepository,
  );
  const service = new SectorPeopleWriteService(
    people,
    repo as unknown as SectorPeopleRepository,
    users as unknown as UsersService,
    audit as unknown as AuditService,
  );
  return { service, repo, users, audit };
}

const FORBIDDEN = { status: 403, code: 'sector_people.forbidden' };
const NEW_PERSON = {
  name: 'Rita',
  phone: '92991110001',
  levelId: 'level_employee',
  jobTitle: 'Auxiliar',
  shiftId: 'shift_night',
};
const BATCH = { levelId: 'level_employee', shiftId: 'shift_night' };

describe('SectorPeopleWriteService — nova pessoa', () => {
  it('gestor de Operação cria sem acesso em Operação com nível e turno', async () => {
    const { service, users, audit } = harness();

    const result = await service.create(MANAGER.id, OPERATION.id, NEW_PERSON);

    expect(users.createPersonWithoutAccess).toHaveBeenCalledWith(MANAGER.id, {
      ...NEW_PERSON,
      sectorId: OPERATION.id,
    });
    expect(result).toMatchObject({
      id: 'user_created_1',
      hasAccess: false,
      editable: 'full',
    });
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.added',
      'Sector',
      OPERATION.id,
      {
        actorId: MANAGER.id,
        sectorId: OPERATION.id,
        source: 'new',
        created: 1,
        failed: 0,
      },
    );
  });

  it('gestor de Operação criando em TI → 403 sem chamar UsersService', async () => {
    const { service, users } = harness();

    await expect(
      service.create(MANAGER.id, IT.id, NEW_PERSON),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(users.createPersonWithoutAccess).not.toHaveBeenCalled();
  });
});

describe('SectorPeopleWriteService — dos contatos, criação', () => {
  it('ADMIN adiciona 3 contatos com Funcionário e um turno ativo: 3 criados, ligados aos contatos, nível level_employee, shiftId gravado', async () => {
    const { service, users, audit } = harness();
    const ids = ['contact_0001', 'contact_0002', 'contact_0003'];

    const result = await service.addFromContacts(ADMIN.id, HR.id, {
      contactIds: ids,
      ...BATCH,
    });

    expect(result.created.map((p) => p.id)).toEqual([
      'user_created_1',
      'user_created_2',
      'user_created_3',
    ]);
    expect(result.failed).toEqual([]);
    ids.forEach((id, index) => {
      const source = CONTACTS.find((c) => c.id === id);
      expect(users.createPersonWithoutAccess).toHaveBeenNthCalledWith(
        index + 1,
        ADMIN.id,
        expect.objectContaining({
          name: source?.name,
          phone: source?.phoneE164,
          sectorId: HR.id,
          ...BATCH,
        }),
      );
    });
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.added',
      'Sector',
      HR.id,
      {
        actorId: ADMIN.id,
        sectorId: HR.id,
        source: 'contacts',
        created: 3,
        failed: 0,
      },
    );
  });
});

describe('SectorPeopleWriteService — dos contatos, nome e ids repetidos', () => {
  it('contato sem nome vira pessoa com o número como nome', async () => {
    const { service, users } = harness();

    await service.addFromContacts(ADMIN.id, HR.id, {
      contactIds: ['contact_0004'],
      ...BATCH,
    });

    expect(users.createPersonWithoutAccess).toHaveBeenCalledWith(
      ADMIN.id,
      expect.objectContaining({ name: '+5592991110004' }),
    );
  });

  it('ids repetidos criam uma vez', async () => {
    const { service, users } = harness();

    const result = await service.addFromContacts(ADMIN.id, HR.id, {
      contactIds: [
        'contact_0001',
        'contact_0001',
        'contact_0002',
        'contact_0001',
      ],
      ...BATCH,
    });

    expect(users.createPersonWithoutAccess).toHaveBeenCalledTimes(2);
    expect(result.created).toHaveLength(2);
  });
});

describe('SectorPeopleWriteService — dos contatos, falha por item', () => {
  it('3 contatos, um com número de outra pessoa: 2 criados, 1 phone_taken', async () => {
    const { service, users, audit } = harness();
    users.createPersonWithoutAccess
      .mockResolvedValueOnce({ id: 'user_rita' })
      .mockRejectedValueOnce(
        new ConflictError('Phone already taken', 'user.phone_taken'),
      )
      .mockResolvedValueOnce({ id: 'user_teo' });

    const result = await service.addFromContacts(MANAGER.id, OPERATION.id, {
      contactIds: ['contact_0001', 'contact_0002', 'contact_0003'],
      shiftId: 'shift_night',
    });

    expect(result.created.map((p) => p.id)).toEqual(['user_rita', 'user_teo']);
    expect(result.failed).toEqual([
      { contactId: 'contact_0002', reason: 'phone_taken' },
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.added',
      'Sector',
      OPERATION.id,
      expect.objectContaining({ created: 2, failed: 1 }),
    );
  });

  it.each([
    { reason: 'already_person', contactId: 'contact_0005', error: null },
    { reason: 'contact_not_found', contactId: 'contact_9999', error: null },
    {
      reason: 'invalid_phone',
      contactId: 'contact_0001',
      error: new ValidationError('Telefone inválido', '', 'user.invalid_phone'),
    },
  ])('motivos por item: $reason', async ({ reason, contactId, error }) => {
    const { service, users } = harness();
    if (error) users.createPersonWithoutAccess.mockRejectedValueOnce(error);

    const result = await service.addFromContacts(ADMIN.id, HR.id, {
      contactIds: [contactId],
      shiftId: 'shift_night',
    });

    expect(result).toEqual({ created: [], failed: [{ contactId, reason }] });
  });
});

describe('SectorPeopleWriteService — dos contatos, corrida e erro de banco', () => {
  it('corrida: telefone recusado e o contato já ligado a outra pessoa → already_person', async () => {
    const { service, users, repo } = harness();
    users.createPersonWithoutAccess.mockRejectedValueOnce(
      new ConflictError('Phone already taken', 'user.phone_taken'),
    );
    repo.isContactLinked.mockResolvedValueOnce(true);

    const result = await service.addFromContacts(ADMIN.id, HR.id, {
      contactIds: ['contact_0001'],
      shiftId: 'shift_night',
    });

    expect(result.failed).toEqual([
      { contactId: 'contact_0001', reason: 'already_person' },
    ]);
  });

  it('erro que não é de telefone interrompe o lote sem desfazer os anteriores', async () => {
    const { service, users } = harness();
    users.createPersonWithoutAccess
      .mockResolvedValueOnce({ id: 'user_rita' })
      .mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.addFromContacts(ADMIN.id, HR.id, {
        contactIds: ['contact_0001', 'contact_0002', 'contact_0003'],
        shiftId: 'shift_night',
      }),
    ).rejects.toThrow('db down');
    expect(users.createPersonWithoutAccess).toHaveBeenCalledTimes(2);
  });
});

describe('SectorPeopleWriteService — pedido inválido antes de criar', () => {
  it('levelId inativo → 422 users.invalid_level e nenhum criado', async () => {
    const { service, users } = harness();

    await expect(
      service.addFromContacts(ADMIN.id, HR.id, {
        contactIds: ['contact_0001'],
        levelId: 'level_old',
        shiftId: 'shift_night',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'users.invalid_level' });
    expect(users.createPersonWithoutAccess).not.toHaveBeenCalled();
  });

  it.each(['create', 'addFromContacts'] as const)(
    '%s: shiftId inativo → 422 users.invalid_shift, nenhum criado',
    async (method) => {
      const { service, users } = harness();
      const call =
        method === 'create'
          ? service.create(ADMIN.id, HR.id, {
              ...NEW_PERSON,
              shiftId: 'shift_old',
            })
          : service.addFromContacts(ADMIN.id, HR.id, {
              contactIds: ['contact_0001'],
              shiftId: 'shift_old',
            });

      await expect(call).rejects.toMatchObject({
        status: 422,
        code: 'users.invalid_shift',
      });
      expect(users.createPersonWithoutAccess).not.toHaveBeenCalled();
    },
  );
});

describe('SectorPeopleWriteService — autorização no lote e ao tirar', () => {
  it.each(['addFromContacts', 'remove'] as const)(
    'gestor de Operação em TI: %s → 403 sem gravar',
    async (method) => {
      const { service, users } = harness();
      const call =
        method === 'remove'
          ? service.remove(MANAGER.id, IT.id, 'user_tiago')
          : service.addFromContacts(MANAGER.id, IT.id, {
              contactIds: ['contact_0001'],
              shiftId: 'shift_night',
            });

      await expect(call).rejects.toMatchObject(FORBIDDEN);
      expect(users.createPersonWithoutAccess).not.toHaveBeenCalled();
      expect(users.updateUser).not.toHaveBeenCalled();
    },
  );
});

describe('SectorPeopleWriteService — mover', () => {
  it('gestor move pessoa sem setor e sem acesso para Operação', async () => {
    const { service, users, audit } = harness();

    const result = await service.move(MANAGER.id, OPERATION.id, ['user_nina']);

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_nina',
      { sectorId: OPERATION.id },
      MANAGER.id,
    );
    expect(result.moved.map((p) => p.id)).toEqual(['user_nina']);
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.moved',
      'Sector',
      OPERATION.id,
      { actorId: MANAGER.id, sectorId: OPERATION.id, count: 1 },
    );
  });

  it('gestor movendo pessoa de TI → 403 e ninguém movido', async () => {
    const { service, users } = harness();

    await expect(
      service.move(MANAGER.id, OPERATION.id, ['user_nina', 'user_tiago']),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(users.updateUser).not.toHaveBeenCalled();
  });

  it('ADMIN move pessoa de TI para RH', async () => {
    const { service, users } = harness();

    const result = await service.move(ADMIN.id, HR.id, ['user_tiago']);

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_tiago',
      { sectorId: HR.id },
      ADMIN.id,
    );
    expect(result.moved[0]).toMatchObject({
      id: 'user_tiago',
      phoneE164: '+5592999990001',
      editable: 'limited',
    });
  });
});

describe('SectorPeopleWriteService — pessoa inexistente ou inativa', () => {
  it.each([
    { method: 'move', userId: 'user_ivo' },
    { method: 'move', userId: 'user_ghost' },
    { method: 'update', userId: 'user_ghost' },
    { method: 'remove', userId: 'user_ivo' },
  ] as const)(
    '$method $userId → 404 sector_people.person_not_found sem gravar',
    async ({ method, userId }) => {
      const { service, users } = harness();
      const calls = {
        move: () => service.move(ADMIN.id, HR.id, ['user_nina', userId]),
        update: () =>
          service.update(ADMIN.id, HR.id, userId, { jobTitle: 'Auxiliar' }),
        remove: () => service.remove(ADMIN.id, HR.id, userId),
      };

      await expect(calls[method]()).rejects.toMatchObject({
        status: 404,
        code: 'sector_people.person_not_found',
      });
      expect(users.updateUser).not.toHaveBeenCalled();
    },
  );
});

describe('SectorPeopleWriteService — editar', () => {
  it('gestor define nível de pessoa com acesso de Operação', async () => {
    const { service, users } = harness();

    const result = await service.update(
      MANAGER.id,
      OPERATION.id,
      'user_bruno',
      {
        levelId: 'level_employee',
      },
    );

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_bruno',
      { levelId: 'level_employee' },
      MANAGER.id,
    );
    expect(result).toMatchObject({
      id: 'user_bruno',
      phoneE164: null,
      editable: 'limited',
    });
  });

  it.each([
    {
      title: 'nome de pessoa com acesso',
      userId: 'user_bruno',
      patch: { name: 'Bruno S.' },
    },
    {
      title: 'pessoa de TI',
      userId: 'user_tiago',
      patch: { jobTitle: 'Analista' },
    },
  ])('gestor editando $title → 403 sem gravar', async ({ userId, patch }) => {
    const { service, users } = harness();

    await expect(
      service.update(MANAGER.id, OPERATION.id, userId, patch),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(users.updateUser).not.toHaveBeenCalled();
  });
});

describe('SectorPeopleWriteService — editar, campos fora do contrato', () => {
  it('campo fora do contrato no patch não chega ao UsersService', async () => {
    const { service, users } = harness();
    const patch = { jobTitle: 'Auxiliar', sectorId: IT.id, role: 'ADMIN' };

    await service.update(MANAGER.id, OPERATION.id, 'user_ana', patch);

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      { jobTitle: 'Auxiliar' },
      MANAGER.id,
    );
  });
});

describe('SectorPeopleWriteService — tirar do setor', () => {
  it('tirar do setor pessoa sem acesso → sectorId null', async () => {
    const { service, users, audit } = harness();

    await service.remove(MANAGER.id, OPERATION.id, 'user_ana');

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      { sectorId: null },
      MANAGER.id,
    );
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.removed',
      'Sector',
      OPERATION.id,
      { actorId: MANAGER.id, sectorId: OPERATION.id, userId: 'user_ana' },
    );
  });

  it('tirar pessoa com acesso → 422 sector_people.has_access', async () => {
    const { service, users } = harness();

    await expect(
      service.remove(MANAGER.id, OPERATION.id, 'user_bruno'),
    ).rejects.toMatchObject({ status: 422, code: 'sector_people.has_access' });
    expect(users.updateUser).not.toHaveBeenCalled();
  });

  it('tirar pessoa de outro setor → 403 sem gravar', async () => {
    const { service, users } = harness();

    await expect(
      service.remove(MANAGER.id, OPERATION.id, 'user_tiago'),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(users.updateUser).not.toHaveBeenCalled();
  });
});
