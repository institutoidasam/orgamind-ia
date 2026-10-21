import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { fromDbDate, toDbDate } from './civil-date';
import { StaffScheduleRepository } from './staff-schedule.repository';

// Um container + todas as migrações para o arquivo inteiro. Turnos migrados:
// shift_first (1º turno) e shift_second (2º turno).
let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: StaffScheduleRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  deployMigrations({ databaseUrl: url });
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new StaffScheduleRepository(prisma as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

let seq = 0;
function createUser(data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  seq += 1;
  return prisma.user.create({
    data: { email: `u${seq}@test.local`, password: 'x', ...data },
  });
}
function createSector(name: string, isActive = true) {
  return prisma.sector.create({
    data: { name, code: name.slice(0, 6).toUpperCase(), isActive },
  });
}
type ExceptionSeed = {
  userId: string;
  kind: Prisma.StaffScheduleExceptionUncheckedCreateInput['kind'];
  from: string;
  to: string;
  sectorId?: string;
};
function createException(seed: ExceptionSeed) {
  return prisma.staffScheduleException.create({
    data: {
      userId: seed.userId,
      kind: seed.kind,
      startDate: toDbDate(seed.from),
      endDate: toDbDate(seed.to),
      shiftId: seed.kind === 'VACATION' ? null : 'shift_second',
      sectorId: seed.sectorId ?? null,
    },
  });
}

type UserSeed = Partial<Prisma.UserUncheckedCreateInput>;
type VisitorCase = [
  visitor: boolean,
  user: UserSeed,
  ex: Omit<ExceptionSeed, 'userId'>,
];

/** Um usuário com uma exceção por caso; devolve os ids que devem ser visitantes. */
async function seedVisitorCases() {
  const prod = await createSector('VisProd');
  const log = await createSector('VisLog');
  const other = await createSector('VisOutro');
  const visit = (from: string, to: string) => ({
    kind: 'OTHER_SECTOR' as const,
    sectorId: prod.id,
    from,
    to,
  });
  const day = '2026-10-20';
  const fromLog = { sectorId: log.id };
  const cases: VisitorCase[] = [
    [true, fromLog, visit('2026-10-15', '2026-10-19')], // cruza o início
    [true, {}, visit('2026-10-25', '2026-10-25')], // sem setor principal
    [false, fromLog, visit('2026-10-26', '2026-10-30')], // fora do período
    [false, fromLog, { ...visit(day, day), sectorId: other.id }],
    [false, fromLog, { kind: 'SHIFT_SWAP', from: day, to: day }],
    [false, { ...fromLog, isActive: false }, visit(day, day)],
    [false, { sectorId: prod.id }, visit(day, day)], // já é do setor
  ];
  const expected: string[] = [];
  for (const [visitor, user, ex] of cases) {
    const created = await createUser(user);
    await createException({ userId: created.id, ...ex });
    if (visitor) expected.push(created.id);
  }
  return { sectorId: prod.id, expected: expected.sort() };
}

describe('StaffScheduleRepository.listVisitorIds (Postgres real)', () => {
  it('listVisitorIds só traz OTHER_SECTOR para o setor e no período', async () => {
    const { sectorId, expected } = await seedVisitorCases();

    const ids = await repo.listVisitorIds(sectorId, '2026-10-19', '2026-10-25');

    expect([...ids].sort()).toEqual(expected);
  }, 60_000);
});

/** Ciclo CUSTOM de 3 dias gravado fora de ordem + exceções antes, no e depois do período. */
async function seedSchedule(userId: string) {
  await prisma.staffSchedule.create({
    data: {
      userId,
      template: 'CUSTOM',
      startDate: toDbDate('2026-10-19'),
      cycleLength: 3,
      days: {
        create: [
          { dayIndex: 2, shiftId: null },
          { dayIndex: 0, shiftId: 'shift_first' },
          { dayIndex: 1, shiftId: 'shift_second' },
        ],
      },
    },
  });
  const vacation = (from: string, to: string) =>
    createException({ userId, kind: 'VACATION', from, to });
  await vacation('2026-10-10', '2026-10-18');
  const crossing = await vacation('2026-10-15', '2026-10-19');
  await vacation('2026-10-26', '2026-10-27');
  return crossing.id;
}

describe('StaffScheduleRepository.loadScheduleData (Postgres real)', () => {
  it('loadScheduleData devolve ciclo ordenado por dayIndex e exceções que cruzam o período', async () => {
    const user = await createUser();
    const bare = await createUser();
    const crossingId = await seedSchedule(user.id);

    const data = await repo.loadScheduleData(
      [user.id, bare.id],
      '2026-10-19',
      '2026-10-25',
    );

    const cycle = {
      startDate: '2026-10-19',
      cycleLength: 3,
      days: ['shift_first', 'shift_second', null],
    };
    const exception = {
      id: crossingId,
      userId: user.id,
      kind: 'VACATION',
      startDate: '2026-10-15',
      endDate: '2026-10-19',
      shiftId: null,
      sectorId: null,
      note: null,
    };
    expect(data.get(user.id)).toEqual({
      cycle,
      schedule: { template: 'CUSTOM', ...cycle },
      exceptions: [exception],
    });
    const empty = { cycle: null, schedule: null, exceptions: [] };
    expect(data.get(bare.id)).toEqual(empty);
  }, 60_000);
});

describe('StaffScheduleRepository — consultas do quadro (Postgres real)', () => {
  it('pessoas ativas do setor, setores e turnos por id', async () => {
    const sector = await createSector('QdrProd');
    const old = await createSector('QdrOld', false);
    const person = { name: 'Ana', jobTitle: 'Líder', shiftId: 'shift_first' };
    const ana = await createUser({ sectorId: sector.id, ...person });
    await createUser({ sectorId: sector.id, isActive: false });
    await createUser({ sectorId: old.id });
    const row = {
      id: ana.id,
      email: ana.email,
      sectorId: sector.id,
      ...person,
    };

    await expect(repo.listSectorPeople(sector.id)).resolves.toEqual([row]);
    await expect(repo.listPeopleByIds([ana.id])).resolves.toEqual([row]);
    await expect(repo.listSectors([sector.id, old.id])).resolves.toEqual([
      { id: sector.id, name: 'QdrProd' },
    ]);
    await expect(repo.findSectorsByIds([old.id])).resolves.toEqual([
      { id: old.id, name: 'QdrOld' },
    ]);
    const second = { id: 'shift_second', name: '2º turno', isActive: true };
    await expect(repo.findShiftsByIds(['shift_second'])).resolves.toEqual([
      { ...second, startTime: '14:00', endTime: '22:00' },
    ]);
    const active = await repo.listActiveShifts();
    expect(active.map((s) => s.id).slice(0, 2)).toEqual([
      'shift_first',
      'shift_second',
    ]);
  }, 60_000);
});

type Span = { startDate: string; endDate: string };
/** Exceções da pessoa por início, com as datas como data civil. */
async function exceptionsOf(userId: string) {
  const rows = await prisma.staffScheduleException.findMany({
    where: { userId },
    orderBy: { startDate: 'asc' },
  });
  return rows.map((row) => ({
    ...row,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
  }));
}
const crosses = (a: Span, b: Span) =>
  a.startDate <= b.endDate && b.startDate <= a.endDate;

describe('StaffScheduleRepository.createExceptionTrimming (Postgres real)', () => {
  it('createExceptionTrimming divide a exceção anterior e devolve adjusted 1', async () => {
    const user = await createUser();
    const dest = await createSector('TrimDest');
    await prisma.staffScheduleException.create({
      data: {
        userId: user.id,
        kind: 'OTHER_SECTOR',
        startDate: toDbDate('2026-10-21'),
        endDate: toDbDate('2026-10-25'),
        shiftId: 'shift_second',
        sectorId: dest.id,
        note: 'Cobrir férias',
      },
    });
    const incoming = {
      kind: 'DAY_OFF' as const,
      startDate: '2026-10-23',
      endDate: '2026-10-23',
    };

    const result = await repo.createExceptionTrimming(
      user.id,
      incoming,
      user.id,
    );

    expect(result.adjusted).toBe(1);
    expect(result.exception).toMatchObject({
      ...incoming,
      shiftId: null,
      note: null,
    });
    const copied = {
      kind: 'OTHER_SECTOR',
      shiftId: 'shift_second',
      sectorId: dest.id,
      note: 'Cobrir férias',
    };
    const rows = await exceptionsOf(user.id);
    expect(rows).toMatchObject([
      { ...copied, startDate: '2026-10-21', endDate: '2026-10-22' },
      { id: result.exception.id, kind: 'DAY_OFF', sectorId: null },
      { ...copied, startDate: '2026-10-24', endDate: '2026-10-25' },
    ]);
  });
});

describe('StaffScheduleRepository.createExceptionTrimming — concorrência (Postgres real)', () => {
  it('duas criações concorrentes para a mesma pessoa terminam sem sobreposição', async () => {
    const user = await createUser();
    const spans: Span[] = [
      { startDate: '2026-11-01', endDate: '2026-11-10' },
      { startDate: '2026-11-05', endDate: '2026-11-15' },
      { startDate: '2026-11-03', endDate: '2026-11-07' },
      { startDate: '2026-11-08', endDate: '2026-11-20' },
    ];

    await Promise.all(
      spans.map((span) =>
        repo.createExceptionTrimming(
          user.id,
          { kind: 'VACATION', ...span },
          user.id,
        ),
      ),
    );

    const rows = await exceptionsOf(user.id);
    const pairs = rows.flatMap((a, i) =>
      rows.slice(i + 1).map((b) => [a, b] as const),
    );
    expect(pairs.filter(([a, b]) => crosses(a, b))).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('StaffScheduleRepository.replaceSchedule (Postgres real)', () => {
  it('replaceSchedule troca os dias inteiros', async () => {
    const user = await createUser();
    const first = {
      template: 'CUSTOM' as const,
      startDate: '2026-10-19',
      cycleLength: 3,
      days: ['shift_first', null, 'shift_second'],
    };
    const second = {
      template: 'TWELVE_36' as const,
      startDate: '2026-10-20',
      cycleLength: 2,
      days: ['shift_second', null],
    };

    await repo.replaceSchedule(user.id, first, user.id);
    const saved = await repo.replaceSchedule(user.id, second, user.id);

    expect(saved).toEqual(second);
    const row = await prisma.staffSchedule.findUniqueOrThrow({
      where: { userId: user.id },
      include: { days: { orderBy: { dayIndex: 'asc' } } },
    });
    expect(row.days.map((d) => [d.dayIndex, d.shiftId])).toEqual([
      [0, 'shift_second'],
      [1, null],
    ]);
    expect(row.updatedById).toBe(user.id);
  });
});

/** Pessoa num setor inativo, com uma exceção OTHER_SECTOR e um ciclo de um dia. */
async function seedEditCase(sectorName: string) {
  const sector = await createSector(sectorName, false);
  const user = await createUser({ sectorId: sector.id });
  const ex = await createException({
    userId: user.id,
    kind: 'OTHER_SECTOR',
    from: '2026-10-21',
    to: '2026-10-21',
    sectorId: sector.id,
  });
  const cycle = {
    template: 'WEEKLY' as const,
    startDate: '2026-10-19',
    cycleLength: 1,
    days: [null],
  };
  await repo.replaceSchedule(user.id, cycle, user.id);
  return { sector, user, ex };
}

describe('StaffScheduleRepository — consultas da edição (Postgres real)', () => {
  it('pessoa, turnos ativos, setor e exceção por id', async () => {
    const { sector, user, ex } = await seedEditCase('EdtA');
    await prisma.shift.create({
      data: {
        id: 'shift_off',
        name: 'Desativado',
        startTime: '01:00',
        endTime: '02:00',
        isActive: false,
        sortOrder: 99,
      },
    });

    const person = { id: user.id, sectorId: sector.id };
    expect(await repo.findPerson(user.id)).toEqual(person);
    expect(await repo.findPerson('ghost')).toBeNull();
    const shifts = ['shift_first', 'shift_off', 'ghost'];
    expect(await repo.findShiftsActive(shifts)).toEqual(['shift_first']);
    const inactive = { id: sector.id, isActive: false };
    expect(await repo.findSector(sector.id)).toEqual(inactive);
    const owner = { id: ex.id, userId: user.id, sectorId: sector.id };
    expect(await repo.findException(ex.id)).toEqual(owner);
  });

  it('deleteException e deleteSchedule são idempotentes', async () => {
    const { user, ex } = await seedEditCase('EdtB');

    await repo.deleteException(ex.id);
    await repo.deleteException(ex.id);
    await repo.deleteSchedule(user.id);
    await repo.deleteSchedule(user.id);

    expect(await repo.findException(ex.id)).toBeNull();
    const where = { userId: user.id };
    expect(await prisma.staffSchedule.count({ where })).toBe(0);
  });
});
