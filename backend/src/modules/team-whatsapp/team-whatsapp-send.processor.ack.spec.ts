import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { finishSkipped } from './team-recipient-finish';
import { acquirePacingLock } from '../campaigns/pacing.helper';
import { ChannelLiveStateService } from '../whatsapp-providers/channel-live-state.service';
import { ChatService } from '../chat/chat.service';
import { ConsentService } from '../consent/consent.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';

vi.mock('../campaigns/pacing.helper', () => ({
  acquirePacingLock: vi.fn().mockResolvedValue({ acquired: true }),
  releasePacingLock: vi.fn().mockResolvedValue(undefined),
}));
// A transação de verdade, espionada: o spec vê a chamada e as gravações dela.
vi.mock('./team-recipient-finish', async (importOriginal) => {
  const real = await importOriginal<typeof import('./team-recipient-finish')>();
  return { ...real, finishSkipped: vi.fn(real.finishSkipped) };
});

// I7 (DI11): lembrete cujo destinatário original já confirmou fica
// "Pulado: já confirmou" (ACKED), lido depois do pacing e antes da porta ao vivo.
const PHONE = '+5592991110001';
const CH = {
  id: 'ch1',
  provider: 'EVOLUTION',
  isActive: true,
  evolutionInstanceName: null,
};

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'QUEUED',
  messageId: null,
  parentRecipientId: 'p1',
  phoneE164: PHONE,
  user: {
    phoneE164: PHONE,
    contact: { id: 'c1', phoneE164: PHONE },
    contactAuthorization: 'AUTORIZADO',
  },
  channel: CH,
  dispatch: { id: 'd1', authorId: 'u1', text: 'Oi', channel: CH },
  ...over,
});
const job = {
  data: { recipientId: 'r1' },
  attemptsMade: 0,
  opts: { attempts: 3 },
} as unknown as Job<TeamWhatsappSendJob>;

let prisma: DeepMockProxy<PrismaService>;
let chat: DeepMockProxy<ChatService>;
let liveState: DeepMockProxy<ChannelLiveStateService>;
let redis: DeepMockProxy<Redis>;
let proc: TeamWhatsappSendProcessor;

/** O destinatário do lembrete (`r1`) e a leitura do original (`p1`). */
const givenOriginal = (ackAt: Date | null, over = {}) =>
  prisma.teamWhatsappRecipient.findUnique.mockImplementation(((a: {
    where: { id: string };
  }) =>
    Promise.resolve(
      a.where.id === 'p1' ? { ackAt } : recipient(over),
    )) as never);
const parentReads = () =>
  prisma.teamWhatsappRecipient.findUnique.mock.calls.filter(
    ([a]) => (a as { where: { id: string } }).where.id === 'p1',
  );

beforeEach(() => {
  vi.mocked(finishSkipped).mockClear();
  prisma = mockDeep<PrismaService>();
  prisma.teamWhatsappRecipient.updateMany.mockResolvedValue({ count: 1 });
  prisma.message.updateMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
    fn(prisma)) as never);
  chat = mockDeep<ChatService>();
  chat.prepareTeamMessage.mockResolvedValue({
    messageId: 'm1',
    contactId: 'c1',
  });
  chat.sendTeamMessage.mockResolvedValue({
    messageId: 'm1',
    sent: true,
    errorCode: null,
    retryable: false,
  });
  liveState = mockDeep<ChannelLiveStateService>();
  liveState.check.mockResolvedValue({
    channelId: 'ch1',
    state: 'open',
    checkedAt: new Date('2026-11-20T15:00:00.000Z'),
  } as never);
  const consent = mockDeep<ConsentService>();
  consent.isSuppressed.mockResolvedValue(false);
  redis = mockDeep<Redis>();
  redis.del.mockResolvedValue(1);
  proc = new TeamWhatsappSendProcessor(prisma, chat, consent, redis);
  Object.assign(proc, {
    repo: mockDeep<TeamWhatsappRepository>(),
    liveState,
  });
});

describe('processor — lembrete com o original ciente (I7, DI11)', () => {
  it('lembrete com original ciente — finishSkipped ACKED, sem liveState.check nem sendTeamMessage', async () => {
    givenOriginal(new Date('2026-11-20T14:00:00.000Z'));
    await proc.process(job);
    expect(vi.mocked(finishSkipped).mock.calls).toEqual([
      [prisma, { recipientId: 'r1', messageId: null, skipReason: 'ACKED' }],
    ]);
    expect(prisma.teamWhatsappRecipient.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'r1', status: 'QUEUED' },
          data: {
            status: 'SKIPPED',
            skipReason: 'ACKED',
            channelCheckedAt: null,
          },
        },
      ],
    ]);
    expect(liveState.check.mock.calls).toHaveLength(0);
    expect(chat.prepareTeamMessage.mock.calls).toHaveLength(0);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
  });

  it('lembrete com original pendente — segue o envio', async () => {
    givenOriginal(null);
    await proc.process(job);
    expect(vi.mocked(finishSkipped).mock.calls).toHaveLength(0);
    expect(liveState.check.mock.calls).toHaveLength(1);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(1);
  });

  it('destinatário sem parentRecipientId — nenhuma leitura extra', async () => {
    givenOriginal(new Date('2026-11-20T14:00:00.000Z'), {
      parentRecipientId: null,
    });
    await proc.process(job);
    expect(parentReads()).toHaveLength(0);
    expect(prisma.teamWhatsappRecipient.findUnique.mock.calls).toHaveLength(1);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(1);
  });
});

describe('processor — ordem da leitura do original (I7, DI11)', () => {
  it('a leitura acontece depois do pacing e o pacing é solto', async () => {
    givenOriginal(new Date('2026-11-20T14:00:00.000Z'));
    await proc.process(job);
    const [parentRead] =
      prisma.teamWhatsappRecipient.findUnique.mock.invocationCallOrder.slice(1);
    expect(
      vi.mocked(acquirePacingLock).mock.invocationCallOrder[0],
    ).toBeLessThan(parentRead);
    expect(parentReads()).toHaveLength(1);
    // Nada saiu: o lock sai na hora (sem o atraso anti-ban de quem enviou).
    expect(redis.del.mock.calls).toEqual([['pacing:send:lock:ch1']]);
  });

  it('priorOutcome SENT vem antes: lembrete que já saiu continua SENT', async () => {
    const sentAt = new Date('2026-11-20T15:00:05.000Z');
    givenOriginal(new Date('2026-11-20T14:00:00.000Z'), { messageId: 'm1' });
    prisma.message.findUnique.mockResolvedValue({
      status: 'SENT',
      errorCode: null,
      sentAt,
    } as never);
    await proc.process(job);
    expect(prisma.teamWhatsappRecipient.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'r1', status: 'QUEUED' },
          data: { status: 'SENT', acceptedAt: sentAt },
        },
      ],
    ]);
    expect(parentReads()).toHaveLength(0);
    expect(vi.mocked(finishSkipped).mock.calls).toHaveLength(0);
  });
});
