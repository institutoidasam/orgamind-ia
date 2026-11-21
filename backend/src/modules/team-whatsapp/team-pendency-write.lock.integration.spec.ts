import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForBlocked } from '../chat/conversation-ownership.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  at,
  holdRecipientLock,
  newAlert,
  newPendency,
  startPendencyDb,
  stopPendencyDb,
  waitForAnyLockWait,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import { pendencySituation } from './team-pendency.rules';
import {
  runPendencyTransition,
  type PendencyTransition,
} from './team-pendency-write.repository';
import { recordAlertReply } from './tracking/team-alert-reply';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-write.lock.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let dispatchId = '';

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  dispatchId = await newAlert(db, { authorId: db.ids.admin, createdAt: at(0) });
}, 180_000);

afterAll(() => stopPendencyDb(db));

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Assumir sem responsável por `actorId`, esperando a pendência ainda aberta e livre. */
function assumeBy(recipientId: string, actorId: string): PendencyTransition {
  return {
    recipientId,
    actorId,
    now: at(10),
    action: 'team_whatsapp.pendency_assume',
    kind: 'assume',
    expect: { handlerId: null, closed: false },
    patch: { handlerId: actorId, assignedAt: at(10), dueAt: at(70) },
    note: null,
    handlerState: { before: null, after: 'active' },
  };
}

const prismaService = () => db.prisma as unknown as PrismaService;
const transition = (t: PendencyTransition) =>
  runPendencyTransition(prismaService(), db.audit, t);

describe.skipIf(!ENABLED)(
  'núcleo de escrita da pendência — trava (GK11, Molde B)',
  () => {
    it('com a linha travada por fora, a transição espera e depois confere o estado novo (handler_changed)', async () => {
      // Falha se a conferência ler a linha sem a trava (FOR NO KEY UPDATE): as duas
      // transições veriam a pendência sem responsável e a segunda sobrescreveria a
      // primeira (ou o poll não veria as duas sessões esperando e estouraria em 5 s).
      const id = await newPendency(db, { dispatchId });
      const lock = await holdRecipientLock(db, id);
      try {
        const first = settle(transition(assumeBy(id, db.ids.ana)));
        await waitForBlocked(lock, 1);
        const second = settle(transition(assumeBy(id, db.ids.bia)));
        await waitForBlocked(lock, 2);
        lock.release();
        const [one, two] = await Promise.all([first, second]);
        expect(one).toMatchObject({ value: { ok: true } });
        expect(two).toMatchObject({
          value: {
            ok: false,
            conflict: 'handler_changed',
            current: { handlerId: db.ids.ana },
          },
        });
      } finally {
        await lock.finish();
      }
      const row = await db.prisma.teamWhatsappRecipient.findUniqueOrThrow({
        where: { id },
      });
      expect(row.pendencyHandlerId).toBe(db.ids.ana);
      const trail = await db.prisma.auditEvent.findMany({
        where: { entity: 'TeamWhatsappRecipient', entityId: id },
      });
      expect(trail).toHaveLength(1);
    }, 30_000);
  },
);

describe.skipIf(!ENABLED)(
  'núcleo de escrita da pendência — ciência na fila (GK11, DK23)',
  () => {
    it('recordAlertReply (sem transação, como em produção) na fila depois da transição grava ackAt; situação ACKED', async () => {
      // Falha se a transição não soltasse a linha ao confirmar ou se a ciência
      // ficasse condicionada à pendência: a resposta que espera na fila depois do
      // Assumir ainda grava a ciência (a ciência vale sempre, K2-2).
      const id = await newPendency(db, { dispatchId });
      const lock = await holdRecipientLock(db, id);
      let reply: Promise<void> = Promise.resolve();
      try {
        const assume = settle(transition(assumeBy(id, db.ids.ana)));
        await waitForBlocked(lock, 1);
        reply = recordAlertReply(prismaService(), {
          originalId: id,
          messageId: 'wamid-k2-ciente',
          receivedAt: at(12),
          isAck: true,
        });
        await waitForAnyLockWait(db, 2);
        lock.release();
        expect(await assume).toMatchObject({ value: { ok: true } });
        await reply;
      } finally {
        await lock.finish();
      }
      const row = await db.prisma.teamWhatsappRecipient.findUniqueOrThrow({
        where: { id },
      });
      expect(row).toMatchObject({
        pendencyHandlerId: db.ids.ana,
        ackAt: at(12),
        ackKind: 'KEYWORD',
      });
      const facts = {
        ackAt: row.ackAt,
        closedAt: row.pendencyClosedAt,
        handlerId: row.pendencyHandlerId,
        handlerState: 'active' as const,
        dueAt: row.pendencyDueAt,
      };
      expect(pendencySituation(facts, at(20))).toBe('ACKED');
    }, 30_000);
  },
);
