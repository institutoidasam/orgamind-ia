import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { AuditService } from '../../shared/audit/audit.service';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { rethrowRegistrationConflict } from './person-record';
import type { AssignmentPatch } from './assignment-timeline';
import {
  HISTORY_KINDS,
  seedHistory,
  seedNonHistory,
} from './person-history.test-fixtures';

// One container + `migrate deploy` for the whole file (both describes).
let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: UsersRepository;
let users: UsersService;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new UsersRepository(prisma as never);
  // Serviço de verdade sobre o banco de verdade: a trilha sai de recordChange.
  const audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  const refresh = { revokeAllForUser: () => Promise.resolve() };
  users = new UsersService(repo, audit, refresh as never, {} as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

// Pessoa sem acesso como o UsersService grava (D1), com a chave da matrícula.
const personData = (name: string, registration?: string) => ({
  name,
  hasAccess: false,
  role: 'VIEWER' as const,
  mustChangePassword: false,
  ...(registration
    ? { registration, registrationKey: registration.toLowerCase() }
    : {}),
});

const seedPerson = (name: string, phoneE164: string) =>
  prisma.user.create({ data: { ...personData(name), phoneE164 } });
const serialization = () =>
  new Prisma.PrismaClientKnownRequestError('serialization', {
    code: 'P2034',
    clientVersion: 'test',
  });
const probe = (tx: Prisma.TransactionClient, entity: string) =>
  tx.auditEvent.create({ data: { action: 'user.profile_updated', entity } });

const noTrail = () => Promise.resolve();
// Setor, turno e nível só pelo parâmetro `assignment` (DV15), com hoje fixo.
const assignment = (patch: AssignmentPatch) => ({
  patch,
  today: '2026-11-19',
  actorId: null,
});
const changeAssignment = (id: string, patch: AssignmentPatch) =>
  repo.updateWithLastAdminGuard(id, {}, undefined, assignment(patch));
const failingTrail = (tx: Prisma.TransactionClient, entity: string) =>
  probe(tx, entity).then(() => Promise.reject(new Error('falhou')));

// Pessoa da lista com situação e autorização de contato escolhidas.
const seedListed = (
  name: string,
  extra: Partial<Prisma.UserUncheckedCreateInput>,
  registration?: string,
) =>
  prisma.user.create({
    data: { ...personData(name, registration), ...extra },
  });

describe('busca na lista de usuários (aceite 7)', () => {
  it('aceite 7: busca "ab-12" acha a pessoa de matrícula "AB-12"', async () => {
    const target = await seedListed('Zelia Busca', {}, 'AB-12');
    await seedListed('Outra Busca', {}, 'XY-99');

    const byKey = await repo.findMany(1, 20, { q: ' ab-12 ' });
    expect(byKey.data.map((u) => u.id)).toEqual([target.id]);
    expect(byKey.total).toBe(1);
    expect(byKey.data[0]).toMatchObject({ registration: 'AB-12' });
    expect(byKey.data[0]).not.toHaveProperty('registrationKey');

    const byName = await repo.findMany(1, 20, { q: 'zELIA' });
    expect(byName.data.map((u) => u.id)).toEqual([target.id]);
  });

  it('"_" e "%" na busca não viram coringa', async () => {
    const target = await seedListed('Coringa Um', {}, 'LS_5');
    await seedListed('Coringa Dois', {}, 'LSX5');

    const found = await repo.findMany(1, 20, { q: 'ls_5' });
    expect(found.data.map((u) => u.id)).toEqual([target.id]);
    expect((await repo.findMany(1, 20, { q: '%' })).total).toBe(0);
  });
});

describe('filtros e contadores da lista de usuários (aceite 7 e 4)', () => {
  const unverified = {
    contactAuthorization: 'AUTORIZADO',
    authorizationSource: 'CADASTRO_ANTERIOR',
  } as const;

  it('situação e autorização restringem a lista, o total e a paginação', async () => {
    const a = await seedListed('Filtro7 A', unverified);
    const b = await seedListed('Filtro7 B', {});
    const c = await seedListed('Filtro7 C', { isActive: false });
    const ids = async (f: Parameters<typeof repo.findMany>[2]) =>
      (await repo.findMany(1, 20, { q: 'filtro7', ...f })).data
        .map((u) => u.id)
        .sort();

    expect(await ids({})).toEqual([a.id, b.id, c.id].sort());
    expect(await ids({ status: 'active' })).toEqual([a.id, b.id].sort());
    expect(await ids({ status: 'inactive' })).toEqual([c.id]);
    expect(await ids({ authorization: 'UNVERIFIED' })).toEqual([a.id]);
    expect(await ids({ authorization: 'NOT_AUTHORIZED' })).toEqual(
      [b.id, c.id].sort(),
    );
    expect(await ids({ hasAccess: true })).toEqual([]);
    const page2 = await repo.findMany(2, 2, { q: 'filtro7' });
    expect([page2.data.length, page2.total]).toEqual([1, 3]);
  });

  it('contadores contam só ativos, na base inteira, e batem com os filtros', async () => {
    const before = await repo.countAuthorizationPending();
    await seedListed('Conta A', unverified);
    await seedListed('Conta B', { ...unverified, isActive: false });
    await seedListed('Conta C', {});
    await seedListed('Conta D', { isActive: false });
    await seedListed('Conta E', {
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'TERMO_ASSINADO',
    });

    const after = await repo.countAuthorizationPending();
    expect(after.unverified - before.unverified).toBe(1);
    expect(after.notAuthorized - before.notAuthorized).toBe(1);
    const total = async (authorization: 'UNVERIFIED' | 'NOT_AUTHORIZED') =>
      (await repo.findMany(1, 1, { status: 'active', authorization })).total;
    expect(after).toEqual({
      unverified: await total('UNVERIFIED'),
      notAuthorized: await total('NOT_AUTHORIZED'),
    });
  });
});

describe('exclusão com histórico (aceite 6)', () => {
  it.each(HISTORY_KINDS)(
    '%s → hasHistory, a pessoa e o registro continuam e nenhuma trilha roda',
    async (kind) => {
      const person = await prisma.user.create({ data: personData(kind) });
      const linked = await seedHistory(prisma, kind, person.id);
      let trailRan = false;

      const result = await repo.deleteWithLastAdminGuard(person.id, () => {
        trailRan = true;
        return Promise.resolve();
      });

      expect(result).toEqual({ hasHistory: true });
      expect(trailRan).toBe(false);
      await expect(
        prisma.user.count({ where: { id: person.id } }),
      ).resolves.toBe(1);
      await expect(linked()).resolves.toBe(1);
    },
    60_000,
  );

  it('pelo serviço: 409 user.has_history, a pessoa continua e não sai evento user.deleted', async () => {
    const person = await prisma.user.create({ data: personData('Com escala') });
    await seedHistory(
      prisma,
      'exceção de escala (StaffScheduleException)',
      person.id,
    );

    await expect(
      users.deleteUser(person.id, 'admin-x', 'ADMIN'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'user.has_history',
    });
    await expect(prisma.user.count({ where: { id: person.id } })).resolves.toBe(
      1,
    );
    await expect(
      prisma.auditEvent.count({ where: { subjectUserId: person.id } }),
    ).resolves.toBe(0);
  }, 60_000);
});

describe('exclusão com histórico: marcador de leitura não conta (aceite 6)', () => {
  it('só marcador de leitura e evento que não é comentário não é histórico: a pessoa é excluída', async () => {
    const person = await prisma.user.create({ data: personData('Só leitura') });
    await seedNonHistory(prisma, person.id);

    await expect(
      repo.deleteWithLastAdminGuard(person.id, noTrail),
    ).resolves.toHaveProperty('deleted');
    await expect(prisma.user.count({ where: { id: person.id } })).resolves.toBe(
      0,
    );
  }, 60_000);
});

describe('exclusão sem histórico e trilha (aceite 6)', () => {
  it('pessoa sem nada → excluída; o evento user.deleted fica depois que ela some, mascarado', async () => {
    const person = await prisma.user.create({
      data: {
        ...personData('Zeca'),
        email: 'zeca@test.local',
        password: 'x',
        hasAccess: true,
        role: 'OPERATOR',
        phoneE164: '+5592990090001',
      },
    });

    await users.deleteUser(person.id, 'admin-x', 'ADMIN');

    await expect(prisma.user.count({ where: { id: person.id } })).resolves.toBe(
      0,
    );
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'user.deleted', subjectUserId: person.id },
    });
    expect(event).toMatchObject({
      actorId: 'admin-x',
      entity: 'User',
      entityId: person.id,
      category: 'PERSON',
    });
    expect(event.changes).toContainEqual({
      field: 'email',
      before: 'z•••@test.local',
      after: null,
    });
    expect(event.changes).toContainEqual({
      field: 'phone',
      before: '•••• 0001',
      after: null,
    });
    expect(JSON.stringify(event)).not.toMatch(/zeca@test\.local|99009000|"x"/);
  }, 60_000);
});

