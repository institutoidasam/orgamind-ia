import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { waitForBlocked } from '../chat/conversation-ownership.test-fixtures';
import {
  T0,
  at,
  holdRecipientLock,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  startPendencyDb,
  stopPendencyDb,
  waitForAnyLockWait,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import { heldBy } from './team-pendency.handling.test-fixtures';
import { TeamPendencyActionsService } from './team-pendency-actions.service';
import { TeamPendencyService } from './team-pendency.service';
import { PENDENCY_TX_OPTIONS } from './team-pendency-write.repository';
import { recordAlertReply } from './tracking/team-alert-reply';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.close.race.integration.spec.ts
 *
 * Molde B (GK11, DK23): trava externa na linha do destinatário, comandos
 * disparados sem `await` e esperados na fila de trava, solta a trava e só então
 * o `await`. Isolamento padrão (READ COMMITTED).
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let manager: { id: string; name: string };
let sectorId = '';
let dispatchId = '';

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  manager = await newTeamUser(db, { role: 'SUPERVISOR' });
  sectorId = (await newSector(db, { managerId: manager.id })).id;
  dispatchId = await newAlert(db, { authorId: db.ids.admin, createdAt: T0 });
}, 180_000);

afterAll(() => stopPendencyDb(db));

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

const prismaService = () => db.prisma as unknown as PrismaService;

/** Encerrar pelo responsável (a tela mostrava a pendência dele), em `at(10)`. */
const closeHeld = (id: string) =>
  new TeamPendencyActionsService(prismaService(), db.audit).close(
    manager.id,
    id,
    { expectedHandlerId: manager.id, reason: 'Sem retorno do setor' },
    at(10),
  );

const heldPendency = () =>
  newPendency(db, { dispatchId, sectorId, ...heldBy(manager.id) });

const rowOf = (id: string) =>
  db.prisma.teamWhatsappRecipient.findUniqueOrThrow({ where: { id } });
const notesOf = (id: string) =>
  db.prisma.teamPendencyNote.findMany({ where: { recipientId: id } });
const trailOf = (id: string) =>
  db.prisma.auditEvent.findMany({
    where: { entity: 'TeamWhatsappRecipient', entityId: id },
  });

/** Ciência por palavra, como a ingestão a entrega (`isAck`), recebida em `at(12)`. */
const ackReply = (tx: Parameters<typeof recordAlertReply>[0], id: string) =>
  recordAlertReply(tx, {
    originalId: id,
    messageId: 'wamid-k2-close',
    receivedAt: at(12),
    isAck: true,
  });

describe.skipIf(!ENABLED)('Encerrar — na fila antes da ciência', () => {
  it('aceite 19: Encerrar na fila antes da ciência automática (sem transação, como em produção) — encerrada e depois Ciente', async () => {
    // Falha se a ciência ficasse condicionada ao encerramento (ou o Encerrar a
    // desfizesse): a ciência vale sempre (K2-2) e o resultado legítimo da ordem
    // "Encerrar antes" é encerrada e, depois, Ciente, com a cobrança do
    // encerramento preservada no painel.
    const id = await heldPendency();
    const lock = await holdRecipientLock(db, id);
    try {
      const closing = settle(closeHeld(id));
      await waitForBlocked(lock, 1);
      const reply = settle(ackReply(prismaService(), id));
      await waitForAnyLockWait(db, 2);
      lock.release();
      const [closed, replied] = await Promise.all([closing, reply]);
      expect([closed, replied]).toEqual([
        { value: undefined },
        { value: undefined },
      ]);
    } finally {
      await lock.finish();
    }
    expect(await rowOf(id)).toMatchObject({
      pendencyClosedAt: at(10),
      pendencyClosedById: manager.id,
      ackAt: at(12),
      ackKind: 'KEYWORD',
    });
    expect(await trailOf(id)).toHaveLength(1);
    const item = await new TeamPendencyService(prismaService()).get(
      manager.id,
      id,
      at(30),
    );
    expect(item).toMatchObject({
      situation: 'ACKED',
      ack: { kind: 'KEYWORD' },
      closure: { reason: 'Sem retorno do setor' },
    });
  }, 30_000);
});

describe.skipIf(!ENABLED)('Encerrar — com a ciência na fila antes', () => {
  it('ciência automática (em $transaction) na fila antes do Encerrar — 422 ack_exists, nada encerrado', async () => {
    // Falha se a conferência lesse a linha sem a trava: o Encerrar veria `ackAt`
    // nulo e encerraria a pendência já ciente. A ciência entra em
    // `$transaction(…, PENDENCY_TX_OPTIONS)` (prazo maior que o padrão de 5 s,
    // revisão 2 M3) porque `recordAlertReply` são três comandos sem transação
    // (DK23): sem ela, o Encerrar entraria entre o primeiro e o terceiro.
    const id = await heldPendency();
    const lock = await holdRecipientLock(db, id);
    try {
      const ack = settle(
        db.prisma.$transaction((tx) => ackReply(tx, id), PENDENCY_TX_OPTIONS),
      );
      await waitForAnyLockWait(db, 1);
      const closing = settle(closeHeld(id));
      await waitForAnyLockWait(db, 2);
      lock.release();
      const [acked, closed] = await Promise.all([ack, closing]);
      expect(acked).toEqual({ value: undefined });
      expect(closed).toMatchObject({
        error: { status: 422, code: 'team_whatsapp.ack_exists' },
      });
    } finally {
      await lock.finish();
    }
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyClosedAt: null,
      pendencyClosedById: null,
      pendencyCloseReason: null,
      ackAt: at(12),
      ackKind: 'KEYWORD',
    });
    expect(await notesOf(id)).toEqual([]);
    expect(await trailOf(id)).toEqual([]);
  }, 30_000);
});
