import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { PermissionKey } from '../../shared/authz/permissions';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { ContactsRepository } from '../contacts/contacts.repository';
import type { ContactsService } from '../contacts/contacts.service';
import { ContactPhoneConflictError } from '../contacts/errors/contacts.errors';
import { fromDbDate } from '../staff-schedule/civil-date';
import { normalizeRegistration } from '../users/person-record';
import { UserPhoneService } from '../users/user-phone.service';
import { UsersRepository } from '../users/users.repository';
import {
  type PersonWithoutAccessInput,
  UsersService,
} from '../users/users.service';
import { type ImportActor, toImportActor } from './import-actor';
import type {
  CreatePlan,
  ImportPatch,
  ImportPerson,
  RowOutcome,
  RowPlan,
} from './import-person';
import { PeopleImportRepository } from './people-import.repository';
import { personFingerprint } from './person-diff';
import { ROW_TEXT } from './row-texts';
import { RowWriter } from './row-writer';
import type { StructureCatalog } from './structure-match';

// Gravação de uma linha sobre o cadastro real (GX3), sob relógio fixo em
// Manaus (UTC-4): a pessoa existente nasce ontem; a linha grava hoje.
const YESTERDAY = new Date('2026-11-18T15:00:00Z');
const NOW = new Date('2026-11-19T15:00:00Z');
const TODAY = '2026-11-19';
const REASON = 'Importação de planilha: equipe.xlsx';
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let users: UsersService;
let people: PeopleImportRepository;
let writer: RowWriter;
let catalog: StructureCatalog;
const ids = { admin: '', manager: '', operation: '', hr: '', night: '' };
let sequence = 0;

function nextPhone(): string {
  sequence += 1;
  return `+5592991${String(sequence).padStart(6, '0')}`;
}

/** Contatos sobre o banco do teste; a corrida no telefone vira o erro do serviço real. */
function contactsOnDb(): ContactsService {
  return {
    create: async (data: { phone: string; name: string }) => {
      try {
        return await prisma.contact.create({
          data: { name: data.name, phoneE164: data.phone },
        });
      } catch (error) {
        const race =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        throw race ? new ContactPhoneConflictError(data.phone) : error;
      }
    },
    update: (id: string, data: { name: string }) =>
      prisma.contact.update({ where: { id }, data }),
  } as unknown as ContactsService;
}

function buildServices(): void {
  const db = prisma as never;
  const audit = new AuditService(new AuditRepository(db), {
    get: () => undefined,
  } as never);
  const usersRepo = new UsersRepository(db);
  users = new UsersService(
    usersRepo,
    audit,
    { revokeAllForUser: vi.fn() } as unknown as RefreshService,
    new UserPhoneService(usersRepo, contactsOnDb(), new ContactsRepository(db)),
  );
  people = new PeopleImportRepository(db);
  writer = new RowWriter(people, users);
}

/** Banco real com migrações, ADMIN, um gestor de Operação, dois setores e um turno. */
async function startDatabase(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const user = (role: 'ADMIN' | 'SUPERVISOR', email: string) =>
    prisma.user.create({ data: { name: role, email, password: 'x', role } });
  ids.admin = (await user('ADMIN', 'adm@test.local')).id;
  ids.manager = (await user('SUPERVISOR', 'gestor@test.local')).id;
  const sector = (name: string, code: string) =>
    prisma.sector.create({ data: { name, code } });
  ids.operation = (await sector('Operação', 'OPE')).id;
  ids.hr = (await sector('RH', 'RH')).id;
  ids.night = (
    await prisma.shift.create({
      data: {
        name: 'Noite',
        startTime: '19:00',
        endTime: '07:00',
        sortOrder: 98,
      },
    })
  ).id;
  buildServices();
  catalog = await people.loadCatalog();
}