describe('exclusão sem histórico: trilha que lança (aceite 6)', () => {
  it('trilha que lança desfaz a exclusão e o que ela gravou no mesmo tx (GC1)', async () => {
    const person = await prisma.user.create({ data: personData('Fica') });

    await expect(
      repo.deleteWithLastAdminGuard(person.id, (tx) =>
        failingTrail(tx, 'ProbeDelete'),
      ),
    ).rejects.toThrow('falhou');

    await expect(prisma.user.count({ where: { id: person.id } })).resolves.toBe(
      1,
    );
    await expect(
      prisma.auditEvent.count({ where: { entity: 'ProbeDelete' } }),
    ).resolves.toBe(0);
  }, 60_000);
});

describe('dar acesso com trilha (aceite 8)', () => {
  it('pelo serviço: o acesso e o evento user.access_granted ficam juntos, sem senha nem e-mail cru', async () => {
    const sector = await prisma.sector.create({
      data: { name: 'Setor do acesso', code: 'SAC' },
    });
    const person = await prisma.user.create({
      data: { ...personData('Sem acesso ainda'), sectorId: sector.id },
    });

    const granted = await users.grantAccess('admin-x', person.id, {
      email: 'novo@test.local',
      role: 'SUPERVISOR',
    });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'user.access_granted', subjectUserId: person.id },
    });
    expect(event).toMatchObject({ actorId: 'admin-x', category: 'PERSON' });
    expect(event.changes).toEqual([
      { field: 'email', before: null, after: 'n•••@test.local' },
      { field: 'role', before: 'VIEWER', after: 'SUPERVISOR' },
      { field: 'hasAccess', before: false, after: true },
    ]);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: person.id },
    });
    expect(stored).toMatchObject({ hasAccess: true, role: 'SUPERVISOR' });
    const written = JSON.stringify(event);
    expect(written).not.toContain('novo@test.local');
    expect(written).not.toContain(granted.temporaryPassword);
    expect(written).not.toContain(stored.password ?? 'sem-senha');
  }, 60_000);
});

