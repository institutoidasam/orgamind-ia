import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyInboundUpdate } from './conversation-inbound';
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
  waitForBlocked,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-inbound.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: OwnershipDb;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
}, 180_000);

afterAll(() => stopOwnershipDb(db));

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** A atualização final que a ingestão faz hoje para uma mensagem nova da pessoa. */
const liveData = (minute: number) => ({
  lastMessageAt: at(minute),
  lastMessagePreview: 'Oi',
  lastMessageDirection: 'INBOUND' as const,
  lastInboundAt: at(minute),
  unreadCount: { increment: 1 },
});

const inbound = (id: string, reopenIfResolved: boolean, minute = 5) =>
  applyInboundUpdate(db.prisma as never, {
    conversationId: id,
    data: liveData(minute),
    reopenIfResolved,
  });

describe.skipIf(!ENABLED)('applyInboundUpdate (DK9, banco real)', () => {
  it('reopenIfResolved falso — mesmo update de hoje, resolvida continua resolvida', async () => {
    const id = await newConversation(db, { resolvedAt: T0 });

    expect(await inbound(id, false)).toEqual({ reopened: false });

    expect(await conversationRow(db, id)).toMatchObject({
      resolvedAt: T0,
      lastInboundAt: at(5),
      lastMessagePreview: 'Oi',
      unreadCount: 1,
    });
    expect(await historyRows(db, id)).toHaveLength(0);
  });

  it('aceite 4: resolvida + ao vivo — resolvedAt nulo, lastInboundAt novo, linha REOPENED sem autor, reopened true', async () => {
    const id = await newConversation(db, { resolvedAt: T0 });

    expect(await inbound(id, true)).toEqual({ reopened: true });

    expect(await conversationRow(db, id)).toMatchObject({
      resolvedAt: null,
      assignedUserId: null,
      lastInboundAt: at(5),
      unreadCount: 1,
    });
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'REOPENED', actorId: null, fromUserId: null, toUserId: null },
    ]);
    expect(await auditRows(db, id)).toHaveLength(0);
  });
});

describe.skipIf(!ENABLED)(
  'applyInboundUpdate: conversa aberta e robô (DK9)',
  () => {
    it('aberta + ao vivo — nenhuma linha, reopened false', async () => {
      const id = await newConversation(db, {
        assignedUserId: db.ids.ana,
        assignedAt: T0,
      });

      expect(await inbound(id, true)).toEqual({ reopened: false });

      expect(await conversationRow(db, id)).toMatchObject({
        resolvedAt: null,
        assignedUserId: db.ids.ana,
        lastInboundAt: at(5),
      });
      expect(await historyRows(db, id)).toHaveLength(0);
    });

    it('aceite 9: botPausedAt não muda', async () => {
      const paused = await newConversation(db, {
        resolvedAt: T0,
        botPausedAt: at(1),
      });
      const running = await newConversation(db, { resolvedAt: T0 });

      await inbound(paused, true);
      await inbound(running, true);

      expect((await conversationRow(db, paused)).botPausedAt).toEqual(at(1));
      expect((await conversationRow(db, running)).botPausedAt).toBeNull();
    });
  },
);

describe.skipIf(!ENABLED)(
  'applyInboundUpdate × Resolver (GK11, Molde B)',
  () => {
    it('aceite 3: applyInboundUpdate bloqueado antes do Resolver — o Resolver com o lastInboundAt antigo recebe 409 e a conversa fica aberta', async () => {
      // Falha se a reabertura não estiver na transação travada que avança
      // lastInboundAt: sem o FOR NO KEY UPDATE o poll não vê a sessão da ingestão
      // esperando (estoura em 5 s), e uma gravação separada deixaria o Resolver
      // gravar sobre o lastInboundAt antigo (200) numa conversa que já recebeu a mensagem.
      const { service } = ownershipService(db);
      const id = await newConversation(db, {
        assignedUserId: db.ids.ana,
        assignedAt: T0,
      });
      const ana = { id: db.ids.ana, role: 'OPERATOR' };
      const lock = await holdConversationLock(db, id);
      try {
        const ingestion = settle(inbound(id, true));
        await waitForBlocked(lock, 1);
        const resolver = settle(
          service.resolve(id, ana, {
            expectedAssigneeId: db.ids.ana,
            expectedLastInboundAt: T0.toISOString(),
          }),
        );
        await waitForBlocked(lock, 2);
        lock.release();
        const [first, second] = await Promise.all([ingestion, resolver]);
        expect(first).toEqual({ value: { reopened: false } });
        expect(second).toMatchObject({
          error: { status: 409, code: 'chat.conversation_changed' },
        });
      } finally {
        await lock.finish();
      }
      expect(await conversationRow(db, id)).toMatchObject({
        resolvedAt: null,
        assignedUserId: db.ids.ana,
        lastInboundAt: at(5),
      });
      expect(await historyRows(db, id)).toHaveLength(0);
    }, 30_000);
  },
);