// Sem TESTCONTAINERS_ENABLED=1 os describes são pulados e o banco não sobe.
beforeAll(async () => {
  if (TESTCONTAINERS_ENABLED) await startDatabase();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const admin = (): ImportActor =>
  toImportActor({
    ...actorWith('ADMIN', { id: ids.admin }),
    managedSectorIds: [],
  });

/** Gestor de Operação; `revoke` tira permissões do padrão do papel. */
const manager = (revoke: PermissionKey[] = []): ImportActor =>
  toImportActor({
    ...actorWith('SUPERVISOR', { id: ids.manager, revoke }),
    managedSectorIds: [ids.operation],
  });

const noKey = () => manager(['telefone.ver_completo']);

/** Pessoa sem acesso pelo cadastro manual, nascida ontem em Operação. */
async function existing(
  change: Partial<PersonWithoutAccessInput> = {},
): Promise<{ id: string; phone: string }> {
  vi.setSystemTime(YESTERDAY);
  const phone = change.phone ?? nextPhone();
  const input = { name: `Pessoa ${sequence}`, sectorId: ids.operation };
  const created = await users.createPersonWithoutAccess(ids.admin, {
    ...input,
    ...change,
    phone,
  });
  vi.setSystemTime(NOW);
  return { id: created.id, phone };
}

/** Pessoa sem telefone (cadastro antigo), achável só pela matrícula. */
async function withoutPhone(registration: string): Promise<string> {
  const record = normalizeRegistration(registration);
  const data = { name: `Sem telefone ${registration}`, hasAccess: false };
  const user = await prisma.user.create({
    data: { ...data, ...record, sectorId: ids.operation },
  });
  return user.id;
}

async function snapshot(id: string): Promise<ImportPerson> {
  const [found] = await people.findPeopleByKeys({
    ids: [id],
    registrationKeys: [],
    phones: [],
  });
  return found;
}

/** Atualização como a prévia a monta: chave da linha e versão de agora. */
async function updatePlan(id: string, patch: ImportPatch): Promise<RowPlan> {
  const person = await snapshot(id);
  return {
    kind: 'update',
    keys: { registrationKey: person.registrationKey, phoneE164: null },
    personId: id,
    fingerprint: personFingerprint(person),
    patch,
  };
}

function createPlan(input: CreatePlan): RowPlan {
  const { registrationKey } = normalizeRegistration(input.registration);
  return {
    kind: 'create',
    keys: { registrationKey, phoneE164: input.phone },
    input,
  };
}

function write(
  plan: RowPlan,
  actor: ImportActor,
  personId: string | null,
): Promise<RowOutcome> {
  return writer.write({ plan, personId, actor, reason: REASON, catalog });
}

const events = (id: string) =>
  prisma.auditEvent.findMany({
    where: { subjectUserId: id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const lines = (id: string) =>
  prisma.userAssignment.findMany({
    where: { userId: id },
    orderBy: { validFrom: 'asc' },
  });
const civil = (date: Date | null) => (date === null ? null : fromDbDate(date));
const phoneTaken = { outcome: 'FAILED', reason: ROW_TEXT.phoneTaken };

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RowWriter — criação (Postgres)',
  () => {
    it('cria pessoa sem acesso com o motivo, o vínculo com início hoje e o id da linha', async () => {
      const personId = `c${randomUUID().replaceAll('-', '')}`;
      const phone = nextPhone();
      const plan = createPlan({
        name: 'Bruno Lima',
        phone,
        sectorId: ids.operation,
        shiftId: ids.night,
        registration: 'MAT-10',
      });
      await expect(write(plan, manager(), personId)).resolves.toEqual({
        outcome: 'CREATED',
        reason: null,
        personId,
      });
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: personId },
      });
      expect(user).toMatchObject({
        phoneE164: phone,
        hasAccess: false,
        sectorId: ids.operation,
        registration: 'MAT-10',
        createdById: ids.manager,
      });
      expect(await events(personId)).toContainEqual(
        expect.objectContaining({
          action: 'user.person_created',
          reason: REASON,
        }),
      );
      const [line, ...more] = await lines(personId);
      expect(more).toEqual([]);
      expect(line).toMatchObject({
        sectorId: ids.operation,
        shiftId: ids.night,
      });
      expect(civil(line.validFrom)).toBe(TODAY);
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RowWriter — atualização (Postgres)',
  () => {
    it('atualiza pela matrícula com o motivo na trilha e linha de vínculo nova', async () => {
      const { id } = await existing({ registration: 'MAT-20' });
      const plan = await updatePlan(id, {
        sectorId: ids.hr,
        jobTitle: 'Analista',
      });
      await expect(write(plan, admin(), id)).resolves.toEqual({
        outcome: 'UPDATED',
        reason: null,
        personId: id,
      });
      expect(await events(id)).toContainEqual(
        expect.objectContaining({ reason: REASON, actorId: ids.admin }),
      );
      const history = await lines(id);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({ sectorId: ids.hr });
      expect(civil(history[1].validFrom)).toBe(TODAY);
    });

    it('aceite 20: pessoa alterada depois da prévia falha; as outras linhas entram', async () => {
      const first = await existing({ registration: 'MAT-21' });
      const second = await existing({ registration: 'MAT-22' });
      const patch = { jobTitle: 'Analista' };
      const plans = [
        await updatePlan(first.id, patch),
        await updatePlan(second.id, patch),
      ];
      await users.updateUser(first.id, { name: 'Outro Nome' }, ids.admin);
      const outcomes: RowOutcome[] = [];
      for (const plan of plans) outcomes.push(await write(plan, admin(), null));
      expect(outcomes).toEqual([
        {
          outcome: 'FAILED',
          reason: ROW_TEXT.changedAfterPreview,
          personId: null,
        },
        { outcome: 'UPDATED', reason: null, personId: second.id },
      ]);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(after.jobTitle).toBeNull();
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RowWriter — Sem alteração e autorização (Postgres)',
  () => {
    it('com a chave: criação de pessoa que já existe com os valores da linha dá Sem alteração, sem pessoa em dobro', async () => {
      const twin = await existing({ name: 'Carla Dias' });
      const plan = createPlan({
        name: 'Carla Dias',
        phone: twin.phone,
        sectorId: ids.operation,
      });
      const personId = `c${randomUUID().replaceAll('-', '')}`;
      await expect(write(plan, manager(), personId)).resolves.toEqual({
        outcome: 'UNCHANGED',
        reason: null,
        personId: twin.id,
      });
      expect(await prisma.user.count({ where: { id: personId } })).toBe(0);
      const owners = await prisma.user.count({
        where: { phoneE164: twin.phone },
      });
      expect(owners).toBe(1);
    });

    it('aceite 15: Sim com origem grava a autorização com a origem e a data de hoje', async () => {
      const { id } = await existing({ registration: 'MAT-23' });
      const plan = await updatePlan(id, {
        contactAuthorization: {
          status: 'AUTORIZADO',
          source: 'TERMO_ASSINADO',
        },
      });
      await expect(write(plan, manager(), id)).resolves.toMatchObject({
        outcome: 'UPDATED',
      });
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user).toMatchObject({
        contactAuthorization: 'AUTORIZADO',
        authorizationSource: 'TERMO_ASSINADO',
      });
      expect(civil(user.authorizationDate)).toBe(TODAY);
    });
  },
);

/** Os quatro donos do S1-5; cada um devolve o número como a linha o traz. */
const OWNERS: [string, () => Promise<string>][] = [
  ['sem login no alcance', async () => (await existing()).phone],
  [
    'com login',
    async () => {
      const phone = nextPhone();
      const invite = { email: `op${sequence}@test.local`, role: 'OPERATOR' };
      await users.createUser(
        {
          ...invite,
          name: 'Com login',
          phone,
          sectorId: ids.operation,
        } as never,
        ids.admin,
      );
      return phone;
    },
  ],
  ['fora do alcance', async () => (await existing({ sectorId: ids.hr })).phone],
  [
    'outra grafia do 9º dígito',
    async () => {
      const phone = nextPhone();
      // Cadastro antigo na forma de 8 dígitos; a linha traz a forma moderna.
      const legacy = phone.replace(/^\+55929/, '+5592');
      await prisma.user.create({
        data: { name: 'Grafia antiga', hasAccess: false, phoneE164: legacy },
      });
      return phone;
    },
  ],
];

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RowWriter — S1-5 telefone já cadastrado (Postgres)',
  () => {
    it.each(OWNERS)(
      'S1-5: sem telefone.ver_completo, número já cadastrado (%s) falha com phoneTaken',
      async (_owner, makeOwner) => {
        const phone = await makeOwner();
        const personId = `c${randomUUID().replaceAll('-', '')}`;
        const plan = createPlan({
          name: 'Nova Pessoa',
          phone,
          sectorId: ids.operation,
        });
        await expect(write(plan, noKey(), personId)).resolves.toEqual({
          ...phoneTaken,
          personId: null,
        });
        expect(await prisma.user.count({ where: { id: personId } })).toBe(0);
      },
    );
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RowWriter — S2 telefone vazio sem a chave (Postgres)',
  () => {
    it('S2-3: sem a chave, número livre preenche o telefone vazio, liga o Contato e grava o motivo na trilha da pessoa', async () => {
      const id = await withoutPhone('MAT-30');
      const phone = nextPhone();
      const plan = await updatePlan(id, { phone });
      await expect(write(plan, noKey(), id)).resolves.toEqual({
        outcome: 'UPDATED',
        reason: null,
        personId: id,
      });
      const user = await prisma.user.findUniqueOrThrow({
        where: { id },
        include: { contact: true },
      });
      expect(user.phoneE164).toBe(phone);
      expect(user.contact?.phoneE164).toBe(phone);
      expect(await events(id)).toContainEqual(
        expect.objectContaining({ reason: REASON, actorId: ids.manager }),
      );
    });

    it('S2-4: sem a chave, número ocupado: FAILED phoneTaken e nenhum campo da linha aplicado', async () => {
      const owner = await existing();
      const id = await withoutPhone('MAT-31');
      const before = await prisma.user.findUniqueOrThrow({ where: { id } });
      const plan = await updatePlan(id, {
        phone: owner.phone,
        jobTitle: 'Analista',
        shiftId: ids.night,
      });
      await expect(write(plan, noKey(), id)).resolves.toEqual({
        ...phoneTaken,
        personId: null,
      });
      const after = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(after).toEqual(before);
      expect(await events(id)).toEqual([]);
      expect(await lines(id)).toEqual([]);
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RowWriter — retomada e corrida da mesma linha (Postgres)',
  () => {
    it('retomada: pessoa criada pela linha e reserva vencida antes de registrar dá Sem alteração, sem a chave e sem matrícula', async () => {
      const phone = nextPhone();
      const plan = createPlan({
        name: 'Dora Reis',
        phone,
        sectorId: ids.operation,
      });
      const personId = `c${randomUUID().replaceAll('-', '')}`;
      const first = await write(plan, noKey(), personId);
      const again = await write(plan, noKey(), personId);
      expect([first.outcome, again]).toEqual([
        'CREATED',
        { outcome: 'UNCHANGED', reason: null, personId },
      ]);
      expect(await prisma.user.count({ where: { phoneE164: phone } })).toBe(1);
    });

    it('dois write concorrentes com a mesma personId (Promise.all): uma pessoa só, nenhuma linha FAILED', async () => {
      const phone = nextPhone();
      const plan = createPlan({
        name: 'Edu Rocha',
        phone,
        sectorId: ids.operation,
      });
      const personId = `c${randomUUID().replaceAll('-', '')}`;
      const outcomes = await Promise.all([
        write(plan, noKey(), personId),
        write(plan, noKey(), personId),
      ]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual([
        'CREATED',
        'UNCHANGED',
      ]);
      expect(outcomes.every((o) => o.personId === personId)).toBe(true);
      expect(await prisma.user.count({ where: { id: personId } })).toBe(1);
      expect(await prisma.user.count({ where: { phoneE164: phone } })).toBe(1);
    });
  },
);
