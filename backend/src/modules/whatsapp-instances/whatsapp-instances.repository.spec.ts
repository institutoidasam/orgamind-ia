import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';

describe('WhatsappInstancesRepository', () => {
  let repo: WhatsappInstancesRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new WhatsappInstancesRepository(prisma);
  });

  it('findById delegates to prisma.channel.findUnique', async () => {
    prisma.channel.findUnique.mockResolvedValue({ id: 'i1' } as any);
    const result = await repo.findById('i1');
    expect(prisma.channel.findUnique).toHaveBeenCalledWith({ where: { id: 'i1' } });
    expect(result?.id).toBe('i1');
  });

  // be-whatsapp / inbound resolution: soft-deleted (isActive=false) instances
  // must NOT resolve. findByEvolutionName powers webhook inbound resolution, so
  // it must scope to active instances — otherwise a removed instance keeps
  // ingesting inbound webhooks. findUnique can't take a non-unique filter, so
  // the lookup uses findFirst with both the unique name AND isActive=true.
  it('findByEvolutionName resolves only active instances by evolutionInstanceName', async () => {
    prisma.channel.findFirst.mockResolvedValue({ evolutionInstanceName: 'evo', isActive: true } as any);
    const result = await repo.findByEvolutionName('evo');
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: { evolutionInstanceName: 'evo', isActive: true },
    });
    expect(result?.evolutionInstanceName).toBe('evo');
  });

  it('findByEvolutionName returns null for a soft-deleted instance', async () => {
    // The DB filter (isActive=true) excludes the row, so prisma returns null.
    prisma.channel.findFirst.mockResolvedValue(null);
    const result = await repo.findByEvolutionName('evo');
    expect(result).toBeNull();
  });

  // T8: with per-provider defaults, MORE THAN ONE row can have isDefault=true
  // at once (one per provider) — so the unscoped call (4 legacy call sites:
  // whatsapp-providers.controller/service, contact-sync.processor,
  // twilio-webhooks.controller) needs a DETERMINISTIC pick. "The system
  // default" = the first default ever set, i.e. oldest by createdAt.
  it('findDefault returns the first default (deterministic createdAt asc) when no provider given', async () => {
    prisma.channel.findFirst.mockResolvedValue({ id: 'd' } as any);
    await repo.findDefault();
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: { isDefault: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('findDefault(provider) scopes the default lookup to that provider, still ordered deterministically', async () => {
    prisma.channel.findFirst.mockResolvedValue(null);
    await repo.findDefault('TWILIO');
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: { isDefault: true, provider: 'TWILIO' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('listActive filters isActive and orders default first then by createdAt', async () => {
    prisma.channel.findMany.mockResolvedValue([]);
    await repo.listActive();
    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  });

  it('listAll includes everyone ordered by isActive then default then createdAt', async () => {
    prisma.channel.findMany.mockResolvedValue([]);
    await repo.listAll();
    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  });

  it('create persists with given data', async () => {
    prisma.channel.create.mockResolvedValue({ id: 'n' } as any);
    await repo.create({
      name: 'X', evolutionInstanceName: 'x', apiKey: 'k', ownerUserId: null,
    });
    expect(prisma.channel.create).toHaveBeenCalledWith({
      data: { name: 'X', evolutionInstanceName: 'x', apiKey: 'k', ownerUserId: null },
    });
  });

  // T8: POST /whatsapp/channels creates a cloud-provider (TWILIO/ZERNIO/META)
  // channel row directly — no Evolution provisioning, no evolutionInstanceName
  // / apiKey (both nullable since the multi-provider migration).
  describe('createCloudChannel', () => {
    it('persists a cloud channel row with the given provider/name/phone', async () => {
      prisma.channel.create.mockResolvedValue({ id: 'c1' } as any);

      await repo.createCloudChannel({
        provider: 'TWILIO',
        name: 'Vendas Twilio',
        phoneE164: '+5592987654321',
      });

      expect(prisma.channel.create).toHaveBeenCalledWith({
        data: {
          provider: 'TWILIO',
          name: 'Vendas Twilio',
          phoneE164: '+5592987654321',
          twilioMessagingServiceSid: undefined,
          zernioAccountId: undefined,
          zernioAccountVerifiedAt: null,
        },
      });
    });

    it('forwards twilioMessagingServiceSid when provided', async () => {
      prisma.channel.create.mockResolvedValue({ id: 'c2' } as any);

      await repo.createCloudChannel({
        provider: 'TWILIO',
        name: 'Vendas Twilio',
        phoneE164: '+5592987654321',
        twilioMessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      });

      expect(prisma.channel.create).toHaveBeenCalledWith({
        data: {
          provider: 'TWILIO',
          name: 'Vendas Twilio',
          phoneE164: '+5592987654321',
          twilioMessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          zernioAccountId: undefined,
          zernioAccountVerifiedAt: null,
        },
      });
    });

    it('forwards zernioAccountId when provided', async () => {
      prisma.channel.create.mockResolvedValue({ id: 'c3' } as any);

      await repo.createCloudChannel({
        provider: 'ZERNIO',
        name: 'Vendas Zernio',
        phoneE164: '+5592987654321',
        zernioAccountId: 'acc-123',
      });

      expect(prisma.channel.create).toHaveBeenCalledWith({
        data: {
          provider: 'ZERNIO',
          name: 'Vendas Zernio',
          phoneE164: '+5592987654321',
          twilioMessagingServiceSid: undefined,
          zernioAccountId: 'acc-123',
          zernioAccountVerifiedAt: null,
        },
      });
    });
  });

  describe('createOrReactivateCloudChannel', () => {
    it('reactivates a soft-deleted ZERNIO channel with the same accountId instead of inserting (avoids the @unique P2002 500)', async () => {
      prisma.channel.findFirst.mockResolvedValue({ id: 'old-id' } as any);
      prisma.channel.update.mockResolvedValue({ id: 'old-id', isActive: true } as any);

      const result = await repo.createOrReactivateCloudChannel({
        provider: 'ZERNIO',
        name: 'Zernio Revivido',
        zernioAccountId: 'acc-123',
      });

      expect(prisma.channel.findFirst).toHaveBeenCalledWith({
        where: { zernioAccountId: 'acc-123', isActive: false },
      });
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: { id: 'old-id' },
        data: {
          isActive: true,
          name: 'Zernio Revivido',
          phoneE164: null,
          twilioMessagingServiceSid: null,
          zernioAccountId: 'acc-123',
          zernioAccountVerifiedAt: null,
        },
      });
      expect(prisma.channel.create).not.toHaveBeenCalled();
      expect(result.id).toBe('old-id');
    });

    it('creates a fresh row when there is no soft-deleted match', async () => {
      prisma.channel.findFirst.mockResolvedValue(null);
      prisma.channel.create.mockResolvedValue({ id: 'new-id' } as any);

      await repo.createOrReactivateCloudChannel({
        provider: 'ZERNIO',
        name: 'Zernio Novo',
        zernioAccountId: 'acc-999',
      });

      expect(prisma.channel.update).not.toHaveBeenCalled();
      expect(prisma.channel.create).toHaveBeenCalled();
    });
  });

  // T9: app-level duplicate guard for POST /whatsapp/channels — queried by
  // the controller before createCloudChannel (no DB-level unique constraint
  // covers provider+phoneE164; phoneE164 is nullable/shared across providers).
  describe('findActiveByProviderAndPhone', () => {
    it('queries an ACTIVE channel scoped to provider+phoneE164', async () => {
      prisma.channel.findFirst.mockResolvedValue({ id: 'c1' } as any);

      const result = await repo.findActiveByProviderAndPhone(
        'TWILIO',
        '+5592987654321',
      );

      expect(prisma.channel.findFirst).toHaveBeenCalledWith({
        where: { provider: 'TWILIO', phoneE164: '+5592987654321', isActive: true },
      });
      expect(result?.id).toBe('c1');
    });

    it('returns null when no ACTIVE channel matches', async () => {
      prisma.channel.findFirst.mockResolvedValue(null);

      const result = await repo.findActiveByProviderAndPhone(
        'TWILIO',
        '+5592987654321',
      );

      expect(result).toBeNull();
    });
  });

  // Z3: same app-level duplicate guard, scoped to Zernio's own account id.
  describe('findActiveByZernioAccountId', () => {
    it('queries an ACTIVE channel scoped to zernioAccountId', async () => {
      prisma.channel.findFirst.mockResolvedValue({ id: 'c1' } as any);

      const result = await repo.findActiveByZernioAccountId('acc-123');

      expect(prisma.channel.findFirst).toHaveBeenCalledWith({
        where: { zernioAccountId: 'acc-123', isActive: true },
      });
      expect(result?.id).toBe('c1');
    });

    it('returns null when no ACTIVE channel matches', async () => {
      prisma.channel.findFirst.mockResolvedValue(null);

      const result = await repo.findActiveByZernioAccountId('acc-123');

      expect(result).toBeNull();
    });
  });

  // T8 (inherited from T4 review): a system-wide "single default" empties the
  // router's per-provider fallback (whatsapp-instance-router.service.ts scopes
  // findDefault(provider) by the campaign's channel provider). setDefault must
  // therefore clear isDefault only among channels of the SAME provider as the
  // target, never globally.
  describe('setDefault (per-provider default)', () => {
    it('looks up the target channel, clears isDefault scoped to its provider, then sets the target', async () => {
      prisma.channel.findUnique.mockResolvedValue({ id: 'new-id', provider: 'EVOLUTION' } as any);
      prisma.$transaction.mockResolvedValue([] as any);

      await repo.setDefault('new-id');

      expect(prisma.channel.findUnique).toHaveBeenCalledWith({
        where: { id: 'new-id' },
        select: { provider: true },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.channel.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true, provider: 'EVOLUTION' },
        data: { isDefault: false },
      });
      expect(prisma.channel.update).toHaveBeenCalledWith({
        where: { id: 'new-id' },
        data: { isDefault: true },
      });
    });

    // The scenario this task explicitly requires: setting a TWILIO channel as
    // default must not clear an existing EVOLUTION default. Proven at the
    // query level — the updateMany that clears previous defaults is scoped to
    // provider: 'TWILIO', so Prisma never touches EVOLUTION rows.
    it('setDefault on a TWILIO channel does not clear an existing EVOLUTION default', async () => {
      prisma.channel.findUnique.mockResolvedValue({ id: 'twilio-id', provider: 'TWILIO' } as any);
      prisma.$transaction.mockResolvedValue([] as any);

      await repo.setDefault('twilio-id');

      const updateManyArgs = prisma.channel.updateMany.mock.calls[0]?.[0] as any;
      expect(updateManyArgs.where).toEqual({ isDefault: true, provider: 'TWILIO' });
      expect(updateManyArgs.where).not.toEqual({ isDefault: true }); // never global
    });

    it('is a no-op when the target channel does not exist', async () => {
      prisma.channel.findUnique.mockResolvedValue(null);

      await repo.setDefault('missing');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.channel.updateMany).not.toHaveBeenCalled();
      expect(prisma.channel.update).not.toHaveBeenCalled();
    });
  });

  it('softDelete sets isActive=false and isDefault=false', async () => {
    prisma.channel.update.mockResolvedValue({} as any);
    await repo.softDelete('d');
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'd' },
      data: { isActive: false, isDefault: false },
    });
  });

  it('incrementSentToday bumps via prisma increment', async () => {
    prisma.channel.update.mockResolvedValue({} as any);
    await repo.incrementSentToday('s');
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 's' },
      data: { sentToday: { increment: 1 } },
    });
  });

  // U1: device-profile healing — list() persists the phone/name/photo the
  // device reports via Evolution fetchInstances.
  it('updateDeviceProfile updates phone/name/photo via prisma update', async () => {
    prisma.channel.update.mockResolvedValue({} as any);
    await repo.updateDeviceProfile('i1', {
      phoneE164: '+559231550102',
      profileName: 'ORGAMIND',
      profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
    });
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: {
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
      },
    });
  });

  it('resetSentToday is a conditional CAS (only resets when not already rolled)', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const olderThan = new Date('2025-12-31T00:00:00Z');
    prisma.channel.updateMany.mockResolvedValue({ count: 1 } as any);
    const count = await repo.resetSentToday('r', at, olderThan);
    expect(prisma.channel.updateMany).toHaveBeenCalledWith({
      where: { id: 'r', sentTodayResetAt: { lt: olderThan } },
      data: { sentToday: 0, sentTodayResetAt: at },
    });
    expect(count).toBe(1);
  });

  it('resetSentToday no-ops (count 0) when another worker already rolled the window', async () => {
    prisma.channel.updateMany.mockResolvedValue({ count: 0 } as any);
    const count = await repo.resetSentToday(
      'r',
      new Date(),
      new Date(Date.now() - 86_400_000),
    );
    expect(count).toBe(0);
  });

  describe('reserveSendSlot (atomic tier reservation)', () => {
    it('issues a conditional increment scoped to sentToday < cap', async () => {
      prisma.channel.updateMany.mockResolvedValue({ count: 1 } as any);
      const ok = await repo.reserveSendSlot('i1', 250);
      expect(prisma.channel.updateMany).toHaveBeenCalledWith({
        where: { id: 'i1', sentToday: { lt: 250 } },
        data: { sentToday: { increment: 1 } },
      });
      expect(ok).toBe(true);
    });

    it('returns false when the cap is already reached (count 0)', async () => {
      prisma.channel.updateMany.mockResolvedValue({ count: 0 } as any);
      expect(await repo.reserveSendSlot('i1', 250)).toBe(false);
    });
  });

  describe('releaseSendSlot', () => {
    it('decrements sentToday floored at 0', async () => {
      prisma.channel.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.releaseSendSlot('i1');
      expect(prisma.channel.updateMany).toHaveBeenCalledWith({
        where: { id: 'i1', sentToday: { gt: 0 } },
        data: { sentToday: { decrement: 1 } },
      });
    });
  });

  describe('listActiveWithState', () => {
    it('returns rows with lastConnectionState populated when events exist', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { id: 'i1', isActive: true, connectionEvents: [{ state: 'open' }] },
      ] as any);
      const result = await repo.listActiveWithState();
      expect(result).toHaveLength(1);
      expect(result[0].lastConnectionState).toBe('open');
      expect(result[0]).not.toHaveProperty('connectionEvents');
    });

    it('returns null lastConnectionState when no events exist', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { id: 'i2', isActive: true, connectionEvents: [] },
      ] as any);
      const result = await repo.listActiveWithState();
      expect(result[0].lastConnectionState).toBeNull();
    });

    it('scopes to EVOLUTION only — cloud channels (null evolutionInstanceName) must not leak into the instance list', async () => {
      prisma.channel.findMany.mockResolvedValue([]);
      await repo.listActiveWithState();
      const arg = prisma.channel.findMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ isActive: true, provider: 'EVOLUTION' });
    });

    it('passes correct query with include to prisma', async () => {
      prisma.channel.findMany.mockResolvedValue([]);
      await repo.listActiveWithState();
      expect(prisma.channel.findMany).toHaveBeenCalledWith({
        where: { isActive: true, provider: 'EVOLUTION' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        omit: { apiKey: true, gozapInstanceToken: true },
        include: {
          bot: { select: { difyAppId: true, name: true } },
          connectionEvents: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { state: true },
          },
        },
      });
    });

    it('omits apiKey from returned rows (A5: never leak per-instance apiKey)', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { id: 'i1', isActive: true, connectionEvents: [{ state: 'open' }] },
      ] as any);
      const result = await repo.listActiveWithState();
      expect(result[0]).not.toHaveProperty('apiKey');
      expect(result[0]).not.toHaveProperty('gozapInstanceToken');
    });
  });

  describe('listAllWithState', () => {
    it('returns rows with lastConnectionState for all instances', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { id: 'i1', isActive: true, connectionEvents: [{ state: 'close' }] },
        { id: 'i2', isActive: false, connectionEvents: [] },
      ] as any);
      const result = await repo.listAllWithState();
      expect(result).toHaveLength(2);
      expect(result[0].lastConnectionState).toBe('close');
      expect(result[1].lastConnectionState).toBeNull();
    });

    it('omits apiKey via the prisma query (A5)', async () => {
      prisma.channel.findMany.mockResolvedValue([]);
      await repo.listAllWithState();
      expect(prisma.channel.findMany).toHaveBeenCalledWith({
        where: { provider: 'EVOLUTION' },
        orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
        omit: { apiKey: true, gozapInstanceToken: true },
        include: {
          bot: { select: { difyAppId: true, name: true } },
          connectionEvents: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { state: true },
          },
        },
      });
    });

    it('omits apiKey from returned rows (A5)', async () => {
      prisma.channel.findMany.mockResolvedValue([
        { id: 'i1', isActive: true, connectionEvents: [{ state: 'close' }] },
      ] as any);
      const result = await repo.listAllWithState();
      expect(result[0]).not.toHaveProperty('apiKey');
      expect(result[0]).not.toHaveProperty('gozapInstanceToken');
    });
  });

  describe('WhatsappInstancesRepository read exposes bot mapping', () => {
    it('surfaces botDifyAppId and botName', async () => {
      prisma.channel.findUnique.mockResolvedValue({
        id: 'i1', botId: 'b1', bot: { difyAppId: 'a1', name: 'Chat' }, connectionEvents: [],
      } as any);
      const result = await repo.findByIdWithState('i1');
      expect(result).toMatchObject({ id: 'i1', botDifyAppId: 'a1', botName: 'Chat' });
      expect((result as any).bot).toBeUndefined(); // relation not leaked raw
      const arg = prisma.channel.findUnique.mock.calls[0][0] as any;
      expect(arg.include.bot).toEqual({ select: { difyAppId: true, name: true } });
    });
  });

  describe('findByIdWithState', () => {
    it('returns the most recent state by occurredAt', async () => {
      prisma.channel.findUnique.mockResolvedValue({
        id: 'i1',
        connectionEvents: [{ state: 'connecting' }],
      } as any);
      const result = await repo.findByIdWithState('i1');
      expect(result?.lastConnectionState).toBe('connecting');
      expect(result?.id).toBe('i1');
      expect(result).not.toHaveProperty('connectionEvents');
    });

    it('returns null when instance is not found', async () => {
      prisma.channel.findUnique.mockResolvedValue(null);
      const result = await repo.findByIdWithState('missing');
      expect(result).toBeNull();
    });

    it('returns null lastConnectionState when no events exist', async () => {
      prisma.channel.findUnique.mockResolvedValue({
        id: 'i1',
        connectionEvents: [],
      } as any);
      const result = await repo.findByIdWithState('i1');
      expect(result?.lastConnectionState).toBeNull();
    });

    it('omits apiKey via the prisma query (A5)', async () => {
      prisma.channel.findUnique.mockResolvedValue(null);
      await repo.findByIdWithState('i1');
      expect(prisma.channel.findUnique).toHaveBeenCalledWith({
        where: { id: 'i1' },
        omit: { apiKey: true, gozapInstanceToken: true },
        include: {
          bot: { select: { difyAppId: true, name: true } },
          connectionEvents: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { state: true },
          },
        },
      });
    });

    it('omits apiKey from the returned row (A5)', async () => {
      prisma.channel.findUnique.mockResolvedValue({
        id: 'i1',
        connectionEvents: [{ state: 'open' }],
      } as any);
      const result = await repo.findByIdWithState('i1');
      expect(result).not.toHaveProperty('apiKey');
      expect(result).not.toHaveProperty('gozapInstanceToken');
    });
  });
});
