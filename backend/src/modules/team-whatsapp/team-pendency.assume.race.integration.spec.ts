import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForBlocked } from '../chat/conversation-ownership.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
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
import { TeamPendencyActionsService } from './team-pendency-actions.service';
import { PENDENCY_TX_OPTIONS } from './team-pendency-write.repository';
import { recordAlertReply } from './tracking/team-alert-reply';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.assume.race.integration.spec.ts
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

/** Assumir sem responsável (a tela mostrava a pendência livre), em `at(10)`. */
const assumeFree = (actorId: string, id: string) =>
  new TeamPendencyActionsService(prismaService(), db.audit).assume(
    actorId,
    id,
    { expectedHandlerId: null },
    at(10),
  );

const freePendency = () => newPendency(db, { dispatchId, sectorId });

const rowOf = (id: string) =>
  db.prisma.teamWhatsappRecipient.findUniqueOrThrow({ where: { id } });
const trailOf = (id: string) =>
  db.prisma.auditEvent.findMany({
    where: { entity: 'TeamWhatsappRecipient', entityId: id },
  });

/** Ciência por palavra, como a ingestão a entrega (`isAck`), recebida em `at(12)`. */
const ackReply = (tx: Parameters<typeof recordAlertReply>[0], id: string) =>
  recordAlertReply(tx, {
    originalId: id,
    messageId: 'wamid-k2-assume',
    receivedAt: at(12),
    isAck: true,
  });

describe.skipIf(!ENABLED)('Assumir — dois Assumir simultâneos', () => {
  it('aceite 16: dois Assumir simultâneos — um grava, o outro 409 pendency_taken com o nome; um AuditEvent', async () => {
    // Falha se a conferência lesse a linha sem a trava (os dois veriam a pendência
    // livre) ou se a gravação fosse um `updateMany` sem a condição do responsável:
    // o segundo Assumir sobrescreveria o primeiro e haveria dois AuditEvent.
    const id = await freePendency();
    const lock = await holdRecipientLock(db, id);
    try {
      const first = settle(assumeFree(db.ids.admin, id));
      await waitForBlocked(lock, 1);
      const second = settle(assumeFree(manager.id, id));
      await waitForBlocked(lock, 2);
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toEqual({ value: undefined });
      expect(two).toMatchObject({
        error: {
          status: 409,
          code: 'team_whatsapp.pendency_taken',
          detail: JSON.stringify({
            handler: { id: db.ids.admin, name: 'Zé Admin' },
          }),
        },
      });
    } finally {
      await lock.finish();
    }
    expect((await rowOf(id)).pendencyHandlerId).toBe(db.ids.admin);
    expect(await trailOf(id)).toHaveLength(1);
  }, 30_000);
});

describe.skipIf(!ENABLED)('Assumir — com a ciência automática', () => {
  it('ciência automática (em $transaction) na fila antes do Assumir — 409 pendency_changed, sem responsável', async () => {
    // Falha se a conferência lesse sem a trava: o Assumir veria `ackAt` nulo e
    // gravaria o responsável sobre a pendência já ciente. A ciência entra em
    // `$transaction(…, PENDENCY_TX_OPTIONS)` (prazo maior que o padrão de 5 s,
    // revisão 2 M3) porque `recordAlertReply` são três comandos sem transação
    // (DK23): sem ela, o Assumir entraria entre o primeiro e o terceiro.
    const id = await freePendency();
    const lock = await holdRecipientLock(db, id);
    try {
      const ack = settle(
        db.prisma.$transaction((tx) => ackReply(tx, id), PENDENCY_TX_OPTIONS),
      );
      await waitForAnyLockWait(db, 1);
      const assume = settle(assumeFree(manager.id, id));
      await waitForAnyLockWait(db, 2);
      lock.release();
      const [acked, assumed] = await Promise.all([ack, assume]);
      expect(acked).toEqual({ value: undefined });
      expect(assumed).toMatchObject({
        error: { status: 409, code: 'team_whatsapp.pendency_changed' },
      });
    } finally {
      await lock.finish();
    }
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: null,
      ackAt: at(12),
      ackKind: 'KEYWORD',
    });
    expect(await trailOf(id)).toEqual([]);
  }, 30_000);
});

describe.skipIf(!ENABLED)('Assumir — na fila antes da ciência', () => {
  it('Assumir na fila antes da ciência automática (sem transação, como em produção) — responsável gravado e depois Ciente', async () => {
    // Falha se o Assumir soltasse a linha sem confirmar, ou se a ciência ficasse
    // condicionada à pendência: o resultado legítimo da ordem "Assumir antes" é
    // o responsável gravado e, depois, a ciência (ela vale sempre, K2-2).
    const id = await freePendency();
    const lock = await holdRecipientLock(db, id);
    try {
      const assume = settle(assumeFree(manager.id, id));
      await waitForBlocked(lock, 1);
      const reply = settle(ackReply(prismaService(), id));
      await waitForAnyLockWait(db, 2);
      lock.release();
      const [assumed, replied] = await Promise.all([assume, reply]);
      expect([assumed, replied]).toEqual([
        { value: undefined },
        { value: undefined },
      ]);
    } finally {
      await lock.finish();
    }
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyDueAt: at(70),
      ackAt: at(12),
      ackKind: 'KEYWORD',
    });
    expect(await trailOf(id)).toHaveLength(1);
  }, 30_000);
});
