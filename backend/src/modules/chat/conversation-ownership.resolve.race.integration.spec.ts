import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditRows,
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
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-ownership.resolve.race.integration.spec.ts
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

describe.skipIf(!ENABLED)('resolve — corrida (GK11, Molde B)', () => {
  it('dois Resolver simultâneos na mesma conversa — o primeiro grava, o segundo 409 conversation_changed; uma linha RESOLVED', async () => {
    // Falha se a conferência ler a linha sem a trava (FOR NO KEY UPDATE): os dois
    // veriam a conversa aberta com a ana e o segundo gravaria outra linha RESOLVED
    // (ou o poll não veria as duas sessões esperando a trava e estouraria em 5 s).
    const { service, events } = ownershipService(db);
    const id = await newConversation(db, {
      assignedUserId: db.ids.ana,
      assignedAt: T0,
    });
    const ana = { id: db.ids.ana, role: 'OPERATOR' };
    const admin = { id: db.ids.admin, role: 'ADMIN' };
    const body = {
      expectedAssigneeId: db.ids.ana,
      expectedLastInboundAt: T0.toISOString(),
    };
    const lock = await holdConversationLock(db, id);
    try {
      const first = settle(service.resolve(id, ana, body));
      await waitForBlocked(lock, 1);
      const second = settle(service.resolve(id, admin, body));
      await waitForBlocked(lock, 2);
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toMatchObject({ value: { status: 'RESOLVED' } });
      expect(two).toMatchObject({
        error: { status: 409, code: 'chat.conversation_changed' },
      });
    } finally {
      await lock.finish();
    }
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'RESOLVED', actorId: db.ids.ana },
    ]);
    expect(await auditRows(db, id)).toHaveLength(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
  }, 30_000);
});
