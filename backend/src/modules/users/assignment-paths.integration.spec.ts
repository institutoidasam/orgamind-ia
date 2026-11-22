import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
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
import type { AuditRef, FieldChange } from '../../shared/audit/audit-change';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { ContactsRepository } from '../contacts/contacts.repository';
import type { ContactsService } from '../contacts/contacts.service';
import type { LevelsRepository } from '../levels/levels.repository';
import { SectorPeopleRepository } from '../sector-people/sector-people.repository';
import { SectorPeopleService } from '../sector-people/sector-people.service';
import { SectorPeopleWriteService } from '../sector-people/sector-people-write.service';
import type { ShiftsRepository } from '../shifts/shifts.repository';
import { fromDbDate } from '../staff-schedule/civil-date';
import { UserPhoneService } from './user-phone.service';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

// Prova do aceite 20 (DV15a): os cinco caminhos que mexem no vínculo, pelo
// serviço real e sob relógio fixo, conferem histórico, espelho e trilha.
// Dois dias em Manaus (UTC-4): a criação num, a troca no seguinte.
const FIRST_DAY = { at: new Date('2026-11-18T15:00:00Z'), date: '2026-11-18' };
const SECOND_DAY = { at: new Date('2026-11-19T15:00:00Z'), date: '2026-11-19' };
const LEVEL_EMPLOYEE = 'level_employee';
const LEVEL_LEADER = 'level_leader';
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

type Values = {
  sectorId: string | null;
  shiftId: string | null;
  levelId: string | null;
};
type Line = Values & { from: string | null; to: string | null };
type Moves = Record<string, readonly unknown[] | undefined>;

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let users: UsersService;
let sectorPeople: SectorPeopleWriteService;
const ids = { admin: '', operation: '', hr: '', night: '', morning: '' };
// Nome de cada setor, turno e nível: a trilha guarda `{ id, name }`.
const names = new Map<string, string>([
  [LEVEL_EMPLOYEE, 'Funcionário'],
  [LEVEL_LEADER, 'Líder'],
]);
let sequence = 0;

const ref = (id: string): AuditRef => ({ id, name: names.get(id) ?? '' });
const start = () => ({
  sectorId: ids.operation,
  shiftId: ids.night,
  levelId: LEVEL_EMPLOYEE,
});
const born = (): Moves => ({
  sector: [null, ref(ids.operation)],
  shift: [null, ref(ids.night)],
  level: [null, ref(LEVEL_EMPLOYEE)],
});

function nextPhone(): string {
  sequence += 1;
  return `9299111${String(sequence).padStart(4, '0')}`;
}

function buildServices(): void {
  const db = prisma as never;
  const audit = new AuditService(new AuditRepository(db), {
    get: () => undefined,
  } as never);
  const repo = new SectorPeopleRepository(db);
  const usersRepo = new UsersRepository(db);
  // Só o que o UserPhoneService usa dos contatos, sobre o banco do teste.
  const contacts = {
    create: (data: { phone: string; name: string }) =>
      prisma.contact.create({
        data: { name: data.name, phoneE164: data.phone },
      }),
    update: (id: string, data: { name: string }) =>
      prisma.contact.update({ where: { id }, data }),
  } as unknown as ContactsService;
  users = new UsersService(
    usersRepo,
    audit,
    { revokeAllForUser: vi.fn() } as unknown as RefreshService,
    new UserPhoneService(usersRepo, contacts, new ContactsRepository(db)),
  );
  const people = new SectorPeopleService(
    repo,
    {} as LevelsRepository,
    {} as ShiftsRepository,
  );
  sectorPeople = new SectorPeopleWriteService(people, repo, users, audit);
}

/** Guarda o nome do setor ou do turno para a trilha e devolve o id. */
function named(id: string, name: string): string {
  names.set(id, name);
  return id;
}

/** Banco real (testcontainers) com migrações, ADMIN, dois setores e dois turnos. */
async function startDatabase(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const admin = { name: 'Adm', email: 'adm@test.local', password: 'x' };
  ids.admin = (
    await prisma.user.create({ data: { ...admin, role: 'ADMIN' } })
  ).id;
  const sector = (name: string, code: string) =>
    prisma.sector.create({ data: { name, code } });
  const shift = (name: string, startTime: string, sortOrder: number) =>
    prisma.shift.create({
      data: { name, startTime, endTime: '07:00', sortOrder },
    });
  ids.operation = named((await sector('Operação', 'OPE')).id, 'Operação');
  ids.hr = named((await sector('RH', 'RH')).id, 'RH');
  ids.night = named((await shift('Noite', '19:00', 98)).id, 'Noite');
  ids.morning = named((await shift('Manhã', '07:00', 99)).id, 'Manhã');
  buildServices();
}

