import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes da chave pessoas.importar (20261119130000 em diante).
const BEFORE_IMPORT_PERMISSION = '20261119120100_audit_category_spreadsheet';
const MIGRATION_SQL = path.resolve(
  __dirname,
  '../../../prisma/migrations/20261119130000_people_import_permission/migration.sql',
);

type ImportRow = {
  role: string;
  granted: boolean;
  updatedById: string | null;
};

let postgres: StartedPostgreSqlContainer;
// `clean`: deploy completo sem tocar em nada. `edited`: o Supervisor já tinha a
// chave liberada pela tela antes de a migração rodar.
let clean: PrismaClient;
let edited: PrismaClient;

function databaseUrl(name: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

function importRows(db: PrismaClient): Promise<ImportRow[]> {
  return db.$queryRaw<ImportRow[]>`
    SELECT "role"::text AS "role", "granted", "updatedById" FROM "RolePermission"
    WHERE "key" = 'pessoas.importar' ORDER BY "role"::text`;
}

async function countRows(db: PrismaClient): Promise<number> {
  const [{ total }] = await db.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total FROM "RolePermission"`;
  return total;
}

/** O `INSERT … ON CONFLICT DO NOTHING` da própria migração, como está no arquivo. */
function seedStatement(): string {
  const match = /INSERT INTO "RolePermission"[\s\S]*?;/.exec(
    readFileSync(MIGRATION_SQL, 'utf8'),
  );
  if (!match) throw new Error('INSERT de semeadura não encontrado na migração');
  return match[0];
}

async function deployWithEditedSupervisor(): Promise<PrismaClient> {
  const url = databaseUrl('orgamind_edited');
  deployMigrations({ databaseUrl: url, until: BEFORE_IMPORT_PERMISSION });
  const db = new PrismaClient({ datasources: { db: { url } } });
  await db.$executeRaw`
    INSERT INTO "RolePermission" ("role", "key", "granted")
    VALUES ('SUPERVISOR', 'pessoas.importar', true)`;
  deployMigrations({ databaseUrl: url });
  return db;
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const cleanUrl = databaseUrl('orgamind_test');
  deployMigrations({ databaseUrl: cleanUrl });
  clean = new PrismaClient({ datasources: { db: { url: cleanUrl } } });
  await clean.$executeRawUnsafe('CREATE DATABASE "orgamind_edited"');
  edited = await deployWithEditedSupervisor();
}, 300_000);

afterAll(async () => {
  await clean?.$disconnect();
  await edited?.$disconnect();
  await postgres?.stop();
});

describe('migração 20261119130000_people_import_permission', () => {
  it('semeia pessoas.importar negada para SUPERVISOR e OPERATOR, sem autor', async () => {
    const rows = await importRows(clean);

    expect(rows).toEqual([
      { role: 'OPERATOR', granted: false, updatedById: null },
      { role: 'SUPERVISOR', granted: false, updatedById: null },
    ]);
  });

  it('não sobrescreve linha de pessoas.importar já gravada pela tela', async () => {
    const rows = await importRows(edited);

    expect(rows).toEqual([
      { role: 'OPERATOR', granted: false, updatedById: null },
      { role: 'SUPERVISOR', granted: true, updatedById: null },
    ]);
  });

  it('reaplicar o INSERT não duplica', async () => {
    const before = await countRows(clean);

    await clean.$executeRawUnsafe(seedStatement());

    expect(await countRows(clean)).toBe(before);
    expect(await importRows(clean)).toHaveLength(2);
  });
});