describe('dar acesso com trilha que lança (aceite 8)', () => {
  it('trilha que lança deixa a pessoa sem acesso e sem o que ela gravou (GC1)', async () => {
    const person = await prisma.user.create({
      data: personData('Continua sem acesso'),
    });
    const credential = {
      email: 'falha@test.local',
      role: 'VIEWER' as const,
      password: 'x',
      mustChangePassword: true as const,
      hasAccess: true as const,
    };

    await expect(
      repo.grantAccess(person.id, credential, (tx) =>
        failingTrail(tx, 'ProbeGrant'),
      ),
    ).rejects.toThrow('falhou');

    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: person.id } }),
    ).resolves.toMatchObject({ hasAccess: false, email: null, password: null });
    await expect(
      prisma.auditEvent.count({ where: { entity: 'ProbeGrant' } }),
    ).resolves.toBe(0);
  }, 60_000);
});

describe('updateWithLastAdminGuard + trilha (aceite 8)', () => {
  it('trilha que lança desfaz nome e telefone e o que ela gravou no mesmo tx (GC1)', async () => {
    const person = await seedPerson('Nome antigo', '+5592990010001');

    const failing = repo.updateWithLastAdminGuard(
      person.id,
      { name: 'Nome novo', phoneE164: '+5592990010002' },
      (tx) =>
        probe(tx, 'ProbeEdit').then(() => Promise.reject(new Error('falhou'))),
    );

    await expect(failing).rejects.toThrow('falhou');
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: person.id } }),
    ).resolves.toMatchObject({
      name: 'Nome antigo',
      phoneE164: '+5592990010001',
    });
    await expect(
      prisma.auditEvent.count({ where: { entity: 'ProbeEdit' } }),
    ).resolves.toBe(0);
  }, 60_000);

  it('a trilha recebe o antes e o depois lidos no tx, e a edição fica', async () => {
    const person = await seedPerson('Antes', '+5592990020001');
    const seen: unknown[] = [];

    const result = await repo.updateWithLastAdminGuard(
      person.id,
      { name: 'Depois' },
      (_tx, before, after) => {
        seen.push(before.name, after.name);
        return Promise.resolve();
      },
    );

    expect(seen).toEqual(['Antes', 'Depois']);
    expect(result).toMatchObject({ updated: { name: 'Depois' } });
    expect(result).not.toHaveProperty('updated.password');
  }, 60_000);
});

