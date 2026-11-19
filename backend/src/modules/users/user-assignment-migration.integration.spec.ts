import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes do histórico de vínculo (20261119110000 em diante).
const BEFORE_ASSIGNMENT_HISTORY = '20261119100000_role_permissions';
const MIGRATION_FILE = path.resolve(
  __dirname,
  '../../../prisma/migrations/20261119110000_user_assignment_history/migration.sql',
);

type AssignmentRow = {
  id: string;
  userId: string;
  sectorId: string | null;
  shiftId: string | null;
  levelId: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  recordedById: string | null;
};

const BLANK = { validFrom: null, validTo: null, recordedById: null };
// Como o backfill deve deixar cada pessoa legada: valores da ficha (aceite 18, DV4).
const OPEN_AFTER: AssignmentRow[] = [
  {
    id: 'ua_u-full',
    userId: 'u-full',
    sectorId: 's-legacy',
    shiftId: 'sh-legacy',
    levelId: 'lv-legacy',
    ...BLANK,
  },
  {
    id: 'ua_u-inactive',
    userId: 'u-inactive',
    sectorId: 's-legacy',
    shiftId: null,
    levelId: 'lv-legacy',
    ...BLANK,
  },
  {
    id: 'ua_u-no-access',
    userId: 'u-no-access',
    sectorId: 's-legacy',
    shiftId: 'sh-legacy',
    levelId: null,
    ...BLANK,
  },
  {
    id: 'ua_u-no-sector',
    userId: 'u-no-sector',
    sectorId: null,
    shiftId: null,
    levelId: null,
    ...BLANK,
  },
];

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let deployStartedAt: Date;