// Sem TESTCONTAINERS_ENABLED=1 os describes são pulados e o banco não sobe.
beforeAll(async () => {
  if (TESTCONTAINERS_ENABLED) await startDatabase();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

// Só o `Date` é falso: o relógio do serviço (hoje em Manaus) é o do teste.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Convite (POST /users com acesso): OPERATOR no setor, com turno e nível. */
async function inviteOperator(): Promise<string> {
  const phone = nextPhone();
  const { user } = await users.createUser(
    {
      email: `op${phone}@test.local`,
      name: `Operadora ${phone}`,
      role: 'OPERATOR',
      phone,
      ...start(),
    },
    ids.admin,
  );
  return user.id;
}

/** POST /users com hasAccess false: pessoa sem credencial, no setor. */
async function personWithoutAccess(): Promise<string> {
  const phone = nextPhone();
  const person = await users.createPersonWithoutAccess(ids.admin, {
    name: `Sem acesso ${phone}`,
    phone,
    ...start(),
  });
  return person.id;
}

/** Pessoa nova pela página do setor (sem acesso), no setor Operação. */
async function sectorPerson(): Promise<string> {
  const phone = nextPhone();
  const person = await sectorPeople.create(ids.admin, ids.operation, {
    name: `Do setor ${phone}`,
    phone,
    shiftId: ids.night,
    levelId: LEVEL_EMPLOYEE,
  });
  return person.id;
}

/** Contato já existente (como os da tela "Dos contatos"), ainda sem pessoa. */
async function contact(name: string): Promise<string> {
  const phoneE164 = `+55${nextPhone()}`;
  return (await prisma.contact.create({ data: { name, phoneE164 } })).id;
}

const closed = (values: Values, from: string, to: string): Line => ({
  ...values,
  from,
  to,
});

/** Histórico e espelho: uma linha aberta só, igual ao espelho, e as fechadas esperadas. */
async function expectTimeline(
  userId: string,
  current: Values,
  openFrom: string,
  closedLines: Line[] = [],
): Promise<void> {
  const mirror = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sectorId: true, shiftId: true, levelId: true },
  });
  const rows = await prisma.userAssignment.findMany({
    where: { userId },
    orderBy: { validFrom: 'asc' },
  });
  const lines = rows.map((row) => ({
    sectorId: row.sectorId,
    shiftId: row.shiftId,
    levelId: row.levelId,
    from: row.validFrom && fromDbDate(row.validFrom),
    to: row.validTo && fromDbDate(row.validTo),
  }));
  expect(lines.filter((line) => line.to === null)).toEqual([
    { ...current, from: openFrom, to: null },
  ]);
  expect(lines.filter((line) => line.to !== null)).toEqual(closedLines);
  expect(mirror).toEqual(current);
}

/** Antes e depois de setor, turno e nível de um evento da trilha (sem mudança = ausente). */
function moves(changes: FieldChange[]): Moves {
  const pair = (field: string) => {
    const change = changes.find((item) => item.field === field);
    return change && [change.before, change.after];
  };
  return { sector: pair('sector'), shift: pair('shift'), level: pair('level') };
}

