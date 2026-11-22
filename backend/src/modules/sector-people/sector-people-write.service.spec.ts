import { describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { AuditService } from '../../shared/audit/audit.service';
import { canEditContactAuthorization } from '../../shared/authz/person-actions.policy';
import {
  ConflictError,
  ForbiddenError,
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

// Spy sobre a função real: a guarda do `update` precisa ser consultada de fato (D16).
vi.mock('../../shared/authz/person-actions.policy', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../shared/authz/person-actions.policy')
    >();
  return {
    ...original,
    canEditContactAuthorization: vi.fn(original.canEditContactAuthorization),
  };
});

const ADMIN: PeopleActor = actorWith('ADMIN', { id: 'user_admin' });
const MANAGER: PeopleActor = actorWith('SUPERVISOR', { id: 'user_manager' });
// OPERATOR que gerencia um setor: passa o pré-gate, mas não inativa ninguém.
const OPERATOR_MANAGER: PeopleActor = actorWith('OPERATOR', {
  id: 'user_op_manager',
});
// Gerencia um setor, mas sem a chave do telefone completo (B3).
const NO_KEY: PeopleActor = actorWith('SUPERVISOR', {
  id: 'user_no_key',
  revoke: ['telefone.ver_completo'],
});
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
const FIELD = sector('sector_field', OPERATOR_MANAGER.id);
const NO_KEY_SECTOR = sector('sector_no_key', NO_KEY.id);
const SECTORS = [OPERATION, IT, HR, FIELD, NO_KEY_SECTOR];

type PersonLine = PeoplePerson & { name: string; hasPhone: boolean };
const person = (id: string, over: Partial<PersonLine> = {}): PersonLine => ({
  id,
  name: id,
  sectorId: null,
  hasAccess: false,
  isActive: true,
  hasPhone: false,
  ...over,
});
const PEOPLE = [
  person('user_ana', { sectorId: OPERATION.id }),
  person('user_bruno', { sectorId: OPERATION.id, hasAccess: true }),
  person('user_nina'),
  person('user_tiago', { sectorId: IT.id, hasAccess: true }),
  person('user_ivo', { isActive: false }),
  person('user_olga', { sectorId: OPERATION.id, isActive: false }),
  person('user_ines', { sectorId: FIELD.id }),
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
    registration: null,
    isActive: true,
    contactAuthorization: 'NAO_AUTORIZADO',
    authorizationSource: null,
    authorizationNote: null,
    authorizationDate: null,
    authorizationRecordedAt: null,
  };
}

