import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { toDbDate } from '../staff-schedule/civil-date';
import { ShiftsRepository } from './shifts.repository';

// "Hoje" chega por parâmetro (o serviço passa todayIn(new Date())).
const TODAY = '2026-10-21';
const YESTERDAY = '2026-10-20';

// shift_first: 2 pessoas no cadastro (uma inativa), 1 escala com 2 dias nele,
// 1 exceção que termina hoje. shift_second: só uma exceção encerrada ontem.
const PEOPLE = [
  { id: 'u-active', shiftId: 'shift_first', isActive: true },
  { id: 'u-inactive', shiftId: 'shift_first', isActive: false },
  { id: 'u-cycle', shiftId: null, isActive: true },
];

function swap(shiftId: string, startDate: string, endDate: string) {
  return {
    userId: 'u-cycle',
    kind: 'SHIFT_SWAP' as const,
    startDate: toDbDate(startDate),
    endDate: toDbDate(endDate),
    shiftId,
  };
}

async function seedUsage(db: PrismaClient): Promise<void> {
  await db.user.createMany({
    data: PEOPLE.map((p) => ({
      ...p,
      email: `${p.id}@test.local`,
      password: 'x',
    })),
  });
  await db.staffSchedule.create({
    data: {
      userId: 'u-cycle',
      template: 'CUSTOM',
      startDate: toDbDate('2026-10-01'),
      cycleLength: 3,
      days: {
        create: [
          { dayIndex: 0, shiftId: 'shift_first' },
          { dayIndex: 1, shiftId: 'shift_first' },
          { dayIndex: 2, shiftId: null },
        ],
      },
    },
  });
  await db.staffScheduleException.createMany({
    data: [
      swap('shift_first', TODAY, TODAY),
      swap('shift_second', '2026-10-19', YESTERDAY),
    ],
  });
}

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: ShiftsRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new ShiftsRepository(prisma as never);
  await seedUsage(prisma);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('ShiftsRepository.usage (Postgres exclusivo)', () => {
  it('usage conta pessoa com o turno no cadastro, escala com o turno e exceção de hoje em diante; exceção encerrada ontem não conta', async () => {
    const usage = await repo.usage(['shift_first', 'shift_second'], TODAY);

    expect(usage.get('shift_first')).toEqual([
      { kind: 'users', count: 2 },
      { kind: 'schedules', count: 1 },
      { kind: 'exceptions', count: 1 },
    ]);
    expect(usage.get('shift_second')).toEqual([]);
  });
});

describe('ShiftsRepository — gravação e ordem (Postgres exclusivo)', () => {
  it('grava após o maior sortOrder, acha nome sem caixa fora do próprio id e reordena 1..n numa transação', async () => {
    expect(await repo.maxSortOrder()).toBe(2);
    const night = await repo.create({
      name: 'Noite_%',
      startTime: '22:00',
      endTime: '06:00',
      sortOrder: 3,
    });

    expect(await repo.findByNameInsensitive(' NOITE_% ')).toMatchObject({
      id: night.id,
    });
    // Sem curinga: '_' e '%' do nome são literais.
    expect(await repo.findByNameInsensitive('Noitex%')).toBeNull();
    expect(await repo.findByNameInsensitive('noite_%', night.id)).toBeNull();

    await repo.update(night.id, { isActive: false });
    await repo.setOrder([night.id, 'shift_second', 'shift_first']);

    const rows = await repo.listAll();
    expect(rows.map((r) => [r.id, r.sortOrder, r.isActive])).toEqual([
      [night.id, 1, false],
      ['shift_second', 2, true],
      ['shift_first', 3, true],
    ]);
    expect(await repo.findById(night.id)).toMatchObject({ name: 'Noite_%' });
  });
});

describe('ShiftsRepository.usage — envio agendado (Postgres exclusivo)', () => {
  it('envio agendado pendente conta como scheduled; cancelado e disparado não contam', async () => {
    const dispatch = (state: 'SCHEDULED' | 'CANCELLED' | 'DISPATCHED') => ({
      targetType: 'SECTOR' as const,
      targetId: 's1',
      targetLabel: 'Produção · 2º turno · 21/10',
      shiftId: 'shift_second',
      text: 'oi',
      state,
      scheduledFor: new Date('2026-10-21T18:00:00.000Z'),
    });
    await prisma.teamWhatsappDispatch.createMany({
      data: [
        dispatch('SCHEDULED'),
        dispatch('CANCELLED'),
        dispatch('DISPATCHED'),
      ],
    });

    const usage = await repo.usage(['shift_second'], TODAY);

    expect(usage.get('shift_second')).toEqual([
      { kind: 'scheduled', count: 1 },
    ]);
  });
});
