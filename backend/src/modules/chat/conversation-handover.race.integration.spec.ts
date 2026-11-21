import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attendedBy,
  handoverActor,
  handoverInput,
  handoverService,
  settle,
} from './conversation-handover.test-fixtures';
import {
  at,
  auditRows,
  conversationRow,
  historyRows,
  holdConversationLock,
  ownershipService,
  startOwnershipDb,
  stopOwnershipDb,
  T0,
  waitForBlocked,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-handover.race.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = at(10);

let db: OwnershipDb;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
}, 180_000);

afterAll(() => stopOwnershipDb(db));

const actions = async (id: string) =>
  (await historyRows(db, id)).map((row) => row.action);

describe.skipIf(!ENABLED)(
  'handover × transferência — corrida (Molde B)',
  () => {
    it('transferência do ADMIN na fila antes da passagem — pulada other_assignee, sem SHIFT_HANDOVER', async () => {
      // Falha se a decisão (atendente = quem sai) for lida fora da trava: a
      // passagem veria a Ana e transferiria por cima da transferência do ADMIN.
      const id = await attendedBy(db, db.ids.ana);
      const lock = await holdConversationLock(db, id);
      try {
        const transferring = settle(
          ownershipService(db).service.assign(id, handoverActor(db, 'admin'), {
            userId: db.ids.bia,
            expectedAssigneeId: db.ids.ana,
          }),
        );
        await waitForBlocked(lock, 1);
        const { service, events } = handoverService(db);
        const handing = settle(
          service.handover(
            handoverActor(db, 'ana'),
            handoverInput(db.ids.admin, [id]),
            NOW,
          ),
        );
        await waitForBlocked(lock, 2);
        lock.release();
        const [transferred, handed] = await Promise.all([
          transferring,
          handing,
        ]);
        expect(transferred).toMatchObject({ value: { id } });
        expect(handed).toEqual({
          value: {
            transferred: [],
            skipped: [{ id, reason: 'other_assignee' }],
          },
        });
        expect(events.publish).not.toHaveBeenCalled();
      } finally {
        await lock.finish();
      }
      expect(await actions(id)).toEqual(['TRANSFERRED']);
      expect(await conversationRow(db, id)).toMatchObject({
        assignedUserId: db.ids.bia,
      });
    }, 30_000);
  },
);

describe.skipIf(!ENABLED)('handover × resolver — corrida (Molde B)', () => {
  it('resolver na fila antes da passagem — pulada resolved, sem SHIFT_HANDOVER, resolvedAt preservado', async () => {
    // Falha se `resolvedAt` for conferido fora da trava (a passagem transferiria
    // e reabriria a resolvida) ou se só o atendente for conferido (a resolvida
    // sem atendente sairia como `unassigned`).
    const id = await attendedBy(db, db.ids.ana);
    const lock = await holdConversationLock(db, id);
    try {
      const resolving = settle(
        ownershipService(db).service.resolve(id, handoverActor(db, 'ana'), {
          expectedAssigneeId: db.ids.ana,
          expectedLastInboundAt: T0.toISOString(),
        }),
      );
      await waitForBlocked(lock, 1);
      const { service } = handoverService(db);
      const handing = settle(
        service.handover(
          handoverActor(db, 'ana'),
          handoverInput(db.ids.bia, [id]),
          NOW,
        ),
      );
      await waitForBlocked(lock, 2);
      lock.release();
      const [resolved, handed] = await Promise.all([resolving, handing]);
      expect(resolved).toMatchObject({ value: { id } });
      expect(handed).toEqual({
        value: { transferred: [], skipped: [{ id, reason: 'resolved' }] },
      });
    } finally {
      await lock.finish();
    }
    expect(await actions(id)).toEqual(['RESOLVED']);
    const row = await conversationRow(db, id);
    expect(row.resolvedAt).not.toBeNull();
    expect(row.assignedUserId).toBeNull();
  }, 30_000);
});

describe.skipIf(!ENABLED)('handover × handover — corrida (Molde B)', () => {
  it('duas passagens iguais simultâneas — uma transfere, a outra already_with_target; uma linha SHIFT_HANDOVER', async () => {
    // Falha se a conferência for feita sem a trava: as duas veriam a Ana e
    // gravariam duas linhas SHIFT_HANDOVER e duas trilhas.
    const id = await attendedBy(db, db.ids.ana);
    const { service } = handoverService(db);
    const handover = (now: Date) =>
      service.handover(
        handoverActor(db, 'ana'),
        handoverInput(db.ids.bia, [id]),
        now,
      );
    const lock = await holdConversationLock(db, id);
    try {
      const first = settle(handover(NOW));
      await waitForBlocked(lock, 1);
      const second = settle(handover(at(11)));
      await waitForBlocked(lock, 2);
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toEqual({ value: { transferred: [{ id }], skipped: [] } });
      expect(two).toEqual({
        value: {
          transferred: [],
          skipped: [{ id, reason: 'already_with_target' }],
        },
      });
    } finally {
      await lock.finish();
    }
    expect(await actions(id)).toEqual(['SHIFT_HANDOVER']);
    expect(await auditRows(db, id)).toHaveLength(1);
  }, 30_000);
});

describe.skipIf(!ENABLED)(
  'handover — uma transação por conversa (Molde B)',
  () => {
    it('trava externa na conversa 2 — a passagem já gravou a 1 antes de bloquear na 2', async () => {
      // Falha se a passagem usar uma transação com N travas: a gravação da 1
      // ficaria sem commit enquanto a passagem espera a 2, e a leitura abaixo
      // ainda veria a Ana como atendente.
      const first = await attendedBy(db, db.ids.ana);
      const second = await attendedBy(db, db.ids.ana);
      const lock = await holdConversationLock(db, second);
      const { service } = handoverService(db);
      try {
        const handing = settle(
          service.handover(
            handoverActor(db, 'ana'),
            handoverInput(db.ids.bia, [first, second]),
            NOW,
          ),
        );
        await waitForBlocked(lock, 1);
        expect(await conversationRow(db, first)).toMatchObject({
          assignedUserId: db.ids.bia,
        });
        expect(await actions(first)).toEqual(['SHIFT_HANDOVER']);
        lock.release();
        expect(await handing).toEqual({
          value: { transferred: [{ id: first }, { id: second }], skipped: [] },
        });
      } finally {
        await lock.finish();
      }
    }, 30_000);
  },
);
