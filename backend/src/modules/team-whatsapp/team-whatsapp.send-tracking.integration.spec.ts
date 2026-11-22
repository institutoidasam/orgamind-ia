import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { ChatService, type TeamSendResult } from '../chat/chat.service';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';
import { finishSkipped } from './team-recipient-finish';

// O processor só usa o pacing para segurar o canal depois do envio (dorme 10–45 s).
vi.mock('../campaigns/pacing.helper', () => ({
  acquirePacingLock: vi.fn().mockResolvedValue({ acquired: true }),
  releasePacingLock: vi.fn().mockResolvedValue(undefined),
}));

// H1 e H3 (aceites 2 e 4) contra Postgres real: o processor, o repositório e a
// transação do pulo são os de verdade; a porta ao vivo e o chat (provedor) são
// dublês. O chat falso prepara a Message no banco, como o de verdade, e o
// envio falso a marca como o provedor marcaria. Nunca WhatsApp real.
const CHECKED_AT = new Date('2026-11-20T15:00:00.000Z');
const OLD_CHECK = new Date('2026-11-20T14:00:00.000Z');
const NOT_CONNECTED = 'evolution.not_connected';
const realChat = Object.create(ChatService.prototype) as ChatService;

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

let seq = 0;
/** Telefone fictício único (o do usuário é @unique). */
const phone = () => `+55929933${String(++seq).padStart(5, '0')}`;

type RecipientOver = Partial<
  Pick<
    Prisma.TeamWhatsappRecipientUncheckedCreateInput,
    'status' | 'errorCode' | 'attempts' | 'channelCheckedAt'
  >
>;

/** Destinatário de um envio já disparado, telefone gravado igual ao atual. */
async function seedRecipient(over: RecipientOver = {}) {
  const code = `T3H-${++seq}`;
  const p = phone();
  const channel = await prisma.channel.create({
    data: { name: `Canal ${code}`, provider: 'EVOLUTION', isActive: true },
  });
  const user = await prisma.user.create({
    data: {
      email: `${code}@test.local`,
      password: 'x',
      name: 'Pessoa A',
      phoneE164: p,
      contactAuthorization: 'AUTORIZADO',
    },
  });
  const dispatch = await prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: code,
      targetLabel: code,
      channelId: channel.id,
      text: 'oi',
      state: 'DISPATCHED',
      firedAt: CHECKED_AT,
    },
  });
  const r = await prisma.teamWhatsappRecipient.create({
    data: {
      dispatchId: dispatch.id,
      userId: user.id,
      userName: 'Pessoa A',
      phoneE164: p,
      channelId: channel.id,
      ...over,
    },
  });
  return {
    id: r.id,
    userId: user.id,
    channelId: channel.id,
    dispatchId: dispatch.id,
  };
}

type Send = (messageId: string) => Promise<TeamSendResult>;

const markMessage = (id: string, data: Prisma.MessageUpdateInput) =>
  prisma.message.update({ where: { id }, data });
/** Queda do worker entre preparar e enviar: lança antes de marcar a Message SENDING. */
const crashBeforeClaim: Send = () => Promise.reject(new Error('worker caiu'));
/** O provedor recusa com erro reenviável: a Message fica FAILED. */
const providerFails: Send = async (messageId) => {
  await markMessage(messageId, { status: 'FAILED', errorCode: NOT_CONNECTED });
  return { messageId, sent: false, errorCode: NOT_CONNECTED, retryable: true };
};
const accepts: Send = async (messageId) => {
  await markMessage(messageId, { status: 'SENT', sentAt: CHECKED_AT });
  return { messageId, sent: true, errorCode: null, retryable: false };
};

/** Processor real; `state` é o que a porta ao vivo (falsa) responde, conferida em CHECKED_AT. */
function processorWith(state: string, send: Send) {
  const chat = {
    prepareTeamMessage: vi.fn(
      async (a: { instanceId: string; text: string }) => {
        const m = await prisma.message.create({
          data: { instanceId: a.instanceId, content: a.text },
        });
        return { messageId: m.id, contactId: null };
      },
    ),
    sendTeamMessage: vi.fn((a: { messageId: string }) => send(a.messageId)),
    isRedispatchableFailure: (c: string | null) =>
      realChat.isRedispatchableFailure(c),
  };
  const liveState = {
    check: vi
      .fn()
      .mockResolvedValue({ channelId: 'x', state, checkedAt: CHECKED_AT }),
  };
  const proc = new TeamWhatsappSendProcessor(
    prisma as never,
    chat as never,
    { isSuppressed: vi.fn().mockResolvedValue(false) } as never,
    { del: vi.fn().mockResolvedValue(1) } as never,
  );
  Object.assign(proc, { repo, liveState });
  const attempt = (recipientId: string, attemptsMade: number) =>
    proc.process({
      data: { recipientId },
      attemptsMade,
      opts: { attempts: 3 },
    } as never);
  return { attempt, chat, liveState };
}

const rowOf = (id: string) =>
  prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      skipReason: true,
      errorCode: true,
      attempts: true,
      messageId: true,
      channelCheckedAt: true,
    },
  });
