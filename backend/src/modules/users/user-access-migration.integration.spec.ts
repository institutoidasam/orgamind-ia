import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes de `hasAccess`: e-mail e senha ainda obrigatórios.
const BEFORE_USER_WITHOUT_ACCESS = '20261022090000_staff_level';

type PersonRow = {
  id: string;
  hasAccess: boolean;
  email: string | null;
  password: string | null;
};

const ADMIN_HASH = 'hash-admin';
const OPERATOR_HASH = 'hash-operator';

// Como ficam depois da migração: nada muda além de `hasAccess = true`.
const EXISTING_USERS_AFTER = [
  {
    id: 'u-admin',
    email: 'admin@test.local',
    password: ADMIN_HASH,
    sectorId: null,
    shiftId: null,
    hasAccess: true,
  },
  {
    id: 'u-operator',
    email: 'operator@test.local',
    password: OPERATOR_HASH,
    sectorId: 's-prod',
    shiftId: 'shift_first',
    hasAccess: true,
  },
];

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;

// Produção antes da migração: um ADMIN sem setor e um OPERATOR com setor e turno
// (`shift_first` vem da migração da entidade Turno).
async function seedExistingUsers(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "Sector" ("id", "name", "code", "updatedAt")
      VALUES ('s-prod', 'Produção', 'PROD', now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "password", "role", "updatedAt", "sectorId", "shiftId") VALUES
      ('u-admin', 'admin@test.local', 'hash-admin', 'ADMIN', now(), NULL, NULL),
      ('u-operator', 'operator@test.local', 'hash-operator', 'OPERATOR', now(), 's-prod', 'shift_first')`,
  );
}

// D1: pessoa sem acesso = VIEWER, sem troca de senha pendente.
function insertPerson(db: PrismaClient, row: PersonRow): Promise<number> {
  return db.$executeRaw`
    INSERT INTO "User" ("id", "name", "email", "password", "hasAccess", "role", "mustChangePassword", "updatedAt")
    VALUES (${row.id}, 'Pessoa', ${row.email}, ${row.password}, ${row.hasAccess}, 'VIEWER', false, now())`;
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_USER_WITHOUT_ACCESS });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedExistingUsers(prisma);
  deployMigrations({ databaseUrl });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('migração 20261022100000_user_without_access', () => {
  it('usuários existentes ficam com e-mail, senha, setor, turno e hasAccess true', async () => {
    const users = await prisma.$queryRaw`
      SELECT "id", "email", "password", "sectorId", "shiftId", "hasAccess"
      FROM "User" WHERE "id" IN ('u-admin', 'u-operator') ORDER BY "id"`;
    expect(users).toEqual(EXISTING_USERS_AFTER);
  });
});

describe('migração 20261022100000_user_without_access', () => {
  it('aceita pessoa sem acesso com e-mail e senha NULL', async () => {
    const row = {
      id: 'p-sem-acesso',
      hasAccess: false,
      email: null,
      password: null,
    };
    await insertPerson(prisma, row);
    const saved = await prisma.$queryRaw`
      SELECT "id", "hasAccess", "email", "password" FROM "User" WHERE "id" = ${row.id}`;
    expect(saved).toEqual([row]);
  });

  it.each([
    {
      label: 'hasAccess true + e-mail NULL',
      row: { id: 'p-misto-1', hasAccess: true, email: null, password: 'hash' },
    },
    {
      label: 'hasAccess false + senha preenchida',
      row: { id: 'p-misto-2', hasAccess: false, email: null, password: 'hash' },
    },
  ])('CHECK recusa estado misto: $label', async ({ row }) => {
    await expect(insertPerson(prisma, row)).rejects.toThrow(
      /User_access_consistent/,
    );
  });

  it('duas pessoas sem acesso convivem com e-mail NULL', async () => {
    const ids = ['p-null-1', 'p-null-2'];
    for (const id of ids) {
      await insertPerson(prisma, {
        id,
        hasAccess: false,
        email: null,
        password: null,
      });
    }
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "email" IS NULL AND "id" IN ('p-null-1', 'p-null-2')`;
    expect(rows).toHaveLength(2);
  });
});
