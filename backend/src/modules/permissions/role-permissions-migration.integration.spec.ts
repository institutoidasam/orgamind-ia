import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import {
  DEFAULT_MATRIX,
  EDITABLE_ROLES,
  PERMISSION_KEYS,
} from '../../shared/authz/permissions';

const MIGRATION_SQL = path.resolve(
  __dirname,
  '../../../prisma/migrations/20261119100000_role_permissions/migration.sql',
);

type PermissionRow = { role: string; key: string; granted: boolean };

// A matriz inicial inteira (2 papéis x 10 chaves), na ordem de leitura do SELECT.
const EXPECTED_ROWS: PermissionRow[] = EDITABLE_ROLES.flatMap((role) =>
  PERMISSION_KEYS.map((key) => ({
    role,
    key,
    granted: DEFAULT_MATRIX[role].includes(key),
  })),
).sort((a, b) => a.role.localeCompare(b.role) || a.key.localeCompare(b.key));

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;

function selectRows(): Promise<PermissionRow[]> {
  return prisma.$queryRaw<PermissionRow[]>`
    SELECT "role"::text AS "role", "key", "granted" FROM "RolePermission"
    ORDER BY "role"::text, "key"`;
}

/** O `INSERT … ON CONFLICT DO NOTHING` da própria migração, como está no arquivo. */
function seedStatement(): string {
  const match = /INSERT INTO "RolePermission"[\s\S]*?;/.exec(
    readFileSync(MIGRATION_SQL, 'utf8'),
  );
  if (!match) throw new Error('INSERT de semeadura não encontrado na migração');
  return match[0];
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

describe('migração 20261119100000_role_permissions', () => {
  it('semeia 20 linhas iguais a DEFAULT_MATRIX, sem autor', async () => {
    const rows = await selectRows();
    const [{ authored }] = await prisma.$queryRaw<{ authored: bigint }[]>`
      SELECT count(*) AS "authored" FROM "RolePermission" WHERE "updatedById" IS NOT NULL`;

    expect(rows).toHaveLength(20);
    expect(rows).toEqual(EXPECTED_ROWS);
    expect(authored).toBe(0n);
  });

  it('CHECK recusa linha de ADMIN e de VIEWER', async () => {
    for (const role of ['ADMIN', 'VIEWER']) {
      // 23514 = check_violation do Postgres.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "RolePermission" ("role", "key", "granted", "updatedAt")
           VALUES ('${role}', 'pessoas.editar', true, now())`,
        ),
      ).rejects.toThrow(/23514[\s\S]*RolePermission_role_editable_check/);
    }
  });

  it('reaplicar o INSERT da migração não duplica nem altera linha editada', async () => {
    await prisma.$executeRaw`
      UPDATE "RolePermission" SET "granted" = true
      WHERE "role" = 'OPERATOR' AND "key" = 'trilha.consultar'`;

    await prisma.$executeRawUnsafe(seedStatement());

    const rows = await selectRows();
    const edited = rows.find(
      (row) => row.role === 'OPERATOR' && row.key === 'trilha.consultar',
    );
    expect(rows).toHaveLength(20);
    expect(edited?.granted).toBe(true);
  });
});