const messageStatus = async (id: string | null) =>
  (await prisma.message.findUniqueOrThrow({ where: { id: id ?? '' } })).status;
const changePhone = (userId: string) =>
  prisma.user.update({ where: { id: userId }, data: { phoneE164: phone() } });
const skipInput = (recipientId: string, messageId: string) => ({
  recipientId,
  messageId,
  skipReason: 'PHONE_CHANGED' as const,
});

describe('H3 — pulo com a Message preparada (aceite 4)', () => {
  it('aceite 4: pulado na 2ª tentativa depois de a 1ª preparar — Message CANCELLED', async () => {
    const r = await seedRecipient();
    await expect(
      processorWith('open', crashBeforeClaim).attempt(r.id, 0),
    ).rejects.toThrow();
    const prepared = await rowOf(r.id);
    expect(prepared).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(await messageStatus(prepared.messageId)).toBe('QUEUED');
    await changePhone(r.userId);
    const second = processorWith('open', accepts);
    await second.attempt(r.id, 1);
    expect(await rowOf(r.id)).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'PHONE_CHANGED',
      messageId: prepared.messageId,
      channelCheckedAt: null,
    });
    expect(
      await prisma.message.findMany({
        where: { instanceId: r.channelId },
        select: { id: true, status: true },
      }),
    ).toEqual([{ id: prepared.messageId, status: 'CANCELLED' }]);
    expect(second.chat.sendTeamMessage).not.toHaveBeenCalled();
  }, 60_000);
});

describe('H3 — Message ou destinatário fora de QUEUED no pulo', () => {
  it('Message SENDING ou FAILED não é cancelada no pulo', async () => {
    const a = await seedRecipient();
    await expect(
      processorWith('open', providerFails).attempt(a.id, 0),
    ).rejects.toThrow('team_whatsapp.retry');
    await changePhone(a.userId);
    await processorWith('open', accepts).attempt(a.id, 1);
    const failedRow = await rowOf(a.id);
    expect(failedRow).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'PHONE_CHANGED',
    });
    expect(await messageStatus(failedRow.messageId)).toBe('FAILED');
    // SENDING: outra execução pegou a Message entre a leitura dela e o pulo.
    const b = await seedRecipient();
    const sending = await prisma.message.create({
      data: { instanceId: b.channelId, status: 'SENDING' },
    });
    await expect(
      finishSkipped(prisma as never, skipInput(b.id, sending.id)),
    ).resolves.toEqual({
      skipped: true,
      messageCancelled: false,
    });
    expect(await messageStatus(sending.id)).toBe('SENDING');
  }, 60_000);

  it('destinatário que já não está QUEUED: a transação se desfaz e a Message continua QUEUED', async () => {
    const r = await seedRecipient({ status: 'SENT' });
    const msg = await prisma.message.create({
      data: { instanceId: r.channelId },
    });
    await expect(
      finishSkipped(prisma as never, skipInput(r.id, msg.id)),
    ).resolves.toEqual({
      skipped: false,
      messageCancelled: false,
    });
    expect(await messageStatus(msg.id)).toBe('QUEUED');
    expect(await rowOf(r.id)).toMatchObject({
      status: 'SENT',
      skipReason: null,
    });
  }, 60_000);
});

describe('H1 — hora da conferência (aceite 2)', () => {
  it('aceite 2: enviado grava a hora da conferência; pulado antes da conferência fica sem hora', async () => {
    const sent = await seedRecipient();
    const skipped = await seedRecipient({ channelCheckedAt: OLD_CHECK });
    await prisma.user.update({
      where: { id: skipped.userId },
      data: { contactAuthorization: 'NAO_AUTORIZADO' },
    });
    const run = processorWith('open', accepts);
    await run.attempt(sent.id, 0);
    await run.attempt(skipped.id, 0);
    expect(await rowOf(sent.id)).toMatchObject({
      status: 'SENT',
      attempts: 1,
      channelCheckedAt: CHECKED_AT,
    });
    expect(await rowOf(skipped.id)).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'NOT_AUTHORIZED',
      channelCheckedAt: null,
    });
    expect(run.liveState.check).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('falha de tentativa anterior com hora, repetida com o número desconectado: hora apagada', async () => {
    const r = await seedRecipient({
      status: 'FAILED',
      errorCode: NOT_CONNECTED,
      attempts: 1,
      channelCheckedAt: OLD_CHECK,
    });
    await expect(repo.requeueFailed(r.dispatchId, 'all')).resolves.toHaveLength(
      1,
    );
    // O "Repetir" não limpa: a próxima tentativa grava ou limpa (DH2).
    expect(await rowOf(r.id)).toMatchObject({
      status: 'QUEUED',
      channelCheckedAt: OLD_CHECK,
    });
    await processorWith('close', accepts).attempt(r.id, 0);
    expect(await rowOf(r.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'team_whatsapp.channel_disconnected',
      attempts: 1,
      channelCheckedAt: null,
    });
  }, 60_000);
});