function harness() {
  const repo = {
    findActor: vi.fn((id: string) =>
      find([ADMIN, MANAGER, OPERATOR_MANAGER, NO_KEY], id),
    ),
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

const GRANTED = {
  status: 'AUTORIZADO',
  source: 'TERMO_ASSINADO',
  date: '2026-11-10',
} as const;
const MOVED_META = {
  action: 'sector_people.person_moved',
  category: 'ASSIGNMENT',
};

const STATUS_FORBIDDEN = {
  status: 403,
  code: 'sector_people.status_forbidden',
};
const OFF = { isActive: false, reason: 'Desligamento' };

/** `setStatus` com o `harness` de sempre; `set(ator, setor, pessoa, corpo?)`. */
function statusHarness() {
  const { service, users } = harness();
  const set = (
    actor: PeopleActor,
    inSector: { id: string },
    userId: string,
    body: { isActive: boolean; reason?: string } = OFF,
  ) => service.setStatus(actor.id, inSector.id, userId, body);
  return { users, set };
}

const KEY_ERROR = { status: 403, code: 'auth.permission_denied' };
const PHONE_PATCH = { phone: '92991110009', reason: 'Telefone novo' };
const MASKED = { phoneE164: null, hasPhone: true, phoneMasked: '•••• 0001' };
const inNoKeySector = (hasPhone: boolean) =>
  person('user_carla', { sectorId: NO_KEY_SECTOR.id, hasPhone });

// D11: o contato sem nome (contact_0004) vira pessoa com o número como nome.
const NUMBER_AS_NAME = '+5592991110004';
const storedWithNumberAsName = (ids: string[]) =>
  Promise.resolve(
    ids.map((id) => ({
      ...personRow(id),
      name: NUMBER_AS_NAME,
      phoneE164: NUMBER_AS_NAME,
    })),
  );
const MASKED_0004 = {
  phoneE164: null,
  hasPhone: true,
  phoneMasked: '•••• 0004',
};
const FROM_UNNAMED = { contactIds: ['contact_0004'], ...BATCH };

describe('SectorPeopleWriteService — nome que é telefone (D11)', () => {
  it('dos contatos sem a chave: grava o número como nome, mas a resposta não traz o número', async () => {
    const { service, repo, users, audit } = harness();
    repo.findPersonRows.mockImplementation(storedWithNumberAsName);

    const { created } = await service.addFromContacts(
      NO_KEY.id,
      NO_KEY_SECTOR.id,
      FROM_UNNAMED,
    );

    expect(users.createPersonWithoutAccess).toHaveBeenCalledWith(
      NO_KEY.id,
      expect.objectContaining({ name: NUMBER_AS_NAME, phone: NUMBER_AS_NAME }),
    );
    expect(created[0]).toMatchObject({ name: '•••• 0004', ...MASKED_0004 });
    expect(JSON.stringify(created)).not.toContain('991110004');
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('991110004');
  });

  it('dos contatos com a chave: o nome sai como gravado', async () => {
    const { service, repo } = harness();
    repo.findPersonRows.mockImplementation(storedWithNumberAsName);

    const { created } = await service.addFromContacts(
      MANAGER.id,
      OPERATION.id,
      FROM_UNNAMED,
    );

    expect(created[0]).toMatchObject({
      name: NUMBER_AS_NAME,
      phoneE164: NUMBER_AS_NAME,
    });
  });
});

describe('SectorPeopleWriteService — telefone por permissão', () => {
  it('update sem a chave trocando telefone gravado → 403 auth.permission_denied', async () => {
    const { service, repo, users } = harness();
    repo.findPerson.mockResolvedValue(inNoKeySector(true));

    await expect(
      service.update(NO_KEY.id, NO_KEY_SECTOR.id, 'user_carla', PHONE_PATCH),
    ).rejects.toMatchObject(KEY_ERROR);
    expect(users.updateUser).not.toHaveBeenCalled();
  });

  it('update sem a chave dando telefone a quem não tinha passa e responde mascarado', async () => {
    const { service, repo, users } = harness();
    repo.findPerson.mockResolvedValue(inNoKeySector(false));

    const result = await service.update(
      NO_KEY.id,
      NO_KEY_SECTOR.id,
      'user_carla',
      PHONE_PATCH,
    );

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_carla',
      { phone: PHONE_PATCH.phone },
      NO_KEY.id,
      { reason: PHONE_PATCH.reason },
    );
    expect(result).toMatchObject(MASKED);
  });

  it('matriz inicial: com a chave o gestor ainda troca o telefone gravado', async () => {
    const { service, repo, users } = harness();
    repo.findPerson.mockResolvedValue(
      person('user_ana', { sectorId: OPERATION.id, hasPhone: true }),
    );

    await service.update(MANAGER.id, OPERATION.id, 'user_ana', PHONE_PATCH);

    expect(users.updateUser).toHaveBeenCalledOnce();
  });
});

describe('SectorPeopleWriteService — telefone por permissão, criação', () => {
  it('create sem a chave aceita telefone e responde mascarado', async () => {
    const { service, users } = harness();

    const result = await service.create(
      NO_KEY.id,
      NO_KEY_SECTOR.id,
      NEW_PERSON,
    );

    expect(users.createPersonWithoutAccess).toHaveBeenCalledWith(NO_KEY.id, {
      ...NEW_PERSON,
      sectorId: NO_KEY_SECTOR.id,
    });
    expect(result).toMatchObject(MASKED);
  });

  it('dos contatos sem a chave grava o número do contato e responde mascarado', async () => {
    const { service, users } = harness();

    const { created } = await service.addFromContacts(
      NO_KEY.id,
      NO_KEY_SECTOR.id,
      { contactIds: ['contact_0001'], ...BATCH },
    );

    expect(users.createPersonWithoutAccess).toHaveBeenCalledWith(
      NO_KEY.id,
      expect.objectContaining({ phone: '+5592991110001' }),
    );
    expect(created[0]).toMatchObject(MASKED);
  });
});

describe('SectorPeopleWriteService — status no setor, quem decide', () => {
  it('SUPERVISOR gestor inativa pessoa sem login do setor; updateUser recebe { isActive:false } e o motivo', async () => {
    const { users, set } = statusHarness();

    const result = await set(MANAGER, OPERATION, 'user_ana');

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      { isActive: false },
      MANAGER.id,
      { reason: 'Desligamento' },
    );
    expect(result).toMatchObject({ id: 'user_ana' });
  });

  it('pessoa com login: SUPERVISOR gestor → 403 status_forbidden; ADMIN inativa', async () => {
    const { users, set } = statusHarness();

    await expect(set(MANAGER, OPERATION, 'user_bruno')).rejects.toMatchObject(
      STATUS_FORBIDDEN,
    );
    expect(users.updateUser).not.toHaveBeenCalled();
    await set(ADMIN, OPERATION, 'user_bruno');
    expect(users.updateUser).toHaveBeenCalledTimes(1);
  });

  it('OPERATOR gestor → 403 status_forbidden, mesmo em pessoa sem login do setor', async () => {
    const { users, set } = statusHarness();

    await expect(
      set(OPERATOR_MANAGER, FIELD, 'user_ines'),
    ).rejects.toMatchObject(STATUS_FORBIDDEN);
    expect(users.updateUser).not.toHaveBeenCalled();
  });
});

