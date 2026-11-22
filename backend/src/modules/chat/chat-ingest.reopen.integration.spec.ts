import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { ChatEventsService } from './chat-events.service';
import { ChatIngestService } from './chat-ingest.service';
import {
  at,
  auditRows,
  conversationRow,
  historyRows,
  holdConversationLock,
  newConversation,
  ownershipService,
  startOwnershipDb,
  stopOwnershipDb,
  T0,
  waitForAnyLockWait,
  waitForBlocked,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/**
 * K1-4 pelo caminho real de ingestão (webhook Evolution → `ChatIngestService`),
 * Postgres e Redis reais. Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/chat-ingest.reopen.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
/** Instante explícito da mensagem (GK8): sempre depois do T0 da conversa. */
const RECEIVED_AT = at(10);
const API_KEY = 'test-evo-key';
const INSTANCE_NAME = 'k1-reopen-test';

let db: OwnershipDb;
let redis: StartedRedisContainer;
let app: INestApplication;
let instanceId: string;
let ingest: ChatIngestService;
let publish: MockInstance<ChatEventsService['publish']>;
let seq = 0;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
  redis = await new RedisContainer('redis:7-alpine').start();
  Object.assign(process.env, {
    WHATSAPP_PROVIDER: 'evolution',
    EVOLUTION_API_KEY: API_KEY,
    EVOLUTION_BASE_URL: 'http://localhost:8080', // nunca chamado neste teste
    EVOLUTION_INSTANCE_NAME: 'picoa-test',
    DATABASE_URL: db.postgres.getConnectionUri(),
    REDIS_HOST: redis.getHost(),
    REDIS_PORT: String(redis.getMappedPort(6379)),
    JWT_SECRET: 'a'.repeat(32),
    META_ACCESS_TOKEN: 'test-meta-access-token',
    META_PHONE_NUMBER_ID: 'test-phone-number-id',
    META_APP_SECRET: 'test-app-secret-min-32-chars-yyyyy',
    META_WEBHOOK_VERIFY_TOKEN: 'verify-token',
    APP_BASE_URL: 'http://localhost:5173',
    WEBHOOK_BASE_URL: 'http://localhost:3000',
    CORS_ORIGIN: 'http://localhost:5173',
    BULL_BOARD_USER: 'admin',
    BULL_BOARD_PASSWORD: 'b'.repeat(12),
  });
  const { AppModule } =
    (await import('../../app.module')) as typeof import('../../app.module');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  publish = vi.spyOn(app.get(ChatEventsService), 'publish');
  ingest = app.get(ChatIngestService);
  const channel = await db.prisma.channel.create({
    data: {
      name: 'Canal K1',
      evolutionInstanceName: INSTANCE_NAME,
      apiKey: 'x',
      isActive: true,
    },
    select: { id: true },
  });
  instanceId = channel.id;
}, 180_000);

beforeEach(() => {
  publish?.mockClear();
});

afterAll(async () => {
  await app?.close();
  await redis?.stop();
  await stopOwnershipDb(db);
}, 60_000);

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Celular fictício (13 dígitos) distinto por conversa. */
const personJid = () =>
  `559299111${String((seq += 1)).padStart(4, '0')}@s.whatsapp.net`;

/** Conversa da pessoa no canal do teste: resolvida e sem atendente, ou com os campos de `over`. */
const personConversation = (over: object = { resolvedAt: T0 }) =>
  newConversation(db, { instanceId, remoteJid: personJid(), ...over });

const evolutionPayload = (jid: string, fromMe: boolean, text: string) => ({
  event: 'messages.upsert',
  instance: INSTANCE_NAME,
  data: {
    key: { remoteJid: jid, fromMe, id: `K1-REOPEN-${(seq += 1)}` },
    pushName: 'Pessoa Teste',
    message: { conversation: text },
    messageTimestamp: Math.floor(RECEIVED_AT.getTime() / 1000),
  },
});

/** Webhook real; só devolve o status (a corrida precisa largar a chamada sem aguardar). */
async function postWebhook(jid: string, fromMe: boolean): Promise<number> {
  const res = await request(
    app.getHttpServer() as Parameters<typeof request>[0],
  )
    .post('/webhooks/whatsapp')
    .set('apikey', API_KEY)
    .send(evolutionPayload(jid, fromMe, 'Olá, preciso de ajuda'));
  return res.status;
}

const conversationOf = async (id: string) => ({
  row: await conversationRow(db, id),
  history: await historyRows(db, id),
  messages: await db.prisma.message.count({ where: { conversationId: id } }),
});

const updatedEvents = (id: string) =>
  publish.mock.calls.filter(
    ([event]) =>
      (event as { type: string; conversationId: string }).type ===
        'conversation.updated' &&
      (event as { conversationId: string }).conversationId === id,
  );

