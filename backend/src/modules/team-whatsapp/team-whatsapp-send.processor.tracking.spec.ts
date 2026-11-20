import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { finishSkipped } from './team-recipient-finish';
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

// H1/H3 (DH2, DH3): hora da conferência gravada só com `open`, limpa nos
// desfechos antes do provedor, e o pulo pela transação que cancela a Message.
const CHECKED_AT = new Date('2026-11-20T15:00:00.000Z');
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
const jobAt = (attemptsMade: number) =>
  ({
    data: { recipientId: 'r1' },
    attemptsMade,
    opts: { attempts: 3 },
  }) as unknown as Job<TeamWhatsappSendJob>;

let prisma: DeepMockProxy<PrismaService>;
let chat: DeepMockProxy<ChatService>;
let repo: DeepMockProxy<TeamWhatsappRepository>;
let liveState: DeepMockProxy<ChannelLiveStateService>;
let proc: TeamWhatsappSendProcessor;

const givenLive = (state: string) =>
  liveState.check.mockResolvedValue({
    channelId: 'ch1',
    state,
    checkedAt: CHECKED_AT,
  } as never);
const recipientData = () =>
  prisma.teamWhatsappRecipient.updateMany.mock.calls
    .map(([a]) => (a as { data: Record<string, unknown> }).data)
    .filter((d) => 'status' in d);

beforeEach(() => {
  vi.mocked(finishSkipped).mockClear();
  prisma = mockDeep<PrismaService>();
  prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
    recipient() as never,
  );
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
  repo = mockDeep<TeamWhatsappRepository>();
  liveState = mockDeep<ChannelLiveStateService>();
  givenLive('open');
  const consent = mockDeep<ConsentService>();
  consent.isSuppressed.mockResolvedValue(false);
  const redis = mockDeep<Redis>();
  redis.del.mockResolvedValue(1);
  proc = new TeamWhatsappSendProcessor(prisma, chat, consent, redis);
  Object.assign(proc, { repo, liveState });
});

describe('processor — hora da conferência na tentativa (H1, DH2)', () => {
  it('open grava channelCheckedAt = checkedAt na contagem da tentativa, antes do provedor', async () => {
    await proc.process(jobAt(0));
    expect(repo.countAttempt.mock.calls).toEqual([['r1', CHECKED_AT]]);
    expect(repo.countAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      chat.sendTeamMessage.mock.invocationCallOrder[0],
    );
    expect(recipientData().at(-1)).not.toHaveProperty('channelCheckedAt');
  });

  it.each([['close'], ['connecting']])(
    '%s: FAILED channel_disconnected com channelCheckedAt nulo, sem contar tentativa',
    async (state) => {
      givenLive(state);
      await proc.process(jobAt(0));
      expect(recipientData()).toEqual([
        {
          status: 'FAILED',
          errorCode: 'team_whatsapp.channel_disconnected',
          channelCheckedAt: null,
        },
      ]);
      expect(repo.countAttempt.mock.calls).toHaveLength(0);
      expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
    },
  );

  it('unknown na última tentativa: FAILED channel_unverified sem hora', async () => {
    givenLive('unknown');
    await proc.process(jobAt(2));
    expect(recipientData()).toEqual([
      {
        status: 'FAILED',
        errorCode: 'team_whatsapp.channel_unverified',
        channelCheckedAt: null,
      },
    ]);
    expect(repo.countAttempt.mock.calls).toHaveLength(0);
  });
});

describe('processor — desfechos antes da conferência (H1, H3)', () => {
  it('pulado no precheck: channelCheckedAt nulo, sem consultar a porta ao vivo', async () => {
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
      recipient({ user: null }) as never,
    );
    await proc.process(jobAt(0));
    expect(recipientData()).toEqual([
      { status: 'SKIPPED', skipReason: 'NO_PHONE', channelCheckedAt: null },
    ]);
    expect(liveState.check.mock.calls).toHaveLength(0);
  });

  it('precheck com canal inválido: FAILED com channelCheckedAt nulo', async () => {
    const off = { ...CH, isActive: false };
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
      recipient({
        channel: off,
        dispatch: { ...recipient().dispatch, channel: off },
      }) as never,
    );
    await proc.process(jobAt(0));
    expect(recipientData()).toEqual([
      {
        status: 'FAILED',
        errorCode: 'team_whatsapp.channel_invalid',
        channelCheckedAt: null,
      },
    ]);
    expect(prisma.message.updateMany.mock.calls).toHaveLength(0);
  });
});

describe('processor — desfecho de tentativa anterior e pulo com Message (H1, H3)', () => {
  it('priorOutcome SENT não mexe em channelCheckedAt', async () => {
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
      recipient({ messageId: 'm1' }) as never,
    );
    prisma.message.findUnique.mockResolvedValue({
      status: 'SENT',
      errorCode: null,
      sentAt: CHECKED_AT,
    } as never);
    await proc.process(jobAt(1));
    expect(recipientData()).toEqual([
      { status: 'SENT', acceptedAt: CHECKED_AT },
    ]);
    expect(liveState.check.mock.calls).toHaveLength(0);
  });

  it('PHONE_CHANGED com messageId chama finishSkipped com o messageId', async () => {
    prisma.teamWhatsappRecipient.findUnique.mockResolvedValue(
      recipient({ messageId: 'm1', phoneE164: '+5592991110002' }) as never,
    );
    prisma.message.findUnique.mockResolvedValue({
      status: 'QUEUED',
      errorCode: null,
      sentAt: null,
    } as never);
    await proc.process(jobAt(1));
    expect(vi.mocked(finishSkipped).mock.calls).toEqual([
      [
        prisma,
        { recipientId: 'r1', messageId: 'm1', skipReason: 'PHONE_CHANGED' },
      ],
    ]);
    expect(prisma.message.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'm1', status: 'QUEUED' },
          data: { status: 'CANCELLED' },
        },
      ],
    ]);
    expect(chat.sendTeamMessage.mock.calls).toHaveLength(0);
  });
});
