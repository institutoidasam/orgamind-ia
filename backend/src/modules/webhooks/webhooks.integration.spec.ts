import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
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
 *   - HMAC signature validation (rejects invalid, accepts valid).
 *   - Raw body propagation through Nest's JSON body parser.
 *   - GET verify-challenge handshake.
 *   - End-to-end wiring: AppModule + Postgres (Testcontainers) + Redis (Testcontainers).
 *
 * Opt-in only - Testcontainers requires Docker. To run locally:
 *   TESTCONTAINERS_ENABLED=1 bun run test src/modules/webhooks/webhooks.integration.spec.ts
 */
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const APP_SECRET = 'test-app-secret-min-32-chars-yyyyy';

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
    process.env.META_ACCESS_TOKEN = 'test-meta-access-token';
    process.env.META_PHONE_NUMBER_ID = 'test-phone-number-id';
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-token';
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

  it('rejects POST with invalid signature', async () => {
    // object: 'whatsapp_business_account' is what makes the controller
    // recognize this as a Meta-shaped payload and run the HMAC check at all
    // (payload-based routing — see webhooks.controller.ts).
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('accepts POST with valid signature', async () => {
    const payload = { object: 'whatsapp_business_account', entry: [] };
    const body = JSON.stringify(payload);
    const sig =
      'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('GET verify-challenge returns the challenge with correct token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'CHAL',
      });
    expect(res.status).toBe(200);
    expect(res.text).toBe('CHAL');
  });

  it('GET verify-challenge rejects an incorrect token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'CHAL',
      });
    expect(res.status).toBe(400);
  });
});