describe.skipIf(!ENABLED)('ingestão reabre a conversa resolvida (K1-4)', () => {
  it('aceite 4: mensagem ao vivo numa resolvida — Pendente, sem atendente, Sistema no histórico, conversation.updated publicado', async () => {
    const id = await personConversation();
    const { remoteJid } = await conversationRow(db, id);

    expect(await postWebhook(remoteJid, false)).toBe(200);

    const { row, history, messages } = await conversationOf(id);
    expect(row).toMatchObject({
      resolvedAt: null,
      assignedUserId: null,
      botPausedAt: null,
      unreadCount: 1,
    });
    expect(row.lastInboundAt).toEqual(RECEIVED_AT);
    expect(history).toMatchObject([{ action: 'REOPENED', actorId: null }]);
    expect(await auditRows(db, id)).toHaveLength(0);
    expect(messages).toBe(1);
    expect(updatedEvents(id)).toEqual([
      [{ type: 'conversation.updated', conversationId: id, instanceId }],
    ]);
  }, 30_000);
});

describe.skipIf(!ENABLED)('importação e eco não reabrem (K1-4)', () => {
  it('aceite 4: importação (backfill) numa resolvida — continua resolvida', async () => {
    const id = await personConversation();
    const { remoteJid } = await conversationRow(db, id);
    const old = {
      providerMessageId: `K1-BACKFILL-${(seq += 1)}`,
      remoteJid,
      phoneE164: null,
      isGroup: false,
      fromMe: false,
      kind: 'TEXT' as const,
      text: 'Mensagem antiga',
      receivedAt: at(30),
    };

    expect(
      await ingest.ingestMessages([old], instanceId, { backfill: true }),
    ).toBe(1);

    const { row, history, messages } = await conversationOf(id);
    expect(row.resolvedAt).toEqual(T0);
    expect(history).toHaveLength(0);
    expect(messages).toBe(1);
    expect(updatedEvents(id)).toHaveLength(0);
  }, 30_000);

  it('aceite 4: eco de mensagem enviada numa resolvida — continua resolvida', async () => {
    const id = await personConversation();
    const { remoteJid } = await conversationRow(db, id);

    expect(await postWebhook(remoteJid, true)).toBe(200);

    const { row, history, messages } = await conversationOf(id);
    expect(row.resolvedAt).toEqual(T0);
    expect(row.lastInboundAt).toEqual(T0);
    expect(history).toHaveLength(0);
    expect(messages).toBe(1);
    expect(updatedEvents(id)).toHaveLength(0);
  }, 30_000);
});

describe.skipIf(!ENABLED)('ingestão × Resolver (GK11, Molde B)', () => {
  it('aceite 3: Resolver bloqueado antes da mensagem — Resolver 200, depois a ingestão reabre; mensagem existe e conversa aberta', async () => {
    // Falha se a ingestão não reabrir na transação que avança lastInboundAt: o
    // Resolver (com o lastInboundAt antigo, T0) grava primeiro e a mensagem
    // ficaria numa conversa resolvida que ninguém vê.
    const { service } = ownershipService(db);
    const id = await personConversation({
      assignedUserId: db.ids.ana,
      assignedAt: T0,
    });
    const { remoteJid } = await conversationRow(db, id);
    const lock = await holdConversationLock(db, id);
    let resolved: Awaited<ReturnType<typeof settle>>;
    let ingestion: Awaited<ReturnType<typeof settle>>;
    try {
      const resolver = settle(
        service.resolve(
          id,
          { id: db.ids.ana, role: 'OPERATOR' },
          {
            expectedAssigneeId: db.ids.ana,
            expectedLastInboundAt: T0.toISOString(),
          },
        ),
      );
      await waitForBlocked(lock, 1);
      const webhook = settle(postWebhook(remoteJid, false));
      await waitForAnyLockWait(db, 2);
      lock.release();
      [resolved, ingestion] = await Promise.all([resolver, webhook]);
    } finally {
      await lock.finish();
    }

    expect(resolved).toMatchObject({ value: { status: 'RESOLVED' } });
    expect(ingestion).toEqual({ value: 200 });
    const { row, history, messages } = await conversationOf(id);
    expect(row).toMatchObject({ resolvedAt: null, assignedUserId: null });
    expect(row.lastInboundAt).toEqual(RECEIVED_AT);
    expect(history).toMatchObject([
      { action: 'RESOLVED', actorId: db.ids.ana },
      { action: 'REOPENED', actorId: null },
    ]);
    expect(messages).toBe(1);
    expect(updatedEvents(id)).toHaveLength(1);
  }, 30_000);
});
