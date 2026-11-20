import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;

// Só as colunas sem padrão: o resto (status, reasons, warnings) vem do DEFAULT.
async function insertBatch(db: PrismaClient, id: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "PeopleImportBatch"
      ("id", "fileName", "fileSize", "fileSha256", "format", "headers", "mapping", "createdById", "updatedAt")
    VALUES (${id}, 'pessoas.csv', 120, ${'a'.repeat(64)}, 'csv',
      '["Nome","Telefone"]'::jsonb, '{}'::jsonb, 'u-admin', now())`;
}

// `personId` sem FK: aponta para uma pessoa que não existe no banco.
async function insertRow(
  db: PrismaClient,
  batchId: string,
  rowNumber: number,
  idSuffix = '',
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "PeopleImportRow" ("id", "batchId", "rowNumber", "cells", "personId")
    VALUES (${`${batchId}-r${rowNumber}${idSuffix}`}, ${batchId}, ${rowNumber},
      '{"0":"Ana Souza","1":"+5592991110001"}'::jsonb, 'pessoa-que-nao-existe')`;
}

async function countRows(db: PrismaClient, batchId: string): Promise<number> {
  const [{ total }] = await db.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total FROM "PeopleImportRow" WHERE "batchId" = ${batchId}`;
  return total;
}

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

describe('migração 20261119130100_people_import_tables — lote e linhas', () => {
  it('cria lote e linhas; apagar o lote apaga as linhas', async () => {
    await insertBatch(prisma, 'b-cascade');
    await insertRow(prisma, 'b-cascade', 2);
    await insertRow(prisma, 'b-cascade', 3);

    const [batch] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "status"::text AS "status", "previewCounts", "finishedAt"
      FROM "PeopleImportBatch" WHERE "id" = 'b-cascade'`;
    const [row] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "reasons", "warnings", "classification", "writeState", "outcome"
      FROM "PeopleImportRow" WHERE "id" = 'b-cascade-r2'`;
    expect(batch).toEqual({
      status: 'PREVIEW',
      previewCounts: null,
      finishedAt: null,
    });
    expect(row).toEqual({
      reasons: [],
      warnings: [],
      classification: null,
      writeState: null,
      outcome: null,
    });
    expect(await countRows(prisma, 'b-cascade')).toBe(2);

    await prisma.$executeRaw`DELETE FROM "PeopleImportBatch" WHERE "id" = 'b-cascade'`;

    expect(await countRows(prisma, 'b-cascade')).toBe(0);
  });

  it('número da linha é único por lote', async () => {
    await insertBatch(prisma, 'b-unique-1');
    await insertBatch(prisma, 'b-unique-2');
    await insertRow(prisma, 'b-unique-1', 5);

    // Id diferente: o que barra é o índice único (lote, linha), não a chave primária.
    await expect(insertRow(prisma, 'b-unique-1', 5, '-dup')).rejects.toThrow(
      /23505.*batchId.*rowNumber.*b-unique-1, 5/s,
    );
    // O mesmo número em outro lote é outra linha.
    await insertRow(prisma, 'b-unique-2', 5);
    expect(await countRows(prisma, 'b-unique-2')).toBe(1);
  });
});

describe('migração 20261119130100_people_import_tables — cells', () => {
  it('cells é jsonb: o operador - tira as chaves pedidas', async () => {
    await insertBatch(prisma, 'b-cells');
    await insertRow(prisma, 'b-cells', 2);

    const [{ kind }] = await prisma.$queryRaw<{ kind: string }[]>`
      SELECT pg_typeof("cells")::text AS "kind" FROM "PeopleImportRow"
      WHERE "id" = 'b-cells-r2'`;
    await prisma.$executeRaw`
      UPDATE "PeopleImportRow" SET "cells" = "cells" - ARRAY['1']::text[]
      WHERE "batchId" = 'b-cells'`;
    const [{ cells }] = await prisma.$queryRaw<{ cells: unknown }[]>`
      SELECT "cells" FROM "PeopleImportRow" WHERE "id" = 'b-cells-r2'`;

    expect(kind).toBe('jsonb');
    expect(cells).toEqual({ '0': 'Ana Souza' });
  });
});
