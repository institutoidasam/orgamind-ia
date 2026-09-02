import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import request from 'supertest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Integration test exercising the full webhook → DB persistence pipeline:
 *   - Inbound MESSAGES_UPSERT webhook (Evolution provider).
 *   - Conversation + Message rows created in real Postgres (Testcontainers).
 *   - unreadCount incremented, content and status persisted correctly.
 *
 * Opt-in only — Testcontainers requires Docker. To run locally:
 *   TESTCONTAINERS_ENABLED=1 bun run test src/modules/chat/chat-ingest.integration.spec.ts
 */
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

describe.skipIf(!TESTCONTAINERS_ENABLED)('Chat ingest (integration)', () => {
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

    // Evolution provider — must be set before AppModule loads so ConfigService
    // and WhatsappProvidersService pick up the correct provider.
    process.env.WHATSAPP_PROVIDER = 'evolution';
    process.env.EVOLUTION_API_KEY = 'test-evo-key';
    process.env.EVOLUTION_API_URL = 'http://localhost:8080'; // not called in this test

    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getMappedPort(6379));
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.META_APP_SECRET = 'test-app-secret-min-32-chars-yyyyy';
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-token';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.WEBHOOK_BASE_URL = 'http://localhost:3000';
    process.env.CORS_ORIGIN = 'http://localhost:5173';
    process.env.BULL_BOARD_USER = 'admin';
    process.env.BULL_BOARD_PASSWORD = 'changeme123';

    // Run migrations against the freshly-spun test Postgres.
    // Prefer bunx; fall back to the local binary if bunx is unavailable.
    const prismaCliArgs = ['prisma', 'migrate', 'deploy'];
    const hasBunx = (() => {
      try {
        execFileSync('bunx', ['--version'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();

    if (hasBunx) {
      execFileSync('bunx', prismaCliArgs, {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
      });
    } else {
      const localPrisma = 'node_modules/.bin/prisma';
      execFileSync(existsSync(localPrisma) ? localPrisma : 'npx', [
        ...(existsSync(localPrisma) ? [] : ['prisma']),
        'migrate',
        'deploy',
      ], {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
      });
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  }, 60_000);

  it('persists a Conversation and Message when an inbound MESSAGES_UPSERT webhook arrives', async () => {
    const prisma = app.get(PrismaService);

    // Seed a WhatsappInstance so the controller resolves the instance name.
    const instance = await prisma.channel.create({
      data: {
        name: 'Test Inbox',
        evolutionInstanceName: 'picoa-inbox-test',
        apiKey: 'x',
        isActive: true,
      },
    });

    const payload = {
      event: 'messages.upsert',
      instance: 'picoa-inbox-test',
      data: {
        key: {
          remoteJid: '5592999999999@s.whatsapp.net',
          fromMe: false,
          id: 'INTEG-1',
        },
        pushName: 'Maria',
        message: { conversation: 'Olá inbox' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };

    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .set('apikey', 'test-evo-key')
      .send(payload);

    expect(res.status).toBe(200);

    // The ingest runs synchronously inside webhooks.process which the controller
    // awaits, so by the time the POST resolves the rows must already exist.
    const conv = await prisma.conversation.findFirst({
      where: { remoteJid: '5592999999999@s.whatsapp.net', instanceId: instance.id },
    });
    expect(conv).not.toBeNull();
    expect(conv!.unreadCount).toBe(1);

    const msg = await prisma.message.findFirst({
      where: { conversationId: conv!.id, direction: 'INBOUND' },
    });
    expect(msg?.content).toBe('Olá inbox');
    expect(msg?.status).toBe('RECEIVED');
  });
});
