import type { TeamDispatchPurpose } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  at,
  newPendency,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb,
} from '../team-whatsapp/team-pendency.test-fixtures';
import { ChatRepository } from './chat.repository';
import { newConversation } from './conversation-ownership.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/message-team-tag.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let repo: ChatRepository;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  repo = new ChatRepository(db.prisma as never);
}, 180_000);

afterAll(() => stopPendencyDb(db));

type DispatchSeed = {
  createdAt: Date;
  firedAt?: Date;
  purpose?: TeamDispatchPurpose;
  ackDeadlineMinutes?: number;
  parentDispatchId?: string;
};

/** Envio da equipe (sem autor); `text` marcador prova que o texto nunca sai na etiqueta. */
async function newDispatch(seed: DispatchSeed): Promise<string> {
  const row = await db.prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 'setor-k3',
      targetLabel: 'Logística',
      text: 'Texto secreto do envio',
      ...seed,
    },
    select: { id: true },
  });
  return row.id;
}

async function newMessage(
  conversationId: string,
  direction: 'INBOUND' | 'OUTBOUND',
  minute: number,
): Promise<string> {
  const row = await db.prisma.message.create({
    data: {
      conversationId,
      instanceId: db.channelId,
      direction,
      status: direction === 'INBOUND' ? 'RECEIVED' : 'SENT',
      content: 'mensagem',
      createdAt: at(minute),
    },
    select: { id: true },
  });
  return row.id;
}

/** `teamTag` de cada mensagem da página (limite folgado: tudo numa página só). */
async function tagsOf(conversationId: string) {
  const page = await repo.listMessages(conversationId, { limit: 50 });
  return Object.fromEntries(page.items.map((m) => [m.id, m.teamTag]));
}

describe.skipIf(!ENABLED)('etiqueta de envio — mensagem do envio', () => {
  it('aceite 29: mensagem do envio — dispatch com finalidade e data', async () => {
    const conv = await newConversation(db);
    const sent = await newMessage(conv, 'OUTBOUND', 1);
    const oldSent = await newMessage(conv, 'OUTBOUND', 2);
    const meeting = await newDispatch({
      createdAt: at(-5),
      purpose: 'MEETING',
    });
    const legacy = await newDispatch({ createdAt: at(-9) });
    await newPendency(db, { dispatchId: meeting, messageId: sent });
    await newPendency(db, { dispatchId: legacy, messageId: oldSent });
    const tags = await tagsOf(conv);
    expect(tags[sent]).toEqual({
      kind: 'dispatch',
      purpose: 'meeting',
      sentAt: at(-5).toISOString(),
    });
    expect(tags[oldSent]).toEqual({
      kind: 'dispatch',
      purpose: null,
      sentAt: at(-9).toISOString(),
    });
    expect(JSON.stringify(tags)).not.toContain('Texto secreto');
  });

  it('mensagem do lembrete — reminder', async () => {
    const conv = await newConversation(db);
    const reminderMsg = await newMessage(conv, 'OUTBOUND', 3);
    const alert = await newDispatch({
      createdAt: at(0),
      purpose: 'URGENCY',
      ackDeadlineMinutes: 15,
    });
    const reminder = await newDispatch({
      createdAt: at(3),
      purpose: 'URGENCY',
      parentDispatchId: alert,
    });
    await newPendency(db, { dispatchId: reminder, messageId: reminderMsg });
    expect((await tagsOf(conv))[reminderMsg]).toEqual({ kind: 'reminder' });
  });
});

describe.skipIf(!ENABLED)(
  'etiqueta de envio — resposta ao alerta e mensagem comum',
  () => {
    it('resposta e ciência do alerta — alert_reply com a hora do alerta; de envio que não é alerta — sem etiqueta', async () => {
      const conv = await newConversation(db);
      const sent = await newMessage(conv, 'OUTBOUND', 1);
      const reply = await newMessage(conv, 'INBOUND', 2);
      const ack = await newMessage(conv, 'INBOUND', 3);
      const notAlert = await newMessage(conv, 'OUTBOUND', 4);
      const notAlertReply = await newMessage(conv, 'INBOUND', 5);
      const alert = await newDispatch({
        createdAt: at(0),
        purpose: 'URGENCY',
        ackDeadlineMinutes: 15,
      });
      const meeting = await newDispatch({
        createdAt: at(4),
        purpose: 'MEETING',
      });
      const row = await newPendency(db, {
        dispatchId: alert,
        messageId: sent,
        lastReplyMessageId: reply,
      });
      await db.prisma.teamWhatsappRecipient.update({
        where: { id: row },
        data: { ackMessageId: ack, ackMessageAt: at(3) },
      });
      await newPendency(db, {
        dispatchId: meeting,
        messageId: notAlert,
        lastReplyMessageId: notAlertReply,
      });
      const tags = await tagsOf(conv);
      const expected = {
        kind: 'alert_reply',
        alertSentAt: at(0).toISOString(),
      };
      expect(tags[reply]).toEqual(expected);
      expect(tags[ack]).toEqual(expected);
      expect(tags[notAlertReply]).toBeNull();
    });

    it('mensagem comum — teamTag null', async () => {
      const conv = await newConversation(db);
      const inbound = await newMessage(conv, 'INBOUND', 1);
      const outbound = await newMessage(conv, 'OUTBOUND', 2);
      const tags = await tagsOf(conv);
      expect(tags[inbound]).toBeNull();
      expect(tags[outbound]).toBeNull();
    });
  },
);

