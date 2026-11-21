import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-assign.race.integration.spec.ts
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

const operator = (key: 'ana' | 'bia') => ({
  id: db.ids[key],
  role: 'OPERATOR',
});

describe.skipIf(!ENABLED)('assign — corrida (GK11, Molde B)', () => {
  it('dois Assumir na mesma conversa Pendente — o primeiro grava, o segundo 409 conversation_changed com o primeiro como atendente; uma linha ASSUMED', async () => {
    // Falha se a conferência ler a linha sem a trava (FOR NO KEY UPDATE): os dois
    // veriam a conversa Pendente e o segundo gravaria outra linha ASSUMED (ou o
    // poll não veria as duas sessões esperando a trava e estouraria em 5 s).
    const { service, events } = ownershipService(db);
    const id = await newConversation(db);
    const take = (key: 'ana' | 'bia') =>
      service.assign(id, operator(key), {
        userId: db.ids[key],
        expectedAssigneeId: null,
      });
    const lock = await holdConversationLock(db, id);
    try {
      const first = settle(take('ana'));
      await waitForBlocked(lock, 1);
      const second = settle(take('bia'));
      await waitForBlocked(lock, 2);
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toMatchObject({ value: { assignedUserId: db.ids.ana } });
      expect(two).toMatchObject({
        error: { status: 409, code: 'chat.conversation_changed' },
      });
      expect(
        JSON.parse((two as { error: { detail: string } }).error.detail),
      ).toEqual({
        assignee: { id: db.ids.ana, name: 'Ana Atendente', active: true },
      });
    } finally {
      await lock.finish();
    }
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'ASSUMED', actorId: db.ids.ana },
    ]);
    expect(await conversationRow(db, id)).toMatchObject({
      assignedUserId: db.ids.ana,
    });
    expect(await auditRows(db, id)).toHaveLength(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe.skipIf(!ENABLED)('assign × resolve — corrida (GK11, Molde B)', () => {
  it('Resolver (T4a) bloqueado × transferência na fila — a transferência vê resolvida e expected diferente: 409', async () => {
    const { service, events } = ownershipService(db);
    const id = await newConversation(db, {
      assignedUserId: db.ids.ana,
      assignedAt: T0,
    });
    const lock = await holdConversationLock(db, id);
    try {
      const resolving = settle(
        service.resolve(id, operator('ana'), {
          expectedAssigneeId: db.ids.ana,
          expectedLastInboundAt: T0.toISOString(),
        }),
      );
      await waitForBlocked(lock, 1);
      const transferring = settle(
        service.assign(id, operator('ana'), {
          userId: db.ids.bia,
          expectedAssigneeId: db.ids.ana,
        }),
      );
      await waitForBlocked(lock, 2);
      lock.release();
      const [resolved, transferred] = await Promise.all([
        resolving,
        transferring,
      ]);
      expect(resolved).toMatchObject({ value: { status: 'RESOLVED' } });
      expect(transferred).toMatchObject({
        error: { status: 409, code: 'chat.conversation_changed' },
      });
    } finally {
      await lock.finish();
    }
    expect(await historyRows(db, id)).toMatchObject([{ action: 'RESOLVED' }]);
    expect(await conversationRow(db, id)).toMatchObject({
      assignedUserId: null,
      botPausedAt: null,
    });
    expect(events.publish).toHaveBeenCalledTimes(1);
  }, 30_000);
});
