import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';

/**
 * Integration test exercising:
 *   - Evolution apikey validation (rejects invalid, accepts valid).
 *   - Rotas de webhook desligadas (Meta, Twilio/Zernio/GoZap): 404 (R5).
 *   - End-to-end wiring: AppModule + Postgres (Testcontainers) + Redis (Testcontainers).
 *
 * Opt-in only - Testcontainers requires Docker. To run locally:
 *   TESTCONTAINERS_ENABLED=1 bun run test src/modules/webhooks/webhooks.integration.spec.ts
 */
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const EVOLUTION_KEY = 'test-evolution-api-key-min-16';

describe.skipIf(!TESTCONTAINERS_ENABLED)('Webhooks (integration)', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('picoa_test')
      .withUsername('picoa')
      .withPassword('picoa')
      .start();

    redis = await new RedisContainer('redis:7-alpine').start();

    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getMappedPort(6379));
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.EVOLUTION_BASE_URL = 'http://localhost:8080';
    process.env.EVOLUTION_API_KEY = EVOLUTION_KEY;
    process.env.EVOLUTION_INSTANCE_NAME = 'test-instance';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.WEBHOOK_BASE_URL = 'http://localhost:3000';
    process.env.CORS_ORIGIN = 'http://localhost:5173';
    process.env.BULL_BOARD_USER = 'admin';
    process.env.BULL_BOARD_PASSWORD = 'changeme123';

    // Run migrations against the freshly-spun test Postgres.
    // execFileSync (not exec) - no shell, no injection risk.
    execFileSync('bunx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
    });

    const appModule =
      (await import('../../app.module')) as typeof import('../../app.module');
    const { AppModule } = appModule;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  const evolutionBody = { event: 'messages.upsert', data: {} };

  it('rejects an Evolution POST with a wrong apikey', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set('apikey', 'wrong-key')
      .send(evolutionBody);
    expect(res.status).toBe(401);
  });

  it('accepts an Evolution POST with the right apikey', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set('apikey', EVOLUTION_KEY)
      .send(evolutionBody);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('POST /webhooks/whatsapp with a Meta payload → 404', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send({ object: 'whatsapp_business_account', entry: [] });
    expect(res.status).toBe(404);
  });

  it('GET /webhooks/whatsapp (Meta handshake) → 404', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'CHAL',
      });
    expect(res.status).toBe(404);
  });

  it.each(['twilio', 'zernio', 'gozap'])(
    'POST /webhooks/%s → 404',
    async (provider) => {
      const res = await request(app.getHttpServer() as Server)
        .post(`/webhooks/${provider}`)
        .send({});
      expect(res.status).toBe(404);
    },
  );
});
