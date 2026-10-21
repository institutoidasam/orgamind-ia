import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { UsersRepository } from './users.repository';

// One container + `migrate deploy` for the whole file (both describes).
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

describe('UsersRepository last active admin guard (real Postgres)', () => {
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

describe('UsersRepository phone + contact link (real Postgres)', () => {
  it('acha o titular por qualquer grafia e o FK SetNull desliga ao apagar o contato', async () => {
    const contact = await prisma.contact.create({
      data: { phoneE164: '+559291234567' },
    });
    const user = await prisma.user.create({
      data: {
        email: 'phone@test.local',
        password: 'x',
        phoneE164: '+5592991234567',
        contactId: contact.id,
      },
    });
    await expect(
      repo.findIdByPhoneVariants(['+5592991234567', '+559291234567']),
    ).resolves.toBe(user.id);
    await expect(repo.findContactId(user.id)).resolves.toBe(contact.id);

    await prisma.contact.delete({ where: { id: contact.id } });

    await expect(
      prisma.user.findUnique({ where: { id: user.id } }),
    ).resolves.toMatchObject({ contactId: null, phoneE164: '+5592991234567' });
  }, 60_000);
});

describe('UsersRepository turno (real Postgres)', () => {
  it('shiftId grava, lê e limpa', async () => {
    const [withShift, withoutShift] = await Promise.all([
      prisma.user.create({
        data: {
          email: 'shift-1@test.local',
          password: 'x',
          shiftId: 'shift_first',
        },
      }),
      prisma.user.create({
        data: { email: 'shift-none@test.local', password: 'x' },
      }),
    ]);
    await expect(repo.findById(withShift.id)).resolves.toMatchObject({
      shiftId: 'shift_first',
    });
    await expect(repo.findById(withoutShift.id)).resolves.toMatchObject({
      shiftId: null,
    });
    await expect(repo.findShiftForAssignment('shift_first')).resolves.toEqual({
      id: 'shift_first',
      isActive: true,
    });
    await expect(repo.findShiftForAssignment('shift_nope')).resolves.toBeNull();

    await repo.updateWithLastAdminGuard(withShift.id, {
      workShift: { disconnect: true },
    });

    await expect(repo.findById(withShift.id)).resolves.toMatchObject({
      shiftId: null,
    });
  }, 60_000);
});

describe('UsersRepository função (real Postgres)', () => {
  it('jobTitle grava, lê e limpa', async () => {
    const user = await repo.create({
      email: 'job-title@test.local',
      password: 'x',
      jobTitle: 'Operador de empilhadeira',
    });
    await expect(repo.findById(user.id)).resolves.toMatchObject({
      jobTitle: 'Operador de empilhadeira',
    });

    await repo.updateWithLastAdminGuard(user.id, { jobTitle: null });

    await expect(repo.findById(user.id)).resolves.toMatchObject({
      jobTitle: null,
    });
  }, 60_000);
});