/** Eventos da pessoa em ordem: ação, categoria e a mudança de vínculo de cada um. */
async function expectTrail(
  userId: string,
  expected: Array<[string, string, Moves]>,
): Promise<void> {
  const events = await prisma.auditEvent.findMany({
    where: { subjectUserId: userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { action: true, category: true, changes: true },
  });
  expect(
    events.map((event) => [
      event.action,
      event.category,
      moves((event.changes ?? []) as unknown as FieldChange[]),
    ]),
  ).toEqual(expected);
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'vínculo — convite e pessoa nova (banco real)',
  () => {
    it('convite (createUser) abre a linha com setor, turno e nível', async () => {
      vi.setSystemTime(FIRST_DAY.at);

      const id = await inviteOperator();

      await expectTimeline(id, start(), FIRST_DAY.date);
      await expectTrail(id, [['user.invited', 'PERSON', born()]]);
    });

    it('pessoa sem acesso (POST /users e pessoa nova no setor) abre a linha', async () => {
      vi.setSystemTime(FIRST_DAY.at);

      const people = [await personWithoutAccess(), await sectorPerson()];

      for (const id of people) {
        await expectTimeline(id, start(), FIRST_DAY.date);
        await expectTrail(id, [['user.person_created', 'PERSON', born()]]);
      }
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'vínculo — a partir de contatos (banco real)',
  () => {
    it('a partir de contatos abre uma linha por pessoa criada', async () => {
      vi.setSystemTime(FIRST_DAY.at);
      const contactIds = [await contact('Rita'), await contact('Sara')];

      const result = await sectorPeople.addFromContacts(
        ids.admin,
        ids.operation,
        { contactIds, shiftId: ids.night, levelId: LEVEL_EMPLOYEE },
      );

      expect(result.failed).toEqual([]);
      expect(result.created).toHaveLength(2);
      for (const { id } of result.created) {
        await expectTimeline(id, start(), FIRST_DAY.date);
        await expectTrail(id, [['user.person_created', 'PERSON', born()]]);
      }
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'vínculo — edição de turno e nível (banco real)',
  () => {
    it('edição (PATCH /users e PATCH do setor) de turno e nível, em dia depois da criação, fecha e abre', async () => {
      vi.setSystemTime(FIRST_DAY.at);
      const viaUsers = await inviteOperator();
      const viaSector = await sectorPerson();
      vi.setSystemTime(SECOND_DAY.at);
      const patch = { shiftId: ids.morning, levelId: LEVEL_LEADER };
      const reason = 'Troca de turno e de nível';

      await users.updateUser(viaUsers, patch, ids.admin, { reason });
      await sectorPeople.update(ids.admin, ids.operation, viaSector, {
        ...patch,
        reason,
      });

      const edited = {
        shift: [ref(ids.night), ref(ids.morning)],
        level: [ref(LEVEL_EMPLOYEE), ref(LEVEL_LEADER)],
      };
      const cases = [
        [viaUsers, 'user.invited'],
        [viaSector, 'user.person_created'],
      ];
      for (const [id, created] of cases) {
        const old = closed(start(), FIRST_DAY.date, FIRST_DAY.date);
        await expectTimeline(id, { ...start(), ...patch }, SECOND_DAY.date, [
          old,
        ]);
        await expectTrail(id, [
          [created, 'PERSON', born()],
          ['user.profile_updated', 'PERSON', edited],
        ]);
      }
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'vínculo — mover e tirar do setor (banco real)',
  () => {
    it('mover, em dia depois da criação, fecha no setor antigo e abre no novo; tirar do setor abre sem setor e mantém turno e nível', async () => {
      vi.setSystemTime(FIRST_DAY.at);
      const moved = await sectorPerson();
      const removed = await sectorPerson();
      vi.setSystemTime(SECOND_DAY.at);

      await sectorPeople.move(ids.admin, ids.hr, [moved], 'Reforço no RH');
      await sectorPeople.remove(ids.admin, ids.operation, removed, 'Saiu');

      const old = [closed(start(), FIRST_DAY.date, FIRST_DAY.date)];
      const inHr = { ...start(), sectorId: ids.hr };
      await expectTimeline(moved, inHr, SECOND_DAY.date, old);
      await expectTrail(moved, [
        ['user.person_created', 'PERSON', born()],
        [
          'sector_people.person_moved',
          'ASSIGNMENT',
          { sector: [ref(ids.operation), ref(ids.hr)] },
        ],
      ]);
      const noSector = { ...start(), sectorId: null };
      await expectTimeline(removed, noSector, SECOND_DAY.date, old);
      await expectTrail(removed, [
        ['user.person_created', 'PERSON', born()],
        [
          'sector_people.person_removed',
          'ASSIGNMENT',
          { sector: [ref(ids.operation), null] },
        ],
      ]);
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'vínculo — trocas no mesmo dia (banco real)',
  () => {
    it('criada e trocada no mesmo dia: uma linha só, atualizada', async () => {
      vi.setSystemTime(SECOND_DAY.at);
      const id = await inviteOperator();

      await users.updateUser(id, { shiftId: ids.morning }, ids.admin);

      await expectTimeline(
        id,
        { ...start(), shiftId: ids.morning },
        SECOND_DAY.date,
      );
      await expectTrail(id, [
        ['user.invited', 'PERSON', born()],
        [
          'user.profile_updated',
          'PERSON',
          { shift: [ref(ids.night), ref(ids.morning)] },
        ],
      ]);
    });

    it('duas trocas no mesmo dia: uma linha aberta e duas entradas na trilha', async () => {
      vi.setSystemTime(FIRST_DAY.at);
      const id = await inviteOperator();
      vi.setSystemTime(SECOND_DAY.at);

      await users.updateUser(id, { shiftId: ids.morning }, ids.admin);
      await users.updateUser(id, { shiftId: ids.night }, ids.admin);

      const old = closed(start(), FIRST_DAY.date, FIRST_DAY.date);
      await expectTimeline(id, start(), SECOND_DAY.date, [old]);
      await expectTrail(id, [
        ['user.invited', 'PERSON', born()],
        [
          'user.profile_updated',
          'PERSON',
          { shift: [ref(ids.night), ref(ids.morning)] },
        ],
        [
          'user.profile_updated',
          'PERSON',
          { shift: [ref(ids.morning), ref(ids.night)] },
        ],
      ]);
    });
  },
);
