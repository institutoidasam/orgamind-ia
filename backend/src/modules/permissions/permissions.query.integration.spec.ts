import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Role } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { findEffectivePermissions } from './permissions.query';
import { defaultPermissionsFor } from '../../shared/authz/permissions';

const ROLES: Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;

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

function setGranted(granted: boolean): Promise<unknown> {
  return prisma.rolePermission.update({
    where: { role_key: { role: 'OPERATOR', key: 'escala.alterar' } },
    data: { granted },
  });
}

describe('findEffectivePermissions (banco real)', () => {
  it('banco migrado: os 4 papéis devolvem defaultPermissionsFor', async () => {
    for (const role of ROLES) {
      await expect(findEffectivePermissions(prisma, role)).resolves.toEqual(
        defaultPermissionsFor(role),
      );
    }
  });

  it('linha OPERATOR escala.alterar granted false tira a chave na leitura seguinte; true devolve', async () => {
    await setGranted(false);
    const revoked = await findEffectivePermissions(prisma, 'OPERATOR');
    await setGranted(true);
    const restored = await findEffectivePermissions(prisma, 'OPERATOR');

    expect(revoked).not.toContain('escala.alterar');
    expect(revoked).toEqual(
      defaultPermissionsFor('OPERATOR').filter((k) => k !== 'escala.alterar'),
    );
    expect(restored).toEqual(defaultPermissionsFor('OPERATOR'));
  });
});