describe('updateWithLastAdminGuard + trilha: conflito de serialização (aceite 8)', () => {
  it('conflito de serialização: a nova tentativa refaz a trilha sem duplicar evento', async () => {
    const person = await seedPerson('Retry', '+5592990030001');
    let attempts = 0;

    await repo.updateWithLastAdminGuard(
      person.id,
      { name: 'Retry 2' },
      async (tx) => {
        attempts += 1;
        await probe(tx, 'ProbeRetry');
        if (attempts === 1) throw serialization();
      },
    );

    expect(attempts).toBe(2);
    await expect(
      prisma.auditEvent.count({ where: { entity: 'ProbeRetry' } }),
    ).resolves.toBe(1);
  }, 60_000);
});

describe('envio anterior não muda com a edição (aceite 1)', () => {
  it('trocar telefone e situação não altera a linha do destinatário antigo', async () => {
    const person = await seedPerson('Maria do envio', '+5592990040001');
    const dispatch = await prisma.teamWhatsappDispatch.create({
      data: {
        targetType: 'SECTOR',
        targetId: 's-1',
        targetLabel: 'Produção',
        text: 'oi',
      },
    });
    const old = { userName: 'Maria do envio', status: 'SENT' as const };
    const recipient = await prisma.teamWhatsappRecipient.create({
      data: { dispatchId: dispatch.id, userId: person.id, ...old },
    });

    await repo.updateWithLastAdminGuard(person.id, {
      phoneE164: '+5592990040002',
      isActive: false,
    });

    await expect(
      prisma.teamWhatsappRecipient.findUniqueOrThrow({
        where: { id: recipient.id },
        select: { userName: true, status: true, skipReason: true },
      }),
    ).resolves.toEqual({ ...old, skipReason: null });
  }, 60_000);
});