describe('SectorPeopleWriteService — status no setor, alcance e motivo', () => {
  it.each([ADMIN, MANAGER])(
    'pessoa de outro setor → 403 sector_people.forbidden (%#)',
    async (actor) => {
      const { users, set } = statusHarness();

      await expect(set(actor, OPERATION, 'user_tiago')).rejects.toMatchObject(
        FORBIDDEN,
      );
      expect(users.updateUser).not.toHaveBeenCalled();
    },
  );

  it('sem reason → 422 user.reason_required; pessoa inexistente → 404', async () => {
    const { users, set } = statusHarness();

    await expect(
      set(MANAGER, OPERATION, 'user_ana', { isActive: false }),
    ).rejects.toMatchObject({ status: 422, code: 'user.reason_required' });
    await expect(set(MANAGER, OPERATION, 'user_x')).rejects.toMatchObject({
      status: 404,
      code: 'sector_people.person_not_found',
    });
    expect(users.updateUser).not.toHaveBeenCalled();
  });

  it('reativar pessoa inativa funciona (não exige ativa)', async () => {
    const { users, set } = statusHarness();
    const body = { isActive: true, reason: 'Voltou da licença' };

    await set(MANAGER, OPERATION, 'user_olga', body);

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_olga',
      { isActive: true },
      MANAGER.id,
      { reason: 'Voltou da licença' },
    );
  });
});

describe('SectorPeopleWriteService — status no setor, guardas do updateUser', () => {
  it.each([
    ['user.cannot_self_deactivate', /próprio cadastro/],
    ['user.last_admin', /último administrador/],
  ])(
    'guarda %s chega com o mesmo código e texto em pt-BR',
    async (code, text) => {
      const { users, set } = statusHarness();
      users.updateUser.mockRejectedValue(new ForbiddenError('Cannot', code));
      const message: unknown = expect.stringMatching(text);

      await expect(set(ADMIN, OPERATION, 'user_bruno')).rejects.toMatchObject({
        status: 403,
        code,
        message,
      });
    },
  );
});

describe('SectorPeopleWriteService — ficha no setor, repasse na criação', () => {
  it('create e from-contacts repassam contactAuthorization; from-contacts usa a mesma para o lote', async () => {
    const { service, users } = harness();
    const created = { ...NEW_PERSON, registration: 'M-100' };

    await service.create(MANAGER.id, OPERATION.id, {
      ...created,
      contactAuthorization: GRANTED,
    });
    await service.addFromContacts(MANAGER.id, OPERATION.id, {
      contactIds: ['contact_0001', 'contact_0002'],
      shiftId: 'shift_night',
      contactAuthorization: GRANTED,
    });

    const withGranted: unknown = expect.objectContaining({
      contactAuthorization: GRANTED,
    });
    expect(users.createPersonWithoutAccess).toHaveBeenNthCalledWith(
      1,
      MANAGER.id,
      expect.objectContaining({
        registration: 'M-100',
        contactAuthorization: GRANTED,
      }),
    );
    expect(users.createPersonWithoutAccess).toHaveBeenNthCalledWith(
      2,
      MANAGER.id,
      withGranted,
    );
    expect(users.createPersonWithoutAccess).toHaveBeenNthCalledWith(
      3,
      MANAGER.id,
      withGranted,
    );
  });
});

describe('SectorPeopleWriteService — ficha no setor, update com motivo', () => {
  it('update sem reason → 422 user.reason_required; com reason → updateUser recebe { reason }', async () => {
    const { service, users } = harness();
    const patch = { jobTitle: 'Auxiliar' };

    await expect(
      service.update(MANAGER.id, OPERATION.id, 'user_ana', patch),
    ).rejects.toMatchObject({ status: 422, code: 'user.reason_required' });
    expect(users.updateUser).not.toHaveBeenCalled();

    await service.update(MANAGER.id, OPERATION.id, 'user_ana', {
      ...patch,
      reason: 'Correção de função',
    });

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      patch,
      MANAGER.id,
      { reason: 'Correção de função' },
    );
  });

  it.each([
    { actor: MANAGER, patch: { contactAuthorization: GRANTED } },
    { actor: ADMIN, patch: { contactAuthorization: GRANTED } },
    { actor: ADMIN, patch: { registration: 'M-200' } },
  ])(
    'update de autorização ou matrícula de pessoa com acesso → 403 (limited), inclusive para ADMIN',
    async ({ actor, patch }) => {
      const { service, users } = harness();

      await expect(
        service.update(actor.id, OPERATION.id, 'user_bruno', {
          ...patch,
          reason: 'Termo assinado',
        }),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(users.updateUser).not.toHaveBeenCalled();
    },
  );
});

