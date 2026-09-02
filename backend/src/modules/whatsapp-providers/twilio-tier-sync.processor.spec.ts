import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { TwilioTierSyncProcessor } from './twilio-tier-sync.processor';
import { TwilioSendersService, type TwilioSender } from './twilio-senders.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

function makeSender(overrides: Partial<TwilioSender> = {}): TwilioSender {
  return {
    sid: 'XE00000000000000000000000000000001',
    senderId: 'whatsapp:+5592111111111',
    phoneE164: '+5592111111111',
    messagingLimit: '1K Customers/24hr',
    qualityRating: 'HIGH',
    ...overrides,
  };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-tw',
    provider: 'TWILIO',
    phoneE164: '+5592111111111',
    dailySendLimit: 250,
    isActive: true,
    ...overrides,
  } as never;
}

describe('TwilioTierSyncProcessor', () => {
  let prisma: MockProxy<PrismaService>;
  let senders: { configured: boolean; listSenders: ReturnType<typeof vi.fn> };
  let audit: MockProxy<AuditService>;
  let proc: TwilioTierSyncProcessor;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    senders = { configured: true, listSenders: vi.fn().mockResolvedValue([]) };
    audit = mockDeep<AuditService>();
    proc = new TwilioTierSyncProcessor(
      senders as unknown as TwilioSendersService,
      prisma,
      audit,
    );
    prisma.channel.findMany.mockResolvedValue([] as never);
  });

  it('no-op quando o grupo de credenciais Twilio não está configurado', async () => {
    senders.configured = false;
    await proc.process();
    expect(senders.listSenders).not.toHaveBeenCalled();
    expect(prisma.channel.findMany).not.toHaveBeenCalled();
  });

  it('atualiza dailySendLimit + audit quando o messaging_limit do sender difere do canal', async () => {
    prisma.channel.findMany.mockResolvedValue([makeChannel()] as never);
    senders.listSenders.mockResolvedValue([makeSender()]); // 1K → 1000 ≠ 250

    await proc.process();

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'chan-tw' },
      data: { dailySendLimit: 1000 },
    });
    expect(audit.log).toHaveBeenCalledWith(
      'channel.tier_sync',
      'Channel',
      'chan-tw',
      expect.objectContaining({
        previousLimit: 250,
        newLimit: 1000,
        messagingLimit: '1K Customers/24hr',
      }),
    );
  });

  it('NÃO atualiza quando o limite já é o mesmo (sem update, sem audit)', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 1000 }),
    ] as never);
    senders.listSenders.mockResolvedValue([makeSender()]);

    await proc.process();

    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("messaging_limit 'Unavailable' → não mexe no canal", async () => {
    prisma.channel.findMany.mockResolvedValue([makeChannel()] as never);
    senders.listSenders.mockResolvedValue([
      makeSender({ messagingLimit: 'Unavailable' }),
    ]);

    await proc.process();

    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('canal sem sender correspondente na Twilio → não mexe', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ phoneE164: '+5599999999999' }),
    ] as never);
    senders.listSenders.mockResolvedValue([makeSender()]);

    await proc.process();

    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('só considera canais TWILIO ativos (filtro do findMany)', async () => {
    senders.listSenders.mockResolvedValue([makeSender()]);

    await proc.process();

    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: 'TWILIO', isActive: true }),
      }),
    );
  });

  it('falha ao atualizar UM canal não aborta os demais', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel(),
      makeChannel({ id: 'chan-tw2', phoneE164: '+5592222222222' }),
    ] as never);
    senders.listSenders.mockResolvedValue([
      makeSender(),
      makeSender({
        sid: 'XE00000000000000000000000000000002',
        senderId: 'whatsapp:+5592222222222',
        phoneE164: '+5592222222222',
        messagingLimit: '10K Customers/24hr',
      }),
    ]);
    prisma.channel.update
      .mockRejectedValueOnce(new Error('db blip') as never)
      .mockResolvedValueOnce({} as never);

    await expect(proc.process()).resolves.not.toThrow();

    expect(prisma.channel.update).toHaveBeenCalledTimes(2);
    expect(prisma.channel.update).toHaveBeenLastCalledWith({
      where: { id: 'chan-tw2' },
      data: { dailySendLimit: 10000 },
    });
  });
});