describe('createWithAudit (aceite 8)', () => {
  it('trilha que lança desfaz a pessoa e o que a trilha gravou no mesmo tx (GC1)', async () => {
    const failing = repo.createWithAudit(personData('Sem rastro'), (tx) =>
      tx.auditEvent
        .create({ data: { action: 'user.person_created', entity: 'Probe' } })
        .then(() => Promise.reject(new Error('trilha falhou'))),
    );

    await expect(failing).rejects.toThrow('trilha falhou');
    await expect(
      prisma.user.count({ where: { name: 'Sem rastro' } }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditEvent.count({ where: { entity: 'Probe' } }),
    ).resolves.toBe(0);
  }, 60_000);

  it('a trilha recebe o retrato lido no tx e o id; a pessoa sai no formato público', async () => {
    const seen: unknown[] = [];

    const created = await repo.createWithAudit(
      personData('Com rastro', 'Rastro-1'),
      (_tx, row, id) => {
        seen.push(row, id);
        return Promise.resolve();
      },
    );

    expect(seen).toEqual([
      expect.objectContaining({
        name: 'Com rastro',
        registration: 'Rastro-1',
        contactAuthorization: 'NAO_AUTORIZADO',
        hasAccess: false,
      }),
      created.id,
    ]);
    expect(created).toMatchObject({
      registration: 'Rastro-1',
      hasAccess: false,
    });
    expect(created).not.toHaveProperty('password');
    await expect(repo.findIdByRegistrationKey('rastro-1')).resolves.toBe(
      created.id,
    );
    await expect(repo.findIdByRegistrationKey('rastro-0')).resolves.toBeNull();
  }, 60_000);
});

describe('createWithAudit (aceite 7)', () => {
  const noTrail = () => Promise.resolve();
  const create = (name: string, registration: string) =>
    repo
      .createWithAudit(personData(name, registration), noTrail)
      .catch(rethrowRegistrationConflict);
  const taken = { status: 422, code: 'user.registration_taken' };

  it('matrícula repetida sem diferenciar maiúsculas: P2002 vira 422 user.registration_taken', async () => {
    await create('Dona', 'Dup-1');

    await expect(create('Outra', 'DUP-1')).rejects.toMatchObject(taken);

    await expect(
      prisma.user.count({ where: { registrationKey: 'dup-1' } }),
    ).resolves.toBe(1);
  }, 60_000);

  it('corrida: duas criações da mesma matrícula, só uma fica e a outra vira 422', async () => {
    const racing = await Promise.allSettled([
      create('Corrida A', 'Corrida-1'),
      create('Corrida B', 'CORRIDA-1'),
    ]);

    expect(racing.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(racing.find((r) => r.status === 'rejected')).toMatchObject({
      reason: taken,
    });
    await expect(
      prisma.user.count({ where: { registrationKey: 'corrida-1' } }),
    ).resolves.toBe(1);
  }, 60_000);
});

describe('UsersRepository last active admin guard (real Postgres)', () => {
  it('allows only one of two concurrent deactivations of the last active admins', async () => {
    const [first, second] = await Promise.all([
      prisma.user.create({
        data: { email: 'admin-one@test.local', password: 'x', role: 'ADMIN' },
      }),
      prisma.user.create({
        data: { email: 'admin-two@test.local', password: 'x', role: 'ADMIN' },
      }),
    ]);
    const results = await Promise.all([
      repo.updateWithLastAdminGuard(first.id, { isActive: false }),
      repo.updateWithLastAdminGuard(second.id, { isActive: false }),
    ]);
    expect(results.filter((result) => 'updated' in result)).toHaveLength(1);
    expect(results.filter((result) => 'lastAdmin' in result)).toHaveLength(1);
    await expect(
      prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
    ).resolves.toBe(1);
  }, 60_000);

  it('does not count an inactive admin as the active-admin floor', async () => {
    const active = await prisma.user.create({
      data: { email: 'active@test.local', password: 'x', role: 'ADMIN' },
    });
    const inactive = await prisma.user.create({
      data: {
        email: 'inactive@test.local',
        password: 'x',
        role: 'ADMIN',
        isActive: false,
      },
    });
    await expect(
      repo.deleteWithLastAdminGuard(inactive.id, noTrail),
    ).resolves.toMatchObject({ deleted: { email: 'inactive@test.local' } });
    await expect(
      prisma.user.findUnique({ where: { id: active.id } }),
    ).resolves.not.toBeNull();
  }, 60_000);
});

describe('UsersRepository phone + contact link (real Postgres)', () => {
  it('acha o titular por qualquer grafia e o FK SetNull desliga ao apagar o contato', async () => {
    const contact = await prisma.contact.create({
      data: { phoneE164: '+559291234567' },
    });
    const user = await prisma.user.create({
      data: {
        email: 'phone@test.local',
        password: 'x',
        phoneE164: '+5592991234567',
        contactId: contact.id,
      },
    });
    await expect(
      repo.findIdByPhoneVariants(['+5592991234567', '+559291234567']),
    ).resolves.toBe(user.id);
    await expect(repo.findContactId(user.id)).resolves.toBe(contact.id);

    await prisma.contact.delete({ where: { id: contact.id } });

    await expect(
      prisma.user.findUnique({ where: { id: user.id } }),
    ).resolves.toMatchObject({ contactId: null, phoneE164: '+5592991234567' });
  }, 60_000);
});

describe('UsersRepository turno (real Postgres)', () => {
  it('shiftId grava, lê e limpa', async () => {
    const [withShift, withoutShift] = await Promise.all([
      prisma.user.create({
        data: {
          email: 'shift-1@test.local',
          password: 'x',
          shiftId: 'shift_first',
        },
      }),
      prisma.user.create({
        data: { email: 'shift-none@test.local', password: 'x' },
      }),
    ]);
    await expect(repo.findById(withShift.id)).resolves.toMatchObject({
      shiftId: 'shift_first',
    });
    await expect(repo.findById(withoutShift.id)).resolves.toMatchObject({
      shiftId: null,
    });
    await expect(repo.findShiftForAssignment('shift_first')).resolves.toEqual({
      id: 'shift_first',
      isActive: true,
    });
    await expect(repo.findShiftForAssignment('shift_nope')).resolves.toBeNull();

    await changeAssignment(withShift.id, { shiftId: null });

    await expect(repo.findById(withShift.id)).resolves.toMatchObject({
      shiftId: null,
    });
  }, 60_000);
});

describe('UsersRepository função (real Postgres)', () => {
  it('jobTitle grava, lê e limpa', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'job-title@test.local',
        password: 'x',
        jobTitle: 'Operador de empilhadeira',
      },
    });
    await expect(repo.findById(user.id)).resolves.toMatchObject({
      jobTitle: 'Operador de empilhadeira',
    });

    await repo.updateWithLastAdminGuard(user.id, { jobTitle: null });

    await expect(repo.findById(user.id)).resolves.toMatchObject({
      jobTitle: null,
    });
  }, 60_000);
});

