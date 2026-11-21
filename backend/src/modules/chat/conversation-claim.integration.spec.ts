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
  auditRows,
  conversationRow,
  historyRows,
  startOwnershipDb,
  stopOwnershipDb,
  T0,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';
import {
  claimConversation,
  mediaReply,
  messageCount,
  publishedTypes,
  rejectionOf,
  startClaimEnv,
  textReply,
  type ClaimEnv,
} from './conversation-claim.test-fixtures';

// Só a Evolution está ligada de verdade; o ZERNIO entra aqui para o teste da
// janela de 24h chegar ao guard (o GOZAP segue desligado).
vi.mock('../../shared/config/enabled-providers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../shared/config/enabled-providers')
  >()),
  isEnabledChannelProvider: (provider: string) =>
    provider === 'EVOLUTION' || provider === 'ZERNIO',
}));

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-claim.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const PAST = new Date('2026-01-01T00:00:00.000Z');

let db: OwnershipDb;
let env: ClaimEnv;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
  env = await startClaimEnv(db);
}, 180_000);

beforeEach(() => vi.clearAllMocks());

afterAll(() => stopOwnershipDb(db));

/** A Ana passou a atender a conversa, aberta e com o robô pausado; histórico e trilha da reivindicação. */
async function expectClaimedByAna(id: string, actions: string[]) {
  const row = await conversationRow(db, id);
  expect(row).toMatchObject({ assignedUserId: db.ids.ana, resolvedAt: null });
  expect(row.botPausedAt).not.toBeNull();
  const history = await historyRows(db, id);
  expect(history.map((entry) => entry.action)).toEqual(actions);
  expect(history.at(-1)).toMatchObject({
    actorId: db.ids.ana,
    fromUserId: null,
    toUserId: db.ids.ana,
  });
  expect(await auditRows(db, id)).toMatchObject([
    { action: 'conversation.assign', actorId: db.ids.ana },
  ]);
}

describe.skipIf(!ENABLED)('claimForReply — sem atendente (aceite 5)', () => {
  it('aceite 5: resposta numa conversa sem atendente — 200, atendente = quem respondeu, linha ASSUMED_ON_REPLY, conversation.assign, botPausedAt, e conversation.updated publicado uma vez (espião de ChatEventsService, depois do commit)', async () => {
    const id = await claimConversation(env);
    // O 1º evento é o da trava: lido de outra conexão, a linha já está commitada.
    let atFirstEvent: string | null | undefined;
    env.events.publish.mockImplementationOnce(async () => {
      atFirstEvent = (await conversationRow(db, id)).assignedUserId;
    });
    expect(await textReply(env, id, 'ana')).toMatchObject({ status: 'SENT' });
    expect(atFirstEvent).toBe(db.ids.ana);
    await expectClaimedByAna(id, ['ASSUMED_ON_REPLY']);
    // Trava, depois a mensagem e o resumo da própria resposta.
    expect(publishedTypes(env)).toEqual([
      'conversation.updated',
      'message.created',
      'conversation.updated',
    ]);
  });

  it('aceite 5: resposta numa resolvida — REOPENED e ASSUMED_ON_REPLY, aberta e com atendente, conversation.updated publicado', async () => {
    const id = await claimConversation(env, { resolvedAt: T0 });
    await textReply(env, id, 'ana');
    await expectClaimedByAna(id, ['REOPENED', 'ASSUMED_ON_REPLY']);
    expect(publishedTypes(env)[0]).toBe('conversation.updated');
  });
});

describe.skipIf(!ENABLED)('claimForReply — resposta do atendente', () => {
  it('resposta do atendente — nenhuma linha nova, nenhum AuditEvent, nenhum conversation.updated', async () => {
    const id = await claimConversation(env, {
      assignedUserId: db.ids.ana,
      assignedAt: T0,
    });
    await textReply(env, id, 'ana');
    expect(await historyRows(db, id)).toEqual([]);
    expect(await auditRows(db, id)).toEqual([]);
    expect((await conversationRow(db, id)).assignedAt).toEqual(T0);
    // O evento da própria resposta enviada; a trava não publicou o seu.
    expect(publishedTypes(env)).toEqual([
      'message.created',
      'conversation.updated',
    ]);
  });
});

/** 409 `chat.assigned_to_other` com a Ana no detail; nada gravado, nada publicado. */
async function expectRefusedByAna(id: string, promise: Promise<unknown>) {
  const error = await rejectionOf(promise);
  expect(error).toMatchObject({ status: 409, code: 'chat.assigned_to_other' });
  expect(JSON.parse(error?.detail ?? '{}')).toEqual({
    assignee: { id: db.ids.ana, name: 'Ana Atendente', active: true },
  });
  expect(await messageCount(env, id)).toBe(0);
  expect(await historyRows(db, id)).toEqual([]);
  expect((await conversationRow(db, id)).assignedUserId).toBe(db.ids.ana);
  expect(env.events.publish).not.toHaveBeenCalled();
}

const conversationOfAna = () =>
  claimConversation(env, { assignedUserId: db.ids.ana, assignedAt: T0 });

describe.skipIf(!ENABLED)(
  'claimForReply — conversa de outro (aceite 6)',
  () => {
    it('aceite 6: texto em conversa de outro — 409 chat.assigned_to_other com o nome no detail, nenhuma Message, provedor não chamado', async () => {
      const id = await conversationOfAna();
      await expectRefusedByAna(id, textReply(env, id, 'bia'));
      expect(env.wa.sendChatText).not.toHaveBeenCalled();
    });

    it('aceite 6: ADMIN em conversa de outro — 409 igual', async () => {
      const id = await conversationOfAna();
      await expectRefusedByAna(id, textReply(env, id, 'admin'));
      expect(env.wa.sendChatText).not.toHaveBeenCalled();
    });

    it('aceite 6: mídia em conversa de outro — 409, nenhuma Message, store.put não chamado', async () => {
      const id = await conversationOfAna();
      await expectRefusedByAna(id, mediaReply(env, id, 'bia'));
      expect(env.store.put).not.toHaveBeenCalled();
      expect(env.wa.sendMedia).not.toHaveBeenCalled();
    });
  },
);

describe.skipIf(!ENABLED)(
  'claimForReply — falha de envio e recusas antes da trava',
  () => {
    it('envio falha no provedor — a atribuição permanece e a Message fica FAILED', async () => {
      const id = await claimConversation(env);
      env.wa.sendChatText.mockRejectedValueOnce(new Error('provedor fora'));
      expect(await textReply(env, id, 'ana')).toMatchObject({
        status: 'FAILED',
      });
      await expectClaimedByAna(id, ['ASSUMED_ON_REPLY']);
    });

    it('canal desligado ou janela fechada recusam antes da trava — nenhuma linha de histórico', async () => {
      const cases = [
        { provider: 'GOZAP', code: 'channel.provider_disabled', over: {} },
        {
          provider: 'ZERNIO',
          code: 'chat.twilio_window_closed',
          over: { lastInboundAt: PAST },
        },
      ] as const;
      for (const { provider, code, over } of cases) {
        const channel = await db.prisma.channel.create({
          data: { name: `Canal ${provider}`, provider },
          select: { id: true },
        });
        const id = await claimConversation(env, {
          instanceId: channel.id,
          ...over,
        });
        expect(await rejectionOf(textReply(env, id, 'ana'))).toMatchObject({
          code,
        });
        expect(await historyRows(db, id)).toEqual([]);
        expect((await conversationRow(db, id)).assignedUserId).toBeNull();
        expect(await messageCount(env, id)).toBe(0);
      }
    });
  },
);
