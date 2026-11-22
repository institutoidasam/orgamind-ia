import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { auditCategorySchema } from '../../schemas/contracts/audit-trail.schema';

const MIGRATION_SQL = path.resolve(
  __dirname,
  '../../../prisma/migrations/20261119120100_audit_category_spreadsheet/migration.sql',
);

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;

function insertSpreadsheetEvent(id: string): Promise<number> {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "AuditEvent" ("id", "action", "entity", "category")
     VALUES ('${id}', 'spreadsheet.export', 'User', 'SPREADSHEET')`,
  );
}

function enumLabels(): Promise<{ label: string }[]> {
  return prisma.$queryRaw<{ label: string }[]>`
    SELECT e.enumlabel AS "label" FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'AuditCategory' ORDER BY e.enumsortorder`;
}

describe('categoria de trilha Planilhas', () => {
  it('auditCategorySchema aceita SPREADSHEET', () => {
    expect(auditCategorySchema.parse('SPREADSHEET')).toBe('SPREADSHEET');
  });
});

describe('migração 20261119120100_audit_category_spreadsheet', () => {
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('orgamind_test')
      .withUsername('orgamind')
      .withPassword('orgamind')
      .start();
    const databaseUrl = postgres.getConnectionUri();
    deployMigrations({ databaseUrl });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it('depois do deploy o enum AuditCategory aceita SPREADSHEET', async () => {
    await expect(insertSpreadsheetEvent('evt-spreadsheet-1')).resolves.toBe(1);

    const rows = await prisma.$queryRaw<{ category: string }[]>`
      SELECT "category"::text AS "category" FROM "AuditEvent"
      WHERE "id" = 'evt-spreadsheet-1'`;
    expect(rows).toEqual([{ category: 'SPREADSHEET' }]);
  });

  it('reaplicar a migração não falha nem altera o enum', async () => {
    const before = await enumLabels();

    await prisma.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

    const after = await enumLabels();
    expect(after).toEqual(before);
    expect(after.at(-1)).toEqual({ label: 'SPREADSHEET' });
  });
});