describe.skipIf(!ENABLED)('etiqueta de envio — alerta mais novo', () => {
  it('resposta que casa com dois alertas — o mais novo', async () => {
    const conv = await newConversation(db);
    const first = await newMessage(conv, 'OUTBOUND', 1);
    const second = await newMessage(conv, 'OUTBOUND', 20);
    const reply = await newMessage(conv, 'INBOUND', 21);
    const older = await newDispatch({
      createdAt: at(1),
      ackDeadlineMinutes: 15,
    });
    const newer = await newDispatch({
      createdAt: at(20),
      ackDeadlineMinutes: 15,
    });
    await newPendency(db, {
      dispatchId: older,
      messageId: first,
      lastReplyMessageId: reply,
    });
    await newPendency(db, {
      dispatchId: newer,
      messageId: second,
      lastReplyMessageId: reply,
    });
    expect((await tagsOf(conv))[reply]).toEqual({
      kind: 'alert_reply',
      alertSentAt: at(20).toISOString(),
    });
  });
});

describe.skipIf(!ENABLED)('etiqueta de envio — envio agendado', () => {
  it('envio agendado — data do disparo', async () => {
    const conv = await newConversation(db);
    const sent = await newMessage(conv, 'OUTBOUND', 121);
    const reply = await newMessage(conv, 'INBOUND', 122);
    const scheduled = await newDispatch({
      createdAt: at(0),
      firedAt: at(120),
      purpose: 'URGENCY',
      ackDeadlineMinutes: 15,
    });
    await newPendency(db, {
      dispatchId: scheduled,
      messageId: sent,
      lastReplyMessageId: reply,
    });
    const tags = await tagsOf(conv);
    expect(tags[sent]).toEqual({
      kind: 'dispatch',
      purpose: 'urgency',
      sentAt: at(120).toISOString(),
    });
    expect(tags[reply]).toEqual({
      kind: 'alert_reply',
      alertSentAt: at(120).toISOString(),
    });
  });
});

describe.skipIf(!ENABLED)('etiqueta de envio — escopo da consulta', () => {
  it('destinatário de outra conversa não etiqueta esta', async () => {
    const other = await newConversation(db);
    const mine = await newConversation(db);
    const otherSent = await newMessage(other, 'OUTBOUND', 1);
    const mineReply = await newMessage(mine, 'INBOUND', 2);
    const mineSent = await newMessage(mine, 'OUTBOUND', 3);
    const dispatch = await newDispatch({
      createdAt: at(0),
      purpose: 'URGENCY',
      ackDeadlineMinutes: 15,
    });
    await newPendency(db, {
      dispatchId: dispatch,
      messageId: otherSent,
      lastReplyMessageId: mineReply,
    });
    const tags = await tagsOf(mine);
    expect(tags[mineReply]).toBeNull();
    expect(tags[mineSent]).toBeNull();
    expect((await tagsOf(other))[otherSent]).toMatchObject({
      kind: 'dispatch',
    });
  });

  it('uma consulta por página', async () => {
    const conv = await newConversation(db);
    const first = await newMessage(conv, 'OUTBOUND', 1);
    const second = await newMessage(conv, 'OUTBOUND', 2);
    await newMessage(conv, 'INBOUND', 3);
    const dispatch = await newDispatch({ createdAt: at(0) });
    await newPendency(db, { dispatchId: dispatch, messageId: first });
    await newPendency(db, { dispatchId: dispatch, messageId: second });
    const spy = vi.spyOn(db.prisma, '$queryRaw');
    const page = await repo.listMessages(conv, { limit: 50 });
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(page.items).toHaveLength(3);
    expect(calls).toBe(1);
  });
});
