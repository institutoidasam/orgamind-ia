import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { UsersRepository } from './users.repository';

describe('UsersRepository last active admin guard (real Postgres)', () => {
  let postgres: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let repo: UsersRepository;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('orgamind_test')
      .withUsername('orgamind')
      .withPassword('orgamind')
      .start();
    const url = postgres.getConnectionUri();
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: url },
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url } } });
    repo = new UsersRepository(prisma as never);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it('allows only one of two concurrent deactivations of the last active admins', async () => {
    const [first, second] = await Promise.all([
      prisma.user.create({
        data: { email: 'admin-one@test.local', password: 'x', role: 'ADMIN' },
      }),
      prisma.user.create({
        data: { email: 'admin-two@test.local', password: 'x', role: 'ADMIN' },
      }),
    ]);
    const results = await Promise.all([
      repo.updateWithLastAdminGuard(first.id, { isActive: false }),
      repo.updateWithLastAdminGuard(second.id, { isActive: false }),
    ]);
    expect(results.filter((result) => 'updated' in result)).toHaveLength(1);
    expect(results.filter((result) => 'lastAdmin' in result)).toHaveLength(1);
    await expect(
      prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
    ).resolves.toBe(1);
  }, 60_000);

  it('does not count an inactive admin as the active-admin floor', async () => {
    const active = await prisma.user.create({
      data: { email: 'active@test.local', password: 'x', role: 'ADMIN' },
    });
    const inactive = await prisma.user.create({
      data: {
        email: 'inactive@test.local',
        password: 'x',
        role: 'ADMIN',
        isActive: false,
      },
    });
    await expect(
      repo.deleteWithLastAdminGuard(inactive.id),
    ).resolves.toMatchObject({ deleted: { id: inactive.id } });
    await expect(
      prisma.user.findUnique({ where: { id: active.id } }),
    ).resolves.not.toBeNull();
  }, 60_000);
});
