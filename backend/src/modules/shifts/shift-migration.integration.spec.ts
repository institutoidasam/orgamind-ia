import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations, schemaDrift } from '../../../test/migrations';

// Última migração antes da entidade Turno: os dados legados usam o enum WorkShift.
const BEFORE_SHIFT_ENTITY = '20261021090000_work_shift';
// T1 (aditiva + backfill); as migrações seguintes (DROP da T2b em diante) entram
// no `describe` da T2b, para cada uma ser conferida no estado em que deixa o banco.
const SHIFT_ENTITY = '20261021100000_shift_entity';
// Único diff que o job `migration-drift` do CI tolera.
const KNOWN_QUARANTINE_DROP = 'DROP TABLE "_message_dup_neutralized_20260819";';

// C1: os dois turnos legados com ids fixos.
const MIGRATED_SHIFTS = [
  {
    id: 'shift_first',
    name: '1º turno',
    startTime: '06:00',
    endTime: '14:00',
    isActive: true,
    sortOrder: 1,
  },
  {
    id: 'shift_second',
    name: '2º turno',
    startTime: '14:00',
    endTime: '22:00',
    isActive: true,
    sortOrder: 2,
  },
];

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let databaseUrl: string;

// Produção antes da T1: usuários FIRST/SECOND/sem turno, um envio do 2º turno e
// dois destinatários (um FIRST, um sem turno).
async function seedLegacyShifts(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "password", "updatedAt", "shift") VALUES
      ('u-first', 'first@test.local', 'x', now(), 'FIRST'),
      ('u-second', 'second@test.local', 'x', now(), 'SECOND'),
      ('u-none', 'none@test.local', 'x', now(), NULL)`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappDispatch" ("id", "targetType", "targetId", "targetLabel", "text", "shift")
      VALUES ('d-second', 'SECTOR', 's1', 'Produção · 2º turno', 'Bom dia', 'SECOND')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id", "dispatchId", "userId", "userName", "updatedAt", "shift") VALUES
      ('r-first', 'd-second', 'u-first', 'First', now(), 'FIRST'),
      ('r-none', 'd-second', 'u-none', 'None', now(), NULL)`,
  );
}

// R4: backfill da T1 (FIRST/SECOND → shift_first/shift_second + snapshot do nome),
// conferido logo depois da T1 e de novo depois do DROP da T2b.
async function expectShiftBackfill(db: PrismaClient): Promise<void> {
  const users = await db.$queryRaw`
    SELECT "id", "shiftId" FROM "User"
    WHERE "id" IN ('u-first', 'u-second', 'u-none') ORDER BY "id"`;
  expect(users).toEqual([
    { id: 'u-first', shiftId: 'shift_first' },
    { id: 'u-none', shiftId: null },
    { id: 'u-second', shiftId: 'shift_second' },
  ]);
  const dispatches = await db.$queryRaw`
    SELECT "shiftId", "shiftName", "shiftStartTime", "shiftEndTime"
    FROM "TeamWhatsappDispatch"`;
  expect(dispatches).toEqual([
    {
      shiftId: 'shift_second',
      shiftName: '2º turno',
      shiftStartTime: '14:00',
      shiftEndTime: '22:00',
    },
  ]);
  const recipients = await db.$queryRaw`
    SELECT "shiftId", "shiftName" FROM "TeamWhatsappRecipient" ORDER BY "id"`;
  expect(recipients).toEqual([
    { shiftId: 'shift_first', shiftName: '1º turno' },
    { shiftId: null, shiftName: null },
  ]);
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_SHIFT_ENTITY });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedLegacyShifts(prisma);
  deployMigrations({ databaseUrl, until: SHIFT_ENTITY });
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('migração 20261021100000_shift_entity', () => {
  it('cria 1º turno 06:00–14:00 e 2º turno 14:00–22:00, ativos, ordem 1 e 2', async () => {
    const shifts = await prisma.$queryRaw`
      SELECT "id", "name", "startTime", "endTime", "isActive", "sortOrder"
      FROM "Shift" ORDER BY "sortOrder"`;
    expect(shifts).toEqual(MIGRATED_SHIFTS);
  });

  it('FIRST/SECOND viram shift_first/shift_second em User, envio e destinatário', async () => {
    await expectShiftBackfill(prisma);
  });
});

describe('migração 20261021101000_drop_work_shift_enum', () => {
  beforeAll(() => {
    deployMigrations({ databaseUrl });
  }, 240_000);

  it('tipo WorkShift e colunas shift não existem mais', async () => {
    const types = await prisma.$queryRaw`
      SELECT "typname"::text AS "typname" FROM "pg_type" WHERE "typname" = 'WorkShift'`;
    expect(types).toEqual([]);
    // Só a FK `shiftId` sobra nas três tabelas (D12).
    const columns = await prisma.$queryRaw`
      SELECT "table_name"::text AS "table", "column_name"::text AS "column"
      FROM "information_schema"."columns"
      WHERE "table_schema" = current_schema()
        AND "column_name" IN ('shift', 'shiftId')
        AND "table_name" IN ('User', 'TeamWhatsappDispatch', 'TeamWhatsappRecipient')
      ORDER BY "table_name", "column_name"`;
    expect(columns).toEqual([
      { table: 'TeamWhatsappDispatch', column: 'shiftId' },
      { table: 'TeamWhatsappRecipient', column: 'shiftId' },
      { table: 'User', column: 'shiftId' },
    ]);
  });

  it('backfill da T1 preservado depois do DROP', async () => {
    await expectShiftBackfill(prisma);
  });
});

describe('schema sem drift (igual ao CI)', () => {
  it('migrações aplicadas no shadow batem com o schema.prisma', async () => {
    await prisma.$executeRawUnsafe('CREATE DATABASE shadow');
    const shadow = new URL(postgres.getConnectionUri());
    shadow.pathname = '/shadow';

    const drift = schemaDrift({ shadowUrl: shadow.toString() });

    expect([
      { status: 0, script: '' },
      { status: 2, script: KNOWN_QUARANTINE_DROP },
    ]).toContainEqual(drift);
  }, 180_000);
});
