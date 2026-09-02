import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { WhatsappInstanceRouter } from './whatsapp-instance-router.service';
import { DomainError } from '../../shared/errors/domain.error';

describe('WhatsappInstanceRouter', () => {
  let router: WhatsappInstanceRouter;
  let prisma: MockProxy<PrismaService>;
  let repo: MockProxy<WhatsappInstancesRepository>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = mockDeep<WhatsappInstancesRepository>();
    router = new WhatsappInstanceRouter(prisma, repo);
  });

  const onlineEvent = { state: 'open', occurredAt: new Date() } as any;
  const offlineEvent = {
    state: 'close',
    reasonCode: 408,
    occurredAt: new Date(),
  } as any;

  it('new contact uses campaign default — returns send', async () => {
    // no prior sent messages
    prisma.message.findFirst.mockResolvedValue(null);
    repo.findById.mockResolvedValue({
      id: 'def',
      isActive: true,
      provider: 'EVOLUTION',
    } as any);
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

    const result = await router.resolveForSend({
      contactId: 'c1',
      campaignDefaultInstanceId: 'def',
    });

    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        contactId: 'c1',
        sentAt: { not: null },
        instance: { provider: 'EVOLUTION' },
      },
      orderBy: { sentAt: 'desc' },
      select: { instanceId: true },
    });
    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.instance.id).toBe('def');
  });

  it('contact with prior sent message — sticky to that instance', async () => {
    prisma.message.findFirst.mockResolvedValue({
      instanceId: 'sticky-A',
    } as any);
    repo.findById.mockResolvedValue({
      id: 'sticky-A',
      isActive: true,
      provider: 'EVOLUTION',
    } as any);
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

    const result = await router.resolveForSend({
      contactId: 'c1',
      campaignDefaultInstanceId: 'def',
    });

    expect(repo.findById).toHaveBeenCalledWith('sticky-A');
    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.instance.id).toBe('sticky-A');
  });

  it('sticky instance offline — returns waiting', async () => {
    prisma.message.findFirst.mockResolvedValue({
      instanceId: 'sticky-A',
    } as any);
    repo.findById.mockResolvedValue({
      id: 'sticky-A',
      isActive: true,
      provider: 'EVOLUTION',
    } as any);
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(offlineEvent);

    const result = await router.resolveForSend({
      contactId: 'c1',
      campaignDefaultInstanceId: 'def',
    });

    expect(result.kind).toBe('waiting');
    if (result.kind === 'waiting') expect(result.instanceId).toBe('sticky-A');
  });

  it('sticky soft-deleted — falls back to default', async () => {
    prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
    repo.findById.mockImplementation(async (id) => {
      if (id === 'gone')
        return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any; // soft deleted
      if (id === 'def')
        return { id: 'def', isActive: true, provider: 'EVOLUTION' } as any;
      return null;
    });
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

    const result = await router.resolveForSend({
      contactId: 'c1',
      campaignDefaultInstanceId: 'def',
    });

    expect(result.kind).toBe('send');
    if (result.kind === 'send') expect(result.instance.id).toBe('def');
  });

  it('default also missing — throws DomainError', async () => {
    prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
    repo.findById.mockResolvedValue(null);
    repo.findDefault.mockResolvedValue(null);

    await expect(
      router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def-missing',
      }),
    ).rejects.toThrow(DomainError);
  });

  it('fallback instance is soft-deleted — throws DomainError with campaign.default_instance_inactive', async () => {
    prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
    repo.findById.mockImplementation(async (id) => {
      if (id === 'gone')
        return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any;
      if (id === 'def')
        return { id: 'def', isActive: false, provider: 'EVOLUTION' } as any; // fallback also soft-deleted
      return null;
    });
    repo.findDefault.mockResolvedValue(null);

    await expect(
      router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      }),
    ).rejects.toMatchObject({ code: 'campaign.default_instance_inactive' });
  });

  describe('system-default fallback (campaign default deleted/missing)', () => {
    it('campaign default soft-deleted but active system default online → send via system default', async () => {
      prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
      repo.findById.mockImplementation(async (id) => {
        if (id === 'gone')
          return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any;
        if (id === 'def')
          return { id: 'def', isActive: false, provider: 'EVOLUTION' } as any; // campaign default soft-deleted
        return null;
      });
      repo.findDefault.mockResolvedValue({
        id: 'sys',
        isActive: true,
        provider: 'EVOLUTION',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('sys');
    });

    it('campaign default missing but active system default online → send via system default', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      repo.findById.mockResolvedValue(null); // campaign default row gone entirely
      repo.findDefault.mockResolvedValue({
        id: 'sys',
        isActive: true,
        provider: 'EVOLUTION',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def-missing',
      });

      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('sys');
    });

    it('campaign default soft-deleted and system default offline → waiting on system default', async () => {
      prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
      repo.findById.mockImplementation(async (id) => {
        if (id === 'gone')
          return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any;
        if (id === 'def')
          return { id: 'def', isActive: false, provider: 'EVOLUTION' } as any;
        return null;
      });
      repo.findDefault.mockResolvedValue({
        id: 'sys',
        isActive: true,
        provider: 'EVOLUTION',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(offlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('waiting');
      if (result.kind === 'waiting') expect(result.instanceId).toBe('sys');
    });

    it('campaign default missing and no system default → campaign.default_instance_missing with PT message', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      repo.findById.mockResolvedValue(null);
      repo.findDefault.mockResolvedValue(null);

      await expect(
        router.resolveForSend({
          contactId: 'c1',
          campaignDefaultInstanceId: 'def-missing',
        }),
      ).rejects.toMatchObject({
        code: 'campaign.default_instance_missing',
        message:
          'A conexão desta campanha não existe mais e não há outra conexão padrão ativa. Conecte um número, defina-o como padrão e reenvie.',
      });
    });

    it('campaign default soft-deleted and no system default → campaign.default_instance_inactive with PT message', async () => {
      prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
      repo.findById.mockImplementation(async (id) => {
        if (id === 'gone')
          return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any;
        if (id === 'def')
          return { id: 'def', isActive: false, provider: 'EVOLUTION' } as any;
        return null;
      });
      repo.findDefault.mockResolvedValue(null);

      await expect(
        router.resolveForSend({
          contactId: 'c1',
          campaignDefaultInstanceId: 'def',
        }),
      ).rejects.toMatchObject({
        code: 'campaign.default_instance_inactive',
        message:
          'A conexão desta campanha foi removida e não há outra conexão padrão ativa. Conecte um número, defina-o como padrão e reenvie.',
      });
    });

    it('system default exists but is inactive → still throws (findDefault does not filter isActive)', async () => {
      prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
      repo.findById.mockImplementation(async (id) => {
        if (id === 'gone')
          return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any;
        if (id === 'def')
          return { id: 'def', isActive: false, provider: 'EVOLUTION' } as any;
        return null;
      });
      repo.findDefault.mockResolvedValue({
        id: 'sys',
        isActive: false,
        provider: 'EVOLUTION',
      } as any);

      await expect(
        router.resolveForSend({
          contactId: 'c1',
          campaignDefaultInstanceId: 'def',
        }),
      ).rejects.toMatchObject({ code: 'campaign.default_instance_inactive' });
    });

    it('active campaign default is used directly — system default not consulted', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      repo.findById.mockResolvedValue({
        id: 'def',
        isActive: true,
        provider: 'EVOLUTION',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('send');
      expect(repo.findDefault).not.toHaveBeenCalled();
    });

    // T4(d): the system-default fallback must be scoped to the SAME provider as
    // the campaign's (now-gone) channel — never silently reroute a Twilio
    // campaign through an Evolution system default (or vice-versa).
    it('system-default fallback is scoped to the campaign channel provider (findDefault receives it)', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      repo.findById.mockImplementation(async (id) => {
        if (id === 'twilio-def')
          return {
            id: 'twilio-def',
            isActive: false,
            provider: 'TWILIO',
          } as any; // campaign's Twilio channel soft-deleted
        return null;
      });
      repo.findDefault.mockResolvedValue({
        id: 'sys-twilio',
        isActive: true,
        provider: 'TWILIO',
      } as any);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'twilio-def',
      });

      expect(repo.findDefault).toHaveBeenCalledWith('TWILIO');
      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('sys-twilio');
      // Cloud provider: the Evolution-only connection-state gate must never be
      // consulted for the resolved system default either.
      expect(prisma.whatsappConnectionEvent.findFirst).not.toHaveBeenCalled();
    });
  });

  it('sticky soft-deleted AND fallback offline → returns waiting on fallback', async () => {
    prisma.message.findFirst.mockResolvedValue({ instanceId: 'gone' } as any);
    repo.findById.mockImplementation(async (id) => {
      if (id === 'gone')
        return { id: 'gone', isActive: false, provider: 'EVOLUTION' } as any;
      if (id === 'def')
        return { id: 'def', isActive: true, provider: 'EVOLUTION' } as any;
      return null;
    });
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue({
      state: 'close',
    } as any);

    const result = await router.resolveForSend({
      contactId: 'c1',
      campaignDefaultInstanceId: 'def',
    });

    expect(result.kind).toBe('waiting');
    if (result.kind === 'waiting') expect(result.instanceId).toBe('def');
  });

  // ── Cloud providers (Twilio/Zernio/Meta) skip the Evolution-only online check ──
  // Evolution's connection-state gate exists to avoid banning unofficial
  // numbers. Twilio/Meta are official Cloud APIs with no WhatsappConnectionEvent
  // rows (every instance looks "close"), so the router must treat them as always
  // reachable — otherwise every send parks WAITING_INSTANCE forever. This is now
  // decided purely from `channel.provider` on the resolved row — there is no
  // global env/config lookup involved at all (T4: removed the latent
  // single-provider-env bug where WHATSAPP_PROVIDER gated EVERY channel).
  describe('cloud provider online-check short-circuit (decided by channel.provider, not env)', () => {
    it('twilio: sticky instance with NO open connection event → still send (not waiting)', async () => {
      prisma.message.findFirst.mockResolvedValue({
        instanceId: 'sticky-A',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'sticky-A',
        isActive: true,
        provider: 'TWILIO',
      } as any);
      // A close-state event (or none at all) would park the message on Evolution.
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(offlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('sticky-A');
      // The Evolution-only connection lookup must be short-circuited entirely.
      expect(prisma.whatsappConnectionEvent.findFirst).not.toHaveBeenCalled();
    });

    it('meta: campaign default with no connection event → send', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      repo.findById.mockResolvedValue({
        id: 'def',
        isActive: true,
        provider: 'META',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(offlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('def');
    });

    it('zernio: sticky instance with no connection event → send', async () => {
      prisma.message.findFirst.mockResolvedValue({
        instanceId: 'sticky-Z',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'sticky-Z',
        isActive: true,
        provider: 'ZERNIO',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(offlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('sticky-Z');
      expect(prisma.whatsappConnectionEvent.findFirst).not.toHaveBeenCalled();
    });

    it('evolution: close-state instance still parks as waiting (gate unchanged)', async () => {
      prisma.message.findFirst.mockResolvedValue({
        instanceId: 'sticky-A',
      } as any);
      repo.findById.mockResolvedValue({
        id: 'sticky-A',
        isActive: true,
        provider: 'EVOLUTION',
      } as any);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(offlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'def',
      });

      expect(result.kind).toBe('waiting');
    });
  });

  // T4(a): stickiness must not cross providers. The lastSent lookup is scoped
  // (at the Prisma query level) to `instance: { provider: <campaign's provider> }`,
  // so a contact's most recent send via a DIFFERENT-provider channel is never
  // even returned by the query — the campaign's own default is used instead.
  describe('stickiness does not cross provider (T4a)', () => {
    it('campaign default is EVOLUTION — lastSent query is scoped to EVOLUTION, ignoring any cross-provider history', async () => {
      repo.findById.mockImplementation(async (id) => {
        if (id === 'evo-def')
          return { id: 'evo-def', isActive: true, provider: 'EVOLUTION' } as any;
        return null;
      });
      // Because the query itself filters `instance: { provider: 'EVOLUTION' }`,
      // a contact whose last send went out via a Twilio channel would never be
      // returned here — simulate that with null (no EVOLUTION-provider history).
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'evo-def',
      });

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          contactId: 'c1',
          sentAt: { not: null },
          instance: { provider: 'EVOLUTION' },
        },
        orderBy: { sentAt: 'desc' },
        select: { instanceId: true },
      });
      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('evo-def');
    });

    it('campaign default is TWILIO — lastSent query is scoped to TWILIO', async () => {
      repo.findById.mockImplementation(async (id) => {
        if (id === 'twilio-def')
          return {
            id: 'twilio-def',
            isActive: true,
            provider: 'TWILIO',
          } as any;
        return null;
      });
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await router.resolveForSend({
        contactId: 'c1',
        campaignDefaultInstanceId: 'twilio-def',
      });

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          contactId: 'c1',
          sentAt: { not: null },
          instance: { provider: 'TWILIO' },
        },
        orderBy: { sentAt: 'desc' },
        select: { instanceId: true },
      });
      expect(result.kind).toBe('send');
      if (result.kind === 'send') expect(result.instance.id).toBe('twilio-def');
      // Cloud provider — never consults the Evolution-only connection gate.
      expect(prisma.whatsappConnectionEvent.findFirst).not.toHaveBeenCalled();
    });
  });

  it('filters out QUEUED (sentAt null) when looking up sticky reference', async () => {
    // simulate that findFirst with the right filter returns null because no
    // message has sentAt populated yet
    prisma.message.findFirst.mockResolvedValue(null);
    repo.findById.mockResolvedValue({
      id: 'def',
      isActive: true,
      provider: 'EVOLUTION',
    } as any);
    prisma.whatsappConnectionEvent.findFirst.mockResolvedValue(onlineEvent);

    await router.resolveForSend({
      contactId: 'c1',
      campaignDefaultInstanceId: 'def',
    });

    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contactId: 'c1',
          sentAt: { not: null },
        }),
      }),
    );
  });
});
