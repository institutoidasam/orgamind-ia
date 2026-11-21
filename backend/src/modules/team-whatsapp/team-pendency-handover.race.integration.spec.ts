import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForBlocked } from '../chat/conversation-ownership.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  at,
  holdRecipientLock,
  startPendencyDb,
  stopPendencyDb,
  waitForAnyLockWait,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import {
  heldBy,
  readers,
  setupHandling,
} from './team-pendency.handling.test-fixtures';
import { TeamPendencyHandoverService } from './team-pendency-handover.service';
import { PENDENCY_TX_OPTIONS } from './team-pendency-write.repository';
import { recordAlertReply } from './tracking/team-alert-reply';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-handover.race.integration.spec.ts
 *
 * Molde B (GT10, DK23): trava externa na linha do destinatário, comandos
 * disparados sem `await` e esperados na fila de trava, solta a trava e só então
 * o `await`. Isolamento padrão (READ COMMITTED).
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOTE = 'Passei o turno às 18h';

let db: PendencyDb;
let scenario: Awaited<ReturnType<typeof setupHandling>>;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  scenario = await setupHandling(db);
}, 180_000);

afterAll(() => stopPendencyDb(db));

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Passagem do gestor ao outro ADMIN, em `at(20)` (depois da ciência de `at(12)`). */
const handoverOf = (id: string) =>
  new TeamPendencyHandoverService(
    db.prisma as unknown as PrismaService,
    db.audit,
  ).handover(
    scenario.manager.id,
    { toUserId: scenario.otherAdmin.id, note: NOTE, pendencyIds: [id] },
    at(20),
  );

/** Ciência por palavra, como a ingestão a entrega (`isAck`), recebida em `at(12)`. */
const ackReply = (tx: Parameters<typeof recordAlertReply>[0], id: string) =>
  recordAlertReply(tx, {
    originalId: id,
    messageId: 'wamid-k3-handover',
    receivedAt: at(12),
    isAck: true,
  });

describe.skipIf(!ENABLED)('passagem de pendências — com a ciência', () => {
  it('ciência automática (em $transaction) na fila antes da passagem — pulada acked; sem anotação nem trilha', async () => {
    // Falha se a conferência lesse a linha sem a trava: a passagem veria `ackAt`
    // nulo e gravaria o destino sobre a pendência já ciente.
    const { rowOf, notesOf, trailOf } = readers(db);
    const id = await scenario.seed(heldBy(scenario.manager.id));
    const lock = await holdRecipientLock(db, id);
    try {
      const ack = settle(
        db.prisma.$transaction((tx) => ackReply(tx, id), PENDENCY_TX_OPTIONS),
      );
      await waitForAnyLockWait(db, 1);
      const handover = settle(handoverOf(id));
      await waitForAnyLockWait(db, 2);
      lock.release();
      const [acked, handed] = await Promise.all([ack, handover]);
      expect(acked).toEqual({ value: undefined });
      expect(handed).toEqual({
        value: { transferred: [], skipped: [{ id, reason: 'acked' }] },
      });
    } finally {
      await lock.finish();
    }
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: scenario.manager.id,
      ackAt: at(12),
    });
    expect(await notesOf(id)).toEqual([]);
    expect(await trailOf(id)).toEqual([]);
  }, 30_000);
});

describe.skipIf(!ENABLED)('passagem de pendências — dois pedidos', () => {
  it('duas passagens iguais simultâneas — uma transfere, a outra já estava com o destino; uma anotação HANDOVER', async () => {
    // Falha se o responsável fosse conferido sem a trava (as duas transfeririam e
    // haveria duas anotações e duas trilhas) ou se a gravação fosse condicionada
    // só à leitura anterior.
    const { rowOf, notesOf, trailOf } = readers(db);
    const id = await scenario.seed(heldBy(scenario.manager.id));
    const lock = await holdRecipientLock(db, id);
    try {
      const first = settle(handoverOf(id));
      await waitForBlocked(lock, 1);
      const second = settle(handoverOf(id));
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
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: scenario.otherAdmin.id,
      pendencyAssignedAt: at(20),
      pendencyDueAt: at(80),
    });
    expect(await notesOf(id)).toHaveLength(1);
    expect(await trailOf(id)).toHaveLength(1);
  }, 30_000);
});
