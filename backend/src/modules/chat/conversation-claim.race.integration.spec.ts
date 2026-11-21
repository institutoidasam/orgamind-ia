import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
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
import {
  claimConversation,
  messageCount,
  startClaimEnv,
  textReply,
  type ClaimEnv,
} from './conversation-claim.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-claim.race.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: OwnershipDb;
let env: ClaimEnv;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
  env = await startClaimEnv(db);
}, 180_000);

beforeEach(() => vi.clearAllMocks());

afterAll(() => stopOwnershipDb(db));

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

type Assignee = { id: string; name: string; active: boolean };

/** O atendente que o 409 `chat.assigned_to_other` cita (DK14). */
const assigneeOf = (outcome: { error?: unknown }): Assignee =>
  (
    JSON.parse((outcome.error as { detail: string }).detail) as {
      assignee: Assignee;
    }
  ).assignee;

describe.skipIf(!ENABLED)(
  'claimForReply — duas respostas (GK11, Molde B)',
  () => {
    it('aceite 7: duas respostas simultâneas numa conversa sem atendente — a primeira 200 e envia, a segunda 409 assigned_to_other com a primeira no detail; uma Message, provedor uma vez', async () => {
      // Falha se a reivindicação não for gravação condicional na linha travada
      // (FOR NO KEY UPDATE) ou vier depois de gravar a Message: as duas veriam a
      // conversa sem atendente, gravariam e enviariam (ou o poll não veria as
      // duas sessões esperando a trava e estouraria em 5 s).
      const id = await claimConversation(env);
      const lock = await holdConversationLock(db, id);
      try {
        const first = settle(textReply(env, id, 'ana'));
        await waitForBlocked(lock, 1);
        const second = settle(textReply(env, id, 'bia'));
        await waitForBlocked(lock, 2);
        lock.release();
        const [one, two] = await Promise.all([first, second]);
        expect(one).toMatchObject({ value: { status: 'SENT' } });
        expect(two).toMatchObject({
          error: { status: 409, code: 'chat.assigned_to_other' },
        });
        expect(assigneeOf(two)).toEqual({
          id: db.ids.ana,
          name: 'Ana Atendente',
          active: true,
        });
      } finally {
        await lock.finish();
      }
      expect(await messageCount(env, id)).toBe(1);
      expect(env.wa.sendChatText).toHaveBeenCalledTimes(1);
      expect(await historyRows(db, id)).toMatchObject([
        { action: 'ASSUMED_ON_REPLY', actorId: db.ids.ana },
      ]);
    }, 30_000);
  },
);

describe.skipIf(!ENABLED)(
  'claimForReply × assign — corrida (GK11, Molde B)',
  () => {
    it('aceite 7: transferência registrada no meio — resposta do antigo atendente 409, nenhuma Message', async () => {
      // Falha se a resposta decidir com o atendente lido antes da trava: ela
      // veria a conversa ainda com a Ana e gravaria e enviaria depois da troca.
      const { service: ownership } = ownershipService(db);
      const id = await claimConversation(env, {
        assignedUserId: db.ids.ana,
        assignedAt: T0,
      });
      const lock = await holdConversationLock(db, id);
      try {
        const transfer = settle(
          ownership.assign(
            id,
            { id: db.ids.ana, role: 'OPERATOR' },
            { userId: db.ids.bia, expectedAssigneeId: db.ids.ana },
          ),
        );
        await waitForBlocked(lock, 1);
        const reply = settle(textReply(env, id, 'ana'));
        await waitForBlocked(lock, 2);
        lock.release();
        const [moved, replied] = await Promise.all([transfer, reply]);
        expect(moved).toMatchObject({ value: { assignedUserId: db.ids.bia } });
        expect(replied).toMatchObject({
          error: { status: 409, code: 'chat.assigned_to_other' },
        });
        expect(assigneeOf(replied).id).toBe(db.ids.bia);
      } finally {
        await lock.finish();
      }
      expect(await messageCount(env, id)).toBe(0);
      expect(env.wa.sendChatText).not.toHaveBeenCalled();
      expect((await conversationRow(db, id)).assignedUserId).toBe(db.ids.bia);
      expect(await historyRows(db, id)).toMatchObject([
        { action: 'TRANSFERRED' },
      ]);
    }, 30_000);
  },
);
