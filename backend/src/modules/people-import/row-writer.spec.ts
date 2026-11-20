import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PermissionKey } from '../../shared/authz/permissions';
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '../../shared/errors/domain.error';
import { type ImportActor, toImportActor } from './import-actor';
import type {
  CreatePlan,
  ImportPatch,
  ImportPerson,
  RowOutcome,
  RowPlan,
} from './import-person';
import { personFingerprint } from './person-diff';
import { ROW_TEXT } from './row-texts';
import { RowWriter } from './row-writer';
import type { StructureCatalog } from './structure-match';

const SECTOR_A = 'sector-a';
const SECTOR_B = 'sector-b';
const NEW_ID = 'pessoa-da-linha';
const NEW_PHONE = '+5592991110009';
const OTHER_PHONE = '+5592991110002';
const REASON = 'Importação de planilha: equipe.xlsx';
const AUTHORIZED = { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' } as const;
const CATALOG: StructureCatalog = {
  sector: [
    { id: SECTOR_A, name: 'Operação', code: 'OPE', isActive: true },
    { id: SECTOR_B, name: 'RH', code: 'RH', isActive: true },
  ],
  shift: [],
  level: [],
};
const ADMIN = toImportActor({ ...actorWith('ADMIN'), managedSectorIds: [] });

/** Gestor do setor A (com a chave por padrão), menos as permissões dadas. */
function manager(revoke: PermissionKey[] = []): ImportActor {
  return toImportActor({
    ...actorWith('SUPERVISOR', { revoke }),
    managedSectorIds: [SECTOR_A],
  });
}
const NO_KEY = manager(['telefone.ver_completo']);

function person(change: Partial<ImportPerson> = {}): ImportPerson {
  return {
    id: 'pessoa-1',
    name: 'Ana Souza',
    phoneE164: '+5592991110001',
    registration: 'M-1',
    registrationKey: 'm-1',
    jobTitle: null,
    sectorId: SECTOR_A,
    shiftId: null,
    levelId: null,
    authorization: {
      status: 'NAO_AUTORIZADO',
      source: null,
      note: null,
      date: null,
    },
    isActive: true,
    hasAccess: false,
    ...change,
  };
}

/** Atualização da prévia, achada pela matrícula, com a versão de `before`. */
function updateOf(patch: ImportPatch, before = person()): RowPlan {
  return {
    kind: 'update',
    keys: { registrationKey: before.registrationKey, phoneE164: null },
    personId: before.id,
    fingerprint: personFingerprint(before),
    patch,
  };
}

function createOf(
  input: Partial<CreatePlan> = {},
): Extract<RowPlan, { kind: 'create' }> {
  const plan = { name: 'Bruno Lima', phone: NEW_PHONE, sectorId: SECTOR_A };
  const full: CreatePlan = { ...plan, ...input };
  return {
    kind: 'create',
    keys: {
      registrationKey: full.registration?.toLowerCase() ?? null,
      phoneE164: full.phone,
    },
    input: full,
  };
}

type KeyQuery = {
  ids?: readonly string[];
  registrationKeys: readonly string[];
  phones: readonly string[];
};

/** Repositório falso: acha como o real, por chave exata em qualquer lista. */
function matches(p: ImportPerson, q: KeyQuery): boolean {
  return (
    (q.ids ?? []).includes(p.id) ||
    (p.registrationKey !== null &&
      q.registrationKeys.includes(p.registrationKey)) ||
    (p.phoneE164 !== null && q.phones.includes(p.phoneE164))
  );
}

function setup(db: ImportPerson[] = []) {
  const people = {
    findPeopleByKeys: vi.fn((q: KeyQuery) =>
      Promise.resolve(db.filter((p) => matches(p, q))),
    ),
  };
  const users = {
    createPersonWithoutAccess: vi.fn().mockResolvedValue({ id: NEW_ID }),
    updateUser: vi.fn().mockResolvedValue(undefined),
  };
  const writer = new RowWriter(people as never, users as never);
  const write = (
    plan: RowPlan,
    actor = ADMIN,
    personId: string | null = NEW_ID,
  ) =>
    writer.write({
      plan,
      personId: plan.kind === 'update' ? plan.personId : personId,
      actor,
      reason: REASON,
      catalog: CATALOG,
    });
  return { people, users, write };
}

const failedWith = (reason: string): RowOutcome => ({
  outcome: 'FAILED',
  reason,
  personId: null,
});
const settled = (outcome: RowOutcome['outcome'], personId: string) => ({
  outcome,
  reason: null,
  personId,
});

let logError: MockInstance<Logger['error']>;

beforeEach(() => {
  logError = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RowWriter — matrícula trocada depois da prévia (T20a m1)', () => {
  it('matrícula da pessoa diferente da chave da linha: mudou depois da prévia, antes de Sem alteração', async () => {
    const plan = updateOf({ jobTitle: 'Analista' });
    // Função já igual à da linha, mas a matrícula passou a ser outra e ninguém tem a da linha.
    const moved = setup([
      person({ jobTitle: 'Analista', registrationKey: 'm-2' }),
    ]);
    await expect(moved.write(plan)).resolves.toEqual(
      failedWith(ROW_TEXT.changedAfterPreview),
    );
    expect(moved.users.updateUser).not.toHaveBeenCalled();
  });

  it('pessoa sem matrícula que a linha acrescenta (achada pelo telefone) segue para a gravação', async () => {
    const before = person({ registration: null, registrationKey: null });
    const plan = {
      ...updateOf({ registration: 'M-1' }, before),
      keys: { registrationKey: 'm-1', phoneE164: null },
    };
    const added = setup([before]);
    await expect(added.write(plan)).resolves.toEqual(
      settled('UPDATED', 'pessoa-1'),
    );
  });
});

describe('RowWriter — ordem E6 na atualização', () => {
  it('ordem E6: reidentifica, Sem alteração antes da versão, depois versão e conflitos', async () => {
    const plan = updateOf({ jobTitle: 'Analista' });
    // Já com a função da linha, mesmo em outra versão: Sem alteração.
    const done = setup([person({ jobTitle: 'Analista', name: 'Ana S.' })]);
    await expect(done.write(plan)).resolves.toEqual(
      settled('UNCHANGED', 'pessoa-1'),
    );
    // Mudou outro campo depois da prévia: a versão barra.
    const changed = setup([person({ name: 'Ana S.' })]);
    await expect(changed.write(plan)).resolves.toEqual(
      failedWith(ROW_TEXT.changedAfterPreview),
    );
    // A matrícula da linha passou a ser de outra pessoa.
    const taken = setup([
      person({ registrationKey: 'm-2' }),
      person({ id: 'pessoa-2', phoneE164: OTHER_PHONE }),
    ]);
    await expect(taken.write(plan)).resolves.toEqual(
      failedWith(ROW_TEXT.registrationTaken),
    );
    await expect(setup().write(plan)).resolves.toEqual(
      failedWith(ROW_TEXT.removedAfterPreview),
    );
    for (const s of [done, changed, taken]) {
      expect(s.users.updateUser).not.toHaveBeenCalled();
    }
  });

  it('atualização grava pelo updateUser só os campos do plano, com o motivo; pessoa inativa falha', async () => {
    const ok = setup([person()]);
    const patch = { jobTitle: 'Analista', sectorId: SECTOR_B, role: 'ADMIN' };
    await expect(ok.write(updateOf(patch as ImportPatch))).resolves.toEqual(
      settled('UPDATED', 'pessoa-1'),
    );
    expect(ok.users.updateUser).toHaveBeenCalledWith(
      'pessoa-1',
      { jobTitle: 'Analista', sectorId: SECTOR_B },
      ADMIN.id,
      { reason: REASON },
    );
    const inactive = person({ isActive: false });
    const off = setup([inactive]);
    await expect(
      off.write(updateOf({ jobTitle: 'Analista' }, inactive)),
    ).resolves.toEqual(failedWith(ROW_TEXT.inactivePerson));
    expect(off.users.updateUser).not.toHaveBeenCalled();
  });
});

describe('RowWriter — travas de quem não é ADMIN (EX19)', () => {
  it('trava de quem não é ADMIN conferida de novo na gravação', async () => {
    const plan = updateOf({ jobTitle: 'Analista' });
    const left = person({ sectorId: SECTOR_B, jobTitle: 'Analista' });
    const login = person({ hasAccess: true, jobTitle: 'Analista' });
    for (const now of [left, login]) {
      const s = setup([now]);
      await expect(s.write(plan, manager())).resolves.toEqual(
        failedWith(ROW_TEXT.cannotEditPerson),
      );
    }
    // S2-6: com login, qualquer telefone dá a mesma resposta (aceite 27).
    const phone = updateOf({ phone: OTHER_PHONE });
    for (const actor of [manager(), NO_KEY]) {
      const s = setup([person({ hasAccess: true })]);
      await expect(s.write(phone, actor)).resolves.toEqual(
        failedWith(ROW_TEXT.cannotEditPerson),
      );
    }
    const lost = setup([person()]);
    const auth = updateOf({ contactAuthorization: AUTHORIZED });
    await expect(
      lost.write(auth, manager(['pessoas.editar'])),
    ).resolves.toEqual(failedWith(ROW_TEXT.cannotEditAuthorization));
    expect(lost.users.updateUser).not.toHaveBeenCalled();
    // ADMIN não passa por essas travas.
    await expect(setup([login]).write(plan)).resolves.toEqual(
      settled('UNCHANGED', 'pessoa-1'),
    );
  });
});

describe('RowWriter — setor de destino (EX19 a)', () => {
  it('setor de destino fora do alcance de agora: a linha falha com notInReach', async () => {
    const outside = failedWith(ROW_TEXT.notInReach('RH'));
    const create = setup();
    await expect(
      create.write(createOf({ sectorId: SECTOR_B }), manager()),
    ).resolves.toEqual(outside);
    expect(create.users.createPersonWithoutAccess).not.toHaveBeenCalled();
    const update = setup([person()]);
    await expect(
      update.write(updateOf({ sectorId: SECTOR_B }), manager()),
    ).resolves.toEqual(outside);
    expect(update.users.updateUser).not.toHaveBeenCalled();
    await expect(
      setup().write(createOf({ sectorId: SECTOR_B })),
    ).resolves.toEqual(settled('CREATED', NEW_ID));
    // Quem não é ADMIN nunca cria pessoa sem setor (fora do alcance).
    await expect(
      setup().write(createOf({ sectorId: undefined }), manager()),
    ).resolves.toEqual(failedWith(ROW_TEXT.sectorRequired));
  });
});

describe('RowWriter — telefone de quem não tem a chave (EX17)', () => {
  it('sem telefone.ver_completo na gravação: telefone fica fora da comparação e a linha falha com cannotEditPhone', async () => {
    const current = person();
    for (const phone of [current.phoneE164 ?? '', OTHER_PHONE]) {
      const s = setup([current]);
      await expect(s.write(updateOf({ phone }), NO_KEY)).resolves.toEqual(
        failedWith(ROW_TEXT.cannotEditPhone),
      );
      expect(s.users.updateUser).not.toHaveBeenCalled();
    }
  });

  it('S2-5: pessoa que ganhou telefone entre a prévia e a gravação falha com cannotEditPhone, nunca Sem alteração', async () => {
    const before = person({ phoneE164: null });
    const plan = updateOf({ phone: NEW_PHONE }, before);
    for (const phoneE164 of [NEW_PHONE, OTHER_PHONE]) {
      const s = setup([person({ phoneE164 })]);
      await expect(s.write(plan, NO_KEY)).resolves.toEqual(
        failedWith(ROW_TEXT.cannotEditPhone),
      );
      expect(s.users.updateUser).not.toHaveBeenCalled();
    }
    // Ainda sem telefone: o número vai para o updateUser, que confere se está livre.
    await expect(setup([before]).write(plan, NO_KEY)).resolves.toEqual(
      settled('UPDATED', 'pessoa-1'),
    );
  });
});

describe('criação achada de novo (EX17.4)', () => {
  it('criação: pessoa com o id da linha já existe dá Sem alteração antes das travas, inclusive sem a chave e sem matrícula', async () => {
    const own = person({
      id: NEW_ID,
      sectorId: SECTOR_B,
      registrationKey: null,
    });
    const s = setup([own]);
    await expect(
      s.write(createOf({ sectorId: SECTOR_B }), NO_KEY),
    ).resolves.toEqual(settled('UNCHANGED', NEW_ID));
    expect(s.users.createPersonWithoutAccess).not.toHaveBeenCalled();
    expect(s.people.findPeopleByKeys).toHaveBeenCalledTimes(1);
    expect(s.people.findPeopleByKeys).toHaveBeenCalledWith({
      ids: [NEW_ID],
      registrationKeys: [],
      phones: [],
    });
  });

  it('sem a chave, criação: matrícula de outra pessoa ou phone_taken falham sem comparar valores', async () => {
    const same = createOf({ name: 'Ana Souza', phone: '+5592991110001' });
    const twin = setup([person()]);
    const byRegistration = createOf({ ...same.input, registration: 'M-1' });
    await expect(twin.write(byRegistration, NO_KEY)).resolves.toEqual(
      failedWith(ROW_TEXT.registrationTaken),
    );
    expect(twin.users.createPersonWithoutAccess).not.toHaveBeenCalled();
    const taken = setup([person()]);
    taken.users.createPersonWithoutAccess.mockRejectedValue(
      new ConflictError('Phone already taken', 'user.phone_taken'),
    );
    await expect(taken.write(same, NO_KEY)).resolves.toEqual(
      failedWith(ROW_TEXT.phoneTaken),
    );
    for (const s of [twin, taken]) {
      for (const [query] of s.people.findPeopleByKeys.mock.calls) {
        expect(query.phones).toEqual([]);
      }
    }
  });
});

describe('criação achada de novo com a chave (EX17.4 c, m2)', () => {
  it('com a chave, criação achada de novo: ADMIN com os valores da linha dá Sem alteração; gestor com pessoa fora do alcance ou com login falha com phoneTaken ou registrationTaken; nunca cannotEditPerson', async () => {
    const row = createOf({ name: 'Ana Souza', phone: '+5592991110001' });
    const found = (change: Partial<ImportPerson>, actor = ADMIN, plan = row) =>
      setup([person(change)]).write(plan, actor);
    const unchanged = settled('UNCHANGED', 'pessoa-1');
    await expect(found({})).resolves.toEqual(unchanged);
    await expect(found({ hasAccess: true })).resolves.toEqual(unchanged);
    await expect(found({}, manager())).resolves.toEqual(unchanged);
    const phoneTaken = failedWith(ROW_TEXT.phoneTaken);
    await expect(found({ name: 'Outra' })).resolves.toEqual(phoneTaken);
    await expect(found({ sectorId: SECTOR_B }, manager())).resolves.toEqual(
      phoneTaken,
    );
    await expect(found({ hasAccess: true }, manager())).resolves.toEqual(
      phoneTaken,
    );
    const byRegistration = createOf({ registration: 'M-1' });
    await expect(
      found({ hasAccess: true }, manager(), byRegistration),
    ).resolves.toEqual(failedWith(ROW_TEXT.registrationTaken));
    // Matrícula de uma pessoa e telefone de outra: conflito de telefone.
    const split = setup([
      person(),
      person({ id: 'pessoa-2', registrationKey: 'm-2', phoneE164: NEW_PHONE }),
    ]);
    await expect(split.write(byRegistration)).resolves.toEqual(phoneTaken);
  });
});

describe('criação relida pelo id depois de erro (EX17.4 a, m1)', () => {
  it('phone_taken na criação relê pelo id: pessoa da própria linha dá Sem alteração', async () => {
    const db: ImportPerson[] = [];
    const s = setup(db);
    s.users.createPersonWithoutAccess.mockImplementation(() => {
      db.push(person({ id: NEW_ID, phoneE164: NEW_PHONE }));
      return Promise.reject(new ConflictError('x', 'user.phone_taken'));
    });
    await expect(s.write(createOf(), NO_KEY)).resolves.toEqual(
      settled('UNCHANGED', NEW_ID),
    );
  });

  it('erro desconhecido na criação e pessoa da linha existente → UNCHANGED', async () => {
    const race = new Prisma.PrismaClientKnownRequestError('Unique', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['id'] },
    });
    for (const error of [race, new Error('qualquer')]) {
      const db: ImportPerson[] = [];
      const s = setup(db);
      s.users.createPersonWithoutAccess.mockImplementation(() => {
        db.push(person({ id: NEW_ID, phoneE164: NEW_PHONE }));
        return Promise.reject(error);
      });
      await expect(s.write(createOf())).resolves.toEqual(
        settled('UNCHANGED', NEW_ID),
      );
    }
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('RowWriter — erros do cadastro (EX20)', () => {
  it('erros do cadastro viram motivos da linha; erro desconhecido loga sem dado pessoal', async () => {
    const coded = (code: string) => new DomainError({ code, message: 'x' });
    const table: [Error, string][] = [
      [new ConflictError('x', 'user.phone_taken'), ROW_TEXT.phoneTaken],
      [coded('user.registration_taken'), ROW_TEXT.registrationTaken],
      [coded('user.sector_invalid'), ROW_TEXT.structureInactive],
      [coded('users.invalid_shift'), ROW_TEXT.structureInactive],
      [coded('users.invalid_level'), ROW_TEXT.structureInactive],
      [coded('user.invalid_phone'), ROW_TEXT.invalidPhone],
      [coded('user.authorization_future_date'), ROW_TEXT.futureDate],
      [new NotFoundError('User', 'pessoa-1'), ROW_TEXT.removedAfterPreview],
    ];
    for (const [error, reason] of table) {
      const s = setup([person()]);
      s.users.updateUser.mockRejectedValue(error);
      await expect(s.write(updateOf({ jobTitle: 'X' }))).resolves.toEqual(
        failedWith(reason),
      );
    }
    expect(logError).not.toHaveBeenCalled();
    const s = setup([person()]);
    s.users.updateUser.mockRejectedValue(
      new Error('Ana Souza +5592991110001 pessoa-1'),
    );
    await expect(s.write(updateOf({ jobTitle: 'X' }))).resolves.toEqual(
      failedWith(ROW_TEXT.writeFailed),
    );
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain(
      'falha ao gravar linha da importação (código Error)',
    );
    for (const secret of ['Ana', '9299111', 'pessoa-1']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('RowWriter — erro de pessoa sumida e de corrida (EX20)', () => {
  it('Error USER_NOT_FOUND vira removedAfterPreview; user.concurrent_admin_change vira o texto genérico e FAILED', async () => {
    const gone = setup([person()]);
    gone.users.updateUser.mockRejectedValue(new Error('USER_NOT_FOUND'));
    await expect(gone.write(updateOf({ jobTitle: 'X' }))).resolves.toEqual(
      failedWith(ROW_TEXT.removedAfterPreview),
    );
    const race = setup([person()]);
    race.users.updateUser.mockRejectedValue(
      new ConflictError('x', 'user.concurrent_admin_change'),
    );
    await expect(race.write(updateOf({ jobTitle: 'X' }))).resolves.toEqual(
      failedWith(ROW_TEXT.writeFailed),
    );
    expect(logError).toHaveBeenCalledWith(
      'falha ao gravar linha da importação (código user.concurrent_admin_change)',
    );
  });
});

describe('RowWriter — entrada da criação', () => {
  it('criação passa sectorId nulo quando o plano não tem setor', async () => {
    const s = setup();
    await s.write(createOf({ sectorId: undefined, jobTitle: 'Analista' }));
    expect(s.users.createPersonWithoutAccess).toHaveBeenCalledWith(
      ADMIN.id,
      {
        name: 'Bruno Lima',
        phone: NEW_PHONE,
        sectorId: null,
        jobTitle: 'Analista',
      },
      { reason: REASON, personId: NEW_ID },
    );
  });

  it('criação passa o personId da linha como meta.personId', async () => {
    const s = setup();
    await expect(s.write(createOf(), ADMIN, 'id-reservado')).resolves.toEqual(
      settled('CREATED', 'id-reservado'),
    );
    expect(s.users.createPersonWithoutAccess).toHaveBeenCalledWith(
      ADMIN.id,
      expect.objectContaining({ sectorId: SECTOR_A }),
      { reason: REASON, personId: 'id-reservado' },
    );
    // Sem personId (não acontece depois da reserva): falha sem dado pessoal.
    const none = setup();
    await expect(none.write(createOf(), ADMIN, null)).resolves.toEqual(
      failedWith(ROW_TEXT.writeFailed),
    );
    expect(none.users.createPersonWithoutAccess).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