// Produção antes da migração: ativa completa, inativa, sem acesso e sem setor.
async function seedLegacyData(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "Sector" ("id", "name", "code", "updatedAt")
      VALUES ('s-legacy', 'Setor legado', 'LEG', now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "Shift" ("id", "name", "startTime", "endTime", "sortOrder", "updatedAt")
      VALUES ('sh-legacy', 'Turno legado', '07:00', '13:00', 9, now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "StaffLevel" ("id", "name", "sortOrder", "updatedAt")
      VALUES ('lv-legacy', 'Nível legado', 9, now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "password", "hasAccess", "role", "isActive",
        "sectorId", "shiftId", "levelId", "updatedAt") VALUES
      ('u-full', 'full@test.local', 'hash', true, 'OPERATOR', true, 's-legacy', 'sh-legacy', 'lv-legacy', now()),
      ('u-inactive', 'inactive@test.local', 'hash', true, 'OPERATOR', false, 's-legacy', NULL, 'lv-legacy', now()),
      ('u-no-access', NULL, NULL, false, 'VIEWER', true, 's-legacy', 'sh-legacy', NULL, now()),
      ('u-no-sector', 'nosector@test.local', 'hash', true, 'ADMIN', true, NULL, NULL, NULL, now())`,
  );
}

// Trecho entre os marcadores do arquivo real, partido em INSERT e DO: o Prisma
// executa um comando por chamada.
function backfillBlock(): { insert: string; check: string } {
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  const block = sql.slice(
    sql.indexOf('-- backfill:begin'),
    sql.indexOf('-- backfill:end'),
  );
  const doAt = block.indexOf('DO $$');
  return { insert: block.slice(0, doAt), check: block.slice(doAt) };
}

function openRows(db: PrismaClient): Promise<AssignmentRow[]> {
  return db.$queryRaw<AssignmentRow[]>`
    SELECT "id", "userId", "sectorId", "shiftId", "levelId", "validFrom", "validTo", "recordedById"
    FROM "UserAssignment" WHERE "validTo" IS NULL ORDER BY "userId"`;
}

async function countRows(db: PrismaClient, userId?: string): Promise<number> {
  const [{ total }] = await db.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total FROM "UserAssignment"
    WHERE ${userId ?? null}::text IS NULL OR "userId" = ${userId ?? null}`;
  return total;
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_ASSIGNMENT_HISTORY });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedLegacyData(prisma);
  deployStartedAt = new Date();
  deployMigrations({ databaseUrl });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('migração 20261119110000_user_assignment_history — backfill', () => {
  it('a migração real cria uma linha aberta por pessoa legada, igual à ficha, com início, fim e recordedById em branco', async () => {
    expect(await openRows(prisma)).toEqual(OPEN_AFTER);
    expect(await countRows(prisma)).toBe(OPEN_AFTER.length);
    const [{ first }] = await prisma.$queryRaw<{ first: Date }[]>`
      SELECT min("recordedAt") AS "first" FROM "UserAssignment"`;
    // `now()` do banco e relógio do teste são da mesma máquina (margem de 5 s).
    expect(first.getTime()).toBeGreaterThanOrEqual(
      deployStartedAt.getTime() - 5_000,
    );
  });

  it('cria linha aberta para pessoa sem setor, turno e nível e para pessoa inativa', async () => {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT u."id", u."isActive", a."sectorId", a."shiftId", a."levelId"
      FROM "User" u
      JOIN "UserAssignment" a ON a."userId" = u."id" AND a."validTo" IS NULL
      WHERE u."id" IN ('u-inactive', 'u-no-sector') ORDER BY u."id"`;

    expect(rows).toEqual([
      {
        id: 'u-inactive',
        isActive: false,
        sectorId: 's-legacy',
        shiftId: null,
        levelId: 'lv-legacy',
      },
      {
        id: 'u-no-sector',
        isActive: true,
        sectorId: null,
        shiftId: null,
        levelId: null,
      },
    ]);
  });
});

describe('migração 20261119110000_user_assignment_history — reexecução', () => {
  it('reexecutar o backfill não duplica nem altera linha existente', async () => {
    await prisma.$executeRaw`
      UPDATE "UserAssignment" SET "validFrom" = '2026-01-05', "recordedById" = 'u-admin'
      WHERE "id" = 'ua_u-full'`;
    const before = await openRows(prisma);
    const { insert, check } = backfillBlock();

    await prisma.$executeRawUnsafe(insert);
    await prisma.$executeRawUnsafe(check);

    expect(await openRows(prisma)).toEqual(before);
    expect(await countRows(prisma)).toBe(OPEN_AFTER.length);
    expect(before[0]).toMatchObject({
      id: 'ua_u-full',
      validFrom: new Date('2026-01-05'),
      recordedById: 'u-admin',
    });
  });

  it('o DO falha quando uma linha aberta diverge da ficha', async () => {
    await prisma.$executeRaw`
      UPDATE "UserAssignment" SET "sectorId" = NULL WHERE "id" = 'ua_u-no-access'`;
    await prisma.$executeRaw`
      INSERT INTO "User" ("id", "email", "password", "role", "updatedAt")
      VALUES ('u-late', 'late@test.local', 'hash', 'VIEWER', now())`;

    await expect(
      prisma.$executeRawUnsafe(backfillBlock().check),
    ).rejects.toThrow(
      /pessoas sem linha aberta = 1, linhas abertas diferentes da ficha = 1/,
    );

    await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = 'u-late'`;
    await prisma.$executeRaw`
      UPDATE "UserAssignment" SET "sectorId" = 's-legacy' WHERE "id" = 'ua_u-no-access'`;
  });
});

describe('migração 20261119110000_user_assignment_history — garantias do banco', () => {
  it('o banco recusa segunda linha aberta da mesma pessoa e início depois do fim', async () => {
    // 23505 = unique_violation (o único índice único em `userId` é o parcial
    // UserAssignment_userId_open_key); 23514 = check_violation.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "UserAssignment" ("id", "userId") VALUES ('ua-dup', 'u-full')`,
    ).rejects.toThrow(
      /23505[\s\S]*Key \(\W*userId\W*\)=\(u-full\) already exists/,
    );
    await expect(
      prisma.$executeRaw`
        INSERT INTO "UserAssignment" ("id", "userId", "validFrom", "validTo")
        VALUES ('ua-bad', 'u-full', '2026-05-02', '2026-05-01')`,
    ).rejects.toThrow(/23514[\s\S]*UserAssignment_period_check/);
  });

  it('apagar a pessoa apaga as linhas; apagar setor com histórico é recusado', async () => {
    await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = 'u-inactive'`;
    expect(await countRows(prisma, 'u-inactive')).toBe(0);

    // Setor só no passado (linha fechada) e em nenhuma ficha: o Restrict o protege.
    await prisma.$executeRaw`
      INSERT INTO "Sector" ("id", "name", "code", "updatedAt")
      VALUES ('s-old', 'Setor antigo', 'OLD', now())`;
    await prisma.$executeRaw`
      INSERT INTO "UserAssignment" ("id", "userId", "sectorId", "validFrom", "validTo")
      VALUES ('ua-old', 'u-full', 's-old', '2025-01-01', '2025-01-01')`;

    // 23503 = foreign_key_violation.
    await expect(
      prisma.$executeRaw`DELETE FROM "Sector" WHERE "id" = 's-old'`,
    ).rejects.toThrow(/23503[\s\S]*UserAssignment_sectorId_fkey/);
  });
});