describe('SectorPeopleWriteService — ficha no setor, guarda da autorização', () => {
  it('update de contactAuthorization de pessoa sem acesso chama canEditContactAuthorization com o PeopleActor e passa', async () => {
    const { service, users } = harness();
    vi.mocked(canEditContactAuthorization).mockClear();

    await service.update(MANAGER.id, OPERATION.id, 'user_ana', {
      registration: null,
      contactAuthorization: GRANTED,
      reason: 'Termo assinado',
    });

    expect(canEditContactAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ id: MANAGER.id, role: 'SUPERVISOR' }),
      { hasAccess: false },
    );
    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      { registration: null, contactAuthorization: GRANTED },
      MANAGER.id,
      { reason: 'Termo assinado' },
    );
  });

  it('update: a guarda de autorização recusa → 403 sem gravar', async () => {
    const { service, users } = harness();
    vi.mocked(canEditContactAuthorization).mockReturnValueOnce(false);

    await expect(
      service.update(MANAGER.id, OPERATION.id, 'user_ana', {
        contactAuthorization: GRANTED,
        reason: 'Termo assinado',
      }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(users.updateUser).not.toHaveBeenCalled();
  });
});

describe('SectorPeopleWriteService — ficha no setor, mover e remover', () => {
  it('move repassa action sector_people.person_moved, ASSIGNMENT e reason opcional', async () => {
    const { service, users } = harness();

    await service.move(MANAGER.id, OPERATION.id, ['user_nina'], 'Reforço');
    await service.move(MANAGER.id, OPERATION.id, ['user_nina']);
    await expect(
      service.move(MANAGER.id, OPERATION.id, ['user_nina'], 'ab'),
    ).rejects.toMatchObject({ status: 422, code: 'user.reason_required' });

    const sector = { sectorId: OPERATION.id };
    expect(users.updateUser).toHaveBeenCalledTimes(2);
    expect(users.updateUser).toHaveBeenNthCalledWith(
      1,
      'user_nina',
      sector,
      MANAGER.id,
      { reason: 'Reforço', ...MOVED_META },
    );
    expect(users.updateUser).toHaveBeenNthCalledWith(
      2,
      'user_nina',
      sector,
      MANAGER.id,
      { reason: null, ...MOVED_META },
    );
  });

  it('remove repassa sector_people.person_removed e reason do corpo', async () => {
    const { service, users } = harness();

    await service.remove(MANAGER.id, OPERATION.id, 'user_ana', 'Desligada');

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      { sectorId: null },
      MANAGER.id,
      {
        reason: 'Desligada',
        action: 'sector_people.person_removed',
        category: 'ASSIGNMENT',
      },
    );
  });
});

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
      { category: null },
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
      { category: null },
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
      { category: null },
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
      { reason: null, ...MOVED_META },
    );
    expect(result.moved.map((p) => p.id)).toEqual(['user_nina']);
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.moved',
      'Sector',
      OPERATION.id,
      { actorId: MANAGER.id, sectorId: OPERATION.id, count: 1 },
      { category: null },
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
      { reason: null, ...MOVED_META },
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
      { levelId: 'level_employee', reason: 'Nível definido' },
    );

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_bruno',
      { levelId: 'level_employee' },
      MANAGER.id,
      { reason: 'Nível definido' },
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
    const patch = {
      jobTitle: 'Auxiliar',
      sectorId: IT.id,
      role: 'ADMIN',
      reason: 'Ajuste de função',
    };

    await service.update(MANAGER.id, OPERATION.id, 'user_ana', patch);

    expect(users.updateUser).toHaveBeenCalledWith(
      'user_ana',
      { jobTitle: 'Auxiliar' },
      MANAGER.id,
      { reason: 'Ajuste de função' },
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
      {
        reason: null,
        action: 'sector_people.person_removed',
        category: 'ASSIGNMENT',
      },
    );
    expect(audit.log).toHaveBeenCalledWith(
      'sector_people.removed',
      'Sector',
      OPERATION.id,
      { actorId: MANAGER.id, sectorId: OPERATION.id, userId: 'user_ana' },
      { category: null },
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