const FAKE_HASH = 'argon2id-fake';

// Pessoa sem acesso como o UsersService grava (D1): o CHECK User_access_consistent aceita.
const createPerson = (name: string, levelId?: string) =>
  repo.createWithAudit(
    personData(name),
    async () => {},
    assignment(levelId ? { levelId } : {}),
  );

describe('UsersRepository pessoas sem acesso e nível (real Postgres)', () => {
  it('listagem traz quem não tem acesso com email null e level { id, name, isActive }', async () => {
    const created = await createPerson(
      'Sem acesso com nível',
      'level_employee',
    );
    const level = { id: 'level_employee', name: 'Funcionário', isActive: true };
    expect(created).toMatchObject({ email: null, hasAccess: false, level });

    const { data } = await repo.findMany(1, 100);

    expect(data.find((u) => u.id === created.id)).toMatchObject({
      email: null,
      hasAccess: false,
      levelId: 'level_employee',
      level,
    });
    await expect(
      repo.findLevelForAssignment('level_employee'),
    ).resolves.toEqual({ id: 'level_employee', isActive: true });
    await expect(repo.findLevelForAssignment('level_nope')).resolves.toBeNull();
  }, 60_000);

  it('hasAccess=true exclui quem não tem acesso; sem o filtro lista todos', async () => {
    await createPerson('Sem acesso para o filtro');
    await prisma.user.create({
      data: { email: 'with-access@test.local', password: 'x' },
    });
    const [all, withAccess] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { hasAccess: true } }),
    ]);

    const filtered = await repo.findMany(1, 100, { hasAccess: true });
    const unfiltered = await repo.findMany(1, 100);

    expect(filtered.data.every((u) => u.hasAccess)).toBe(true);
    expect(filtered.total).toBe(withAccess);
    expect(unfiltered.total).toBe(all);
    expect(unfiltered.data.some((u) => !u.hasAccess)).toBe(true);
  }, 60_000);
});

describe('UsersRepository dar acesso (real Postgres)', () => {
  const credential = (email: string) => ({
    email,
    role: 'OPERATOR' as const,
    password: FAKE_HASH,
    mustChangePassword: true as const,
    hasAccess: true as const,
  });

  it('um único update grava a credencial; corrida dá acesso uma vez; e-mail de outro → P2002', async () => {
    const person = await createPerson('Vai ter acesso');

    const results = await Promise.all([
      repo.grantAccess(person.id, credential('granted@test.local'), noTrail),
      repo.grantAccess(person.id, credential('granted-2@test.local'), noTrail),
    ]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: person.id },
    });
    expect(row).toMatchObject({
      hasAccess: true,
      role: 'OPERATOR',
      password: FAKE_HASH,
      mustChangePassword: true,
    });
    const other = await createPerson('Outra pessoa');
    await expect(
      repo.grantAccess(other.id, credential(row.email ?? ''), noTrail),
    ).rejects.toMatchObject({ code: 'P2002' });
  }, 60_000);
});
