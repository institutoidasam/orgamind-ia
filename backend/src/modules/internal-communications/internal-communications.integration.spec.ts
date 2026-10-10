/* Supertest exposes parsed HTTP bodies as `any`; assertions below narrow the
 * product fields each BDD verifies. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';

const require = createRequire(import.meta.url);
const PASSWORD = randomUUID();
const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('internal communications (Postgres + Nest HTTP)', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let prisma: PrismaService;
  let tokens: Record<string, string>;
  let ids: Record<string, string>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('orgamind_internal_test')
      .withUsername('picoa')
      .withPassword('picoa')
      .start();
    redis = await new RedisContainer('redis:7-alpine').start();
    configureEnvironment(postgres, redis);
    deployMigrations(postgres.getConnectionUri());

    const { AppModule } = await import('../../app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    ids = await seed(prisma);
    tokens = await loginAll(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  }, 60_000);

  it('persists the wizard payload, restricts detail and makes viewers read-only', async () => {
    const created = await createDemand(tokens.operatorA, UUID);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'DEMAND',
      subject: 'Reposição urgente',
      priority: 'HIGH',
      status: 'OPEN',
      dueDate: '2026-10-31',
      originSector: { id: ids.sectorA },
      destinationSector: { id: ids.sectorB },
    });

    await request(app.getHttpServer())
      .get(`/internal/communications/${created.body.id}`)
      .set(auth(tokens.operatorD))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/internal/communications/${created.body.id}/comments`)
      .set(auth(tokens.viewerB))
      .send({ message: 'não pode comentar' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/internal/communications/${created.body.id}/read`)
      .set(auth(tokens.viewerB))
      .expect(201);
  });

  it('deduplicates retry after assignment and atomically rejects a stale version', async () => {
    const first = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440001',
    );
    const id = first.body.id as string;
    const assigned = await request(app.getHttpServer())
      .patch(`/internal/communications/${id}/demand`)
      .set(auth(tokens.operatorB))
      .send({ expectedVersion: first.body.version, assigneeId: ids.operatorB })
      .expect(200);
    expect(assigned.body.status).toBe('IN_PROGRESS');

    const retry = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440001',
    );
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(id);

    await request(app.getHttpServer())
      .patch(`/internal/communications/${id}/demand`)
      .set(auth(tokens.operatorB))
      .send({ expectedVersion: first.body.version, status: 'COMPLETED' })
      .expect(409);
    const events = await prisma.internalEvent.findMany({
      where: { communicationId: id },
    });
    expect(events.filter((event) => event.kind === 'CREATED')).toHaveLength(1);
  });

  it('creates one row for concurrent wizard retries', async () => {
    const requestId = '550e8400-e29b-41d4-a716-446655440002';
    const responses = await Promise.all([
      createDemand(tokens.operatorA, requestId),
      createDemand(tokens.operatorA, requestId),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 201,
    ]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
  });

  it('retries serializable creates with different client request ids', async () => {
    const responses = await Promise.all([
      createDemand(tokens.operatorA, '550e8400-e29b-41d4-a716-446655440004'),
      createDemand(tokens.operatorA, '550e8400-e29b-41d4-a716-446655440005'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 201,
    ]);
    expect(responses[0].body.id).not.toBe(responses[1].body.id);
  });

  it('returns unread badge after read only when a later comment updates the communication', async () => {
    const before = await unread(tokens.operatorB);
    const created = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440003',
    );
    const id = created.body.id as string;
    expect(await unread(tokens.operatorB)).toBeGreaterThan(before);
    await request(app.getHttpServer())
      .post(`/internal/communications/${id}/read`)
      .set(auth(tokens.operatorB))
      .expect(201);
    expect(await unread(tokens.operatorB)).toBe(before);
    await request(app.getHttpServer())
      .post(`/internal/communications/${id}/comments`)
      .set(auth(tokens.operatorB))
      .send({ message: 'assumi' })
      .expect(201);
    expect(await unread(tokens.operatorB)).toBeGreaterThan(before);
  });

  it('honours notification flags and keeps a later comment unread only when notification is enabled', async () => {
    const before = await unread(tokens.operatorB);
    const created = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440006',
      { notifyTeam: false, notifyAssignee: false },
    );
    const id = created.body.id as string;
    expect(await unread(tokens.operatorB)).toBe(before);
    await request(app.getHttpServer())
      .post(`/internal/communications/${id}/comments`)
      .set(auth(tokens.operatorB))
      .send({ message: 'registrado sem alerta' })
      .expect(201);
    expect(await unread(tokens.operatorB)).toBe(before);
  });

  it('rejects inactive sectors and an assignee changed while assignment waits on its row lock', async () => {
    await prisma.sector.update({
      where: { id: ids.sectorA },
      data: { isActive: false },
    });
    await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440007',
    ).expect(400);
    await prisma.sector.update({
      where: { id: ids.sectorA },
      data: { isActive: true },
    });
    await prisma.sector.update({
      where: { id: ids.sectorB },
      data: { isActive: false },
    });
    await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440008',
    ).expect(400);
    await prisma.sector.update({
      where: { id: ids.sectorB },
      data: { isActive: true },
    });

    const created = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440009',
    );
    const locker = new PrismaClient({
      datasources: { db: { url: postgres.getConnectionUri() } },
    });
    await locker.$connect();
    let inTransaction = false;
    try {
      await locker.$executeRawUnsafe('BEGIN');
      inTransaction = true;
      await locker.$queryRawUnsafe(
        'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
        ids.operatorB,
      );
      let completed = false;
      const assigning = request(app.getHttpServer())
        .patch(`/internal/communications/${created.body.id}/demand`)
        .set(auth(tokens.admin))
        .send({
          expectedVersion: created.body.version,
          assigneeId: ids.operatorB,
        })
        .then((response) => {
          completed = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(completed).toBe(false);
      await locker.$queryRawUnsafe(
        'UPDATE "User" SET "sectorId" = $1 WHERE "id" = $2',
        ids.sectorC,
        ids.operatorB,
      );
      await locker.$executeRawUnsafe('COMMIT');
      inTransaction = false;
      await expect(assigning).resolves.toMatchObject({ status: 400 });
    } finally {
      if (inTransaction) await locker.$executeRawUnsafe('ROLLBACK');
      await locker.$disconnect();
      await prisma.user.update({
        where: { id: ids.operatorB },
        data: { sectorId: ids.sectorB, isActive: true },
      });
    }
    await prisma.user.update({
      where: { id: ids.operatorB },
      data: { sectorId: ids.sectorB, isActive: false },
    });
    await request(app.getHttpServer())
      .patch(`/internal/communications/${created.body.id}/demand`)
      .set(auth(tokens.admin))
      .send({
        expectedVersion: created.body.version,
        assigneeId: ids.operatorB,
      })
      .expect(400);
    await request(app.getHttpServer())
      .get('/internal/dashboard')
      .set(auth(tokens.operatorB))
      .expect(401);
    await prisma.user.update({
      where: { id: ids.operatorB },
      data: { isActive: true },
    });
  });

  it('rejects an ineligible assignee and idempotent UUID replays by another payload or author', async () => {
    const requestId = '550e8400-e29b-41d4-a716-446655440010';
    const created = await createDemand(tokens.operatorA, requestId);
    await request(app.getHttpServer())
      .patch(`/internal/communications/${created.body.id}/demand`)
      .set(auth(tokens.operatorB))
      .send({ expectedVersion: created.body.version, assigneeId: ids.viewerB })
      .expect(400);
    await createDemand(tokens.operatorA, requestId, {
      subject: 'Outro assunto',
    }).expect(409);

    const other = await prisma.user.create({
      data: {
        email: 'other@test.local',
        password: await argon2.hash(PASSWORD),
        name: 'Outro autor',
        role: 'OPERATOR',
        sectorId: ids.sectorA,
      },
    });
    await createDemand(tokenFor(other), requestId).expect(409);
  });

  it('tracks waiting, completion and reopening in dashboard metrics', async () => {
    const created = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440011',
    );
    const waiting = await request(app.getHttpServer())
      .patch(`/internal/communications/${created.body.id}/demand`)
      .set(auth(tokens.operatorB))
      .send({ expectedVersion: created.body.version, status: 'WAITING' })
      .expect(200);
    expect(waiting.body.status).toBe('WAITING');
    const beforeCompleted = await dashboard(tokens.operatorB);
    const completed = await request(app.getHttpServer())
      .patch(`/internal/communications/${created.body.id}/demand`)
      .set(auth(tokens.operatorB))
      .send({ expectedVersion: waiting.body.version, status: 'COMPLETED' })
      .expect(200);
    expect(completed.body.completedAt).toBeTruthy();
    expect((await dashboard(tokens.operatorB)).completedThisWeek).toBe(
      beforeCompleted.completedThisWeek + 1,
    );
    const reopened = await request(app.getHttpServer())
      .patch(`/internal/communications/${created.body.id}/demand`)
      .set(auth(tokens.operatorB))
      .send({ expectedVersion: completed.body.version, status: 'OPEN' })
      .expect(200);
    expect(reopened.body.completedAt).toBeNull();
    expect((await dashboard(tokens.operatorB)).completedThisWeek).toBe(
      beforeCompleted.completedThisWeek,
    );
  });

  it('counts completed demands from Monday midnight in Manaus, not UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    try {
      const operatorB = await prisma.user.findUniqueOrThrow({
        where: { id: ids.operatorB },
      });
      const fakeClockToken = tokenFor(operatorB);
      const before = await dashboard(fakeClockToken);
      await Promise.all([
        seedCompletedDemand(
          '550e8400-e29b-41d4-a716-446655440012',
          '2026-10-12T02:00:00.000Z',
        ),
        seedCompletedDemand(
          '550e8400-e29b-41d4-a716-446655440013',
          '2026-10-12T04:00:00.000Z',
        ),
      ]);
      expect((await dashboard(fakeClockToken)).completedThisWeek).toBe(
        before.completedThisWeek + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a sanitized author snapshot after the creator is deleted', async () => {
    const created = await createDemand(
      tokens.operatorA,
      '550e8400-e29b-41d4-a716-446655440014',
    );
    await prisma.user.delete({ where: { id: ids.operatorA } });
    const detail = await request(app.getHttpServer())
      .get(`/internal/communications/${created.body.id}`)
      .set(auth(tokens.admin))
      .expect(200);
    expect(detail.body.author).toEqual({
      id: ids.operatorA,
      name: 'Autor A',
      email: 'a@test.local',
    });
    const events = detail.body.events as Array<{
      kind: string;
      author: Record<string, unknown>;
    }>;
    const createdEvent = events.find(
      (event: { kind: string }) => event.kind === 'CREATED',
    );
    expect(createdEvent).toBeDefined();
    if (!createdEvent) throw new Error('Evento CREATED ausente.');
    expect(createdEvent.author).toEqual(detail.body.author);
    expect(createdEvent.author).not.toHaveProperty('requestFingerprint');
  });

  function createDemand(
    token: string,
    clientRequestId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .post('/internal/communications')
      .set(auth(token))
      .send({
        kind: 'DEMAND',
        subject: 'Reposição urgente',
        message: 'Confirmar estoque do lote.',
        originSectorId: ids.sectorA,
        destinationSectorId: ids.sectorB,
        ccSectorIds: [ids.sectorC],
        priority: 'HIGH',
        dueDate: '2026-10-31',
        notifyTeam: true,
        notifyAssignee: true,
        clientRequestId,
        ...overrides,
      });
  }

  async function unread(token: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .get('/internal/unread-count')
      .set(auth(token))
      .expect(200);
    return response.body.count as number;
  }

  async function dashboard(
    token: string,
  ): Promise<{ completedThisWeek: number }> {
    const response = await request(app.getHttpServer())
      .get('/internal/dashboard')
      .set(auth(token))
      .expect(200);
    return response.body as { completedThisWeek: number };
  }

  function seedCompletedDemand(clientRequestId: string, completedAt: string) {
    return prisma.internalCommunication.create({
      data: {
        reference: `DM-${clientRequestId.slice(-4)}`,
        clientRequestId,
        kind: 'DEMAND',
        subject: 'Demanda concluída',
        message: 'Teste da semana civil.',
        authorId: ids.operatorB,
        authorSnapshot: {
          id: ids.operatorB,
          name: 'Operador B',
          email: 'b@test.local',
        },
        originSectorId: ids.sectorA,
        destinationSectorId: ids.sectorB,
        priority: 'NORMAL',
        status: 'COMPLETED',
        completedAt: new Date(completedAt),
      },
    });
  }
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function tokenFor(user: {
  id: string;
  email: string;
  role: string;
  sessionVersion: number;
}) {
  return new JwtService({ secret: process.env.JWT_SECRET }).sign({
    sub: user.id,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion,
  });
}

function configureEnvironment(
  postgres: StartedPostgreSqlContainer,
  redis: StartedRedisContainer,
) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_HOST: redis.getHost(),
    REDIS_PORT: String(redis.getMappedPort(6379)),
    JWT_SECRET: 'a'.repeat(32),
    APP_BASE_URL: 'http://localhost:5173',
    WEBHOOK_BASE_URL: 'http://localhost:3000',
    CORS_ORIGIN: 'http://localhost:5173',
    BULL_BOARD_USER: 'admin',
    BULL_BOARD_PASSWORD: randomUUID(),
    WHATSAPP_PROVIDER: 'evolution',
    EVOLUTION_API_KEY: 'test-evo-key',
    EVOLUTION_BASE_URL: 'http://localhost:8080',
    EVOLUTION_INSTANCE_NAME: 'test-evolution',
    META_ACCESS_TOKEN: 'test-meta-access-token',
    META_PHONE_NUMBER_ID: 'test-phone-number-id',
    META_APP_SECRET: 'test-app-secret-min-32-chars-yyyyy',
    META_WEBHOOK_VERIFY_TOKEN: 'verify-token',
  });
}

function deployMigrations(url: string) {
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      timeout: 60_000,
      stdio: 'pipe',
    },
  );
}

async function seed(prisma: PrismaService): Promise<Record<string, string>> {
  const password = await argon2.hash(PASSWORD);
  const [sectorA, sectorB, sectorC, sectorD] = await Promise.all([
    prisma.sector.create({ data: { name: 'Compras', code: 'COM' } }),
    prisma.sector.create({ data: { name: 'Estoque', code: 'EST' } }),
    prisma.sector.create({ data: { name: 'Financeiro', code: 'FIN' } }),
    prisma.sector.create({ data: { name: 'Jurídico', code: 'JUR' } }),
  ]);
  const [admin, operatorA, operatorB, operatorD, viewerB] = await Promise.all([
    prisma.user.create({
      data: {
        email: 'admin@test.local',
        password,
        role: 'ADMIN',
        isActive: true,
      },
    }),
    prisma.user.create({
      data: {
        email: 'a@test.local',
        password,
        name: 'Autor A',
        role: 'OPERATOR',
        sectorId: sectorA.id,
        isActive: true,
      },
    }),
    prisma.user.create({
      data: {
        email: 'b@test.local',
        password,
        role: 'OPERATOR',
        sectorId: sectorB.id,
        isActive: true,
      },
    }),
    prisma.user.create({
      data: {
        email: 'd@test.local',
        password,
        role: 'OPERATOR',
        sectorId: sectorD.id,
        isActive: true,
      },
    }),
    prisma.user.create({
      data: {
        email: 'viewer@test.local',
        password,
        role: 'VIEWER',
        sectorId: sectorB.id,
        isActive: true,
      },
    }),
  ]);
  return {
    sectorA: sectorA.id,
    sectorB: sectorB.id,
    sectorC: sectorC.id,
    sectorD: sectorD.id,
    admin: admin.id,
    operatorA: operatorA.id,
    operatorB: operatorB.id,
    operatorD: operatorD.id,
    viewerB: viewerB.id,
  };
}

async function loginAll(
  app: INestApplication,
): Promise<Record<string, string>> {
  const emails = {
    admin: 'admin@test.local',
    operatorA: 'a@test.local',
    operatorB: 'b@test.local',
    operatorD: 'd@test.local',
    viewerB: 'viewer@test.local',
  };
  const pairs = await Promise.all(
    Object.entries(emails).map(async ([key, email]) => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return [key, response.body.accessToken as string] as const;
    }),
  );
  return Object.fromEntries(pairs);
}
