import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { WhatsappInstancesService, EVOLUTION_ADMIN_CLIENT } from './whatsapp-instances.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { InstanceCreationFailedError, InstanceNotFoundError } from './errors/instance.errors';

describe('WhatsappInstancesService', () => {
  let svc: WhatsappInstancesService;
  let repo: MockProxy<WhatsappInstancesRepository>;
  let prisma: MockProxy<PrismaService>;
  let evolution: MockProxy<EvolutionApiAdapter>;
  let audit: MockProxy<AuditService>;
  let evo: {
    createInstance: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repo = mockDeep<WhatsappInstancesRepository>();
    prisma = mockDeep<PrismaService>();
    evolution = mockDeep<EvolutionApiAdapter>();
    audit = mockDeep<AuditService>();
    // Default: Evolution knows no live states → list() falls back to DB state.
    evolution.listConnectionStates.mockResolvedValue(new Map());
    evo = { createInstance: vi.fn(), logout: vi.fn(), restart: vi.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        WhatsappInstancesService,
        { provide: WhatsappInstancesRepository, useValue: repo },
        { provide: EVOLUTION_ADMIN_CLIENT, useValue: evo },
        { provide: PrismaService, useValue: prisma },
        { provide: EvolutionApiAdapter, useValue: evolution },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    svc = mod.get(WhatsappInstancesService);
  });

  it('create generates evolutionInstanceName, calls Evolution, persists row', async () => {
    evo.createInstance.mockResolvedValue({ apiKey: '' });
    repo.findByEvolutionName.mockResolvedValue(null);
    repo.create.mockResolvedValue({
      id: 'inst1', name: 'Vendas', evolutionInstanceName: 'picoa-vendas-x',
      apiKey: '', isDefault: false, isActive: true,
    } as any);

    const result = await svc.create({ name: 'Vendas' });

    expect(evo.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: expect.stringMatching(/^picoa-vendas-/) }),
    );
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Vendas',
    }));
    expect(result.id).toBe('inst1');
  });

  // be-whatsapp-003: the per-instance apiKey is never used to authenticate
  // (all adapter calls use the global EVOLUTION_API_KEY). Persisting the real
  // secret is dead attack surface, so the service must never persist a
  // non-empty per-instance key, regardless of what the admin client returns.
  it('create never persists a real per-instance apiKey (be-whatsapp-003)', async () => {
    // Even if a stale admin client somehow returned a real key, the service
    // must not persist it.
    evo.createInstance.mockResolvedValue({ apiKey: 'leaked-secret' });
    repo.findByEvolutionName.mockResolvedValue(null);
    repo.create.mockResolvedValue({
      id: 'inst1', name: 'Vendas', evolutionInstanceName: 'picoa-vendas-x',
      apiKey: '', isDefault: false, isActive: true,
    } as any);

    await svc.create({ name: 'Vendas' });

    const createArg = repo.create.mock.calls[0]?.[0];
    expect(createArg?.apiKey).not.toBe('leaked-secret');
    expect(createArg?.apiKey).toBe('');
  });

  it('create does not expose the per-instance apiKey in its result (A5)', async () => {
    evo.createInstance.mockResolvedValue({ apiKey: 'evo-token-123' });
    repo.findByEvolutionName.mockResolvedValue(null);
    repo.create.mockResolvedValue({
      id: 'inst1', name: 'Vendas', evolutionInstanceName: 'picoa-vendas-x',
      apiKey: 'evo-token-123', isDefault: false, isActive: true,
    } as any);

    const result = await svc.create({ name: 'Vendas' });

    expect(result).not.toHaveProperty('apiKey');
  });

  it('throws InstanceCreationFailedError when Evolution rejects', async () => {
    evo.createInstance.mockRejectedValue(new Error('limit reached'));
    repo.findByEvolutionName.mockResolvedValue(null);

    await expect(svc.create({ name: 'X' })).rejects.toThrow(InstanceCreationFailedError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('setDefault delegates to repo', async () => {
    repo.findById.mockResolvedValue({ id: 'i', isActive: true } as any);
    await svc.setDefault('i');
    expect(repo.setDefault).toHaveBeenCalledWith('i');
  });

  it('setDefault throws InstanceNotFoundError when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(svc.setDefault('missing')).rejects.toThrow(InstanceNotFoundError);
  });

  it('delete calls evolution logout + softDelete', async () => {
    repo.findById.mockResolvedValue({
      id: 'i', evolutionInstanceName: 'evo-1', isActive: true,
    } as any);
    repo.softDelete.mockResolvedValue({ id: 'i' } as any);
    prisma.message.updateMany.mockResolvedValue({ count: 0 });

    await svc.delete('i');

    expect(evo.logout).toHaveBeenCalledWith('evo-1');
    expect(repo.softDelete).toHaveBeenCalledWith('i');
  });

  // be-whatsapp: a failed Evolution logout must NOT abort the soft-delete.
  // Logout is best-effort cleanup (mirrors restart()); the DB soft-delete and
  // orphaned-message failover must still run so the instance is actually
  // removed from the operator's view.
  it('delete still soft-deletes when evolution logout fails (best-effort)', async () => {
    repo.findById.mockResolvedValue({
      id: 'i', evolutionInstanceName: 'evo-1', isActive: true,
    } as any);
    evo.logout.mockRejectedValue(new Error('Evolution logout 400'));
    repo.softDelete.mockResolvedValue({ id: 'i' } as any);
    prisma.message.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.delete('i')).resolves.toBeUndefined();

    expect(evo.logout).toHaveBeenCalledWith('evo-1');
    expect(repo.softDelete).toHaveBeenCalledWith('i');
    expect(prisma.message.updateMany).toHaveBeenCalled();
  });

  it('delete bulk-fails WAITING_INSTANCE messages for the removed instance', async () => {
    repo.findById.mockResolvedValue({
      id: 'i', evolutionInstanceName: 'evo-1', isActive: true,
    } as any);
    repo.softDelete.mockResolvedValue({ id: 'i' } as any);
    prisma.message.updateMany.mockResolvedValue({ count: 3 });

    await svc.delete('i');

    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { instanceId: 'i', status: 'WAITING_INSTANCE' },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'antiban.instance_deleted',
      }),
    });
  });

  it('restart resolves by id then calls evolution restart', async () => {
    repo.findByIdWithState.mockResolvedValue({
      id: 'i', evolutionInstanceName: 'evo-1', isActive: true, lastConnectionState: null,
    } as any);
    await svc.restart('i');
    expect(evo.restart).toHaveBeenCalledWith('evo-1');
  });

  it('findById throws InstanceNotFoundError when null', async () => {
    repo.findByIdWithState.mockResolvedValue(null);
    await expect(svc.findById('nope')).rejects.toThrow(InstanceNotFoundError);
  });

  it('list with activeOnly=true delegates to listActiveWithState', async () => {
    repo.listActiveWithState.mockResolvedValue([] as any);
    await svc.list({ activeOnly: true });
    expect(repo.listActiveWithState).toHaveBeenCalled();
    expect(repo.listAllWithState).not.toHaveBeenCalled();
  });

  it('list with activeOnly=false delegates to listAllWithState', async () => {
    repo.listAllWithState.mockResolvedValue([] as any);
    await svc.list({ activeOnly: false });
    expect(repo.listAllWithState).toHaveBeenCalled();
    expect(repo.listActiveWithState).not.toHaveBeenCalled();
  });

  // T8: multi-provider channels — GET /whatsapp/instances must surface each
  // row's `provider` (already a real Channel column) so the frontend can
  // distinguish EVOLUTION/TWILIO/ZERNIO/META rows in the existing instance
  // list, without a separate lookup. Regression lock: list()/findById() must
  // never strip it while reshaping the row (warm-up attach, etc.).
  it('list() surfaces the provider field on every row (no stripping)', async () => {
    repo.listActiveWithState.mockResolvedValue([
      { id: 'i1', provider: 'TWILIO', warmupStartedAt: null, dailySendLimit: 500 },
      { id: 'i2', provider: 'EVOLUTION', warmupStartedAt: null, dailySendLimit: 500 },
    ] as any);

    const result = await svc.list({ activeOnly: true });

    expect(result.find((r) => r.id === 'i1')?.provider).toBe('TWILIO');
    expect(result.find((r) => r.id === 'i2')?.provider).toBe('EVOLUTION');
  });

  it('findById() surfaces the provider field', async () => {
    repo.findByIdWithState.mockResolvedValue({
      id: 'i1', provider: 'ZERNIO', warmupStartedAt: null, dailySendLimit: 500,
    } as any);

    const result = await svc.findById('i1');

    expect(result.provider).toBe('ZERNIO');
  });

  // Prod incident: lastConnectionState came from the last stored
  // WhatsappConnectionEvent, frozen days in the past, while Evolution actually
  // reported 'close'. list() must reconcile with Evolution's live state and
  // persist a healing event so the DB converges.
  // Evolution's fetchInstances snapshot: connection state + device profile.
  const snap = (state: string, over: Record<string, unknown> = {}) => ({
    state,
    ownerJid: null,
    profileName: null,
    profilePicUrl: null,
    ...over,
  });

  describe('list — live connection-state reconcile', () => {
    const row = (over: Record<string, unknown>) => ({
      id: 'i1',
      evolutionInstanceName: 'evo-1',
      isActive: true,
      lastConnectionState: 'open',
      phoneE164: null,
      profileName: null,
      profilePictureUrl: null,
      ...over,
    });

    it('overrides stale DB state with the Evolution live state and persists a healing event', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({ id: 'i1', evolutionInstanceName: 'evo-1', lastConnectionState: 'open' }),
        row({ id: 'i2', evolutionInstanceName: 'evo-2', lastConnectionState: 'open' }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('close')], // drifted — DB says open, Evolution says close
          ['evo-2', snap('open')], // in sync
        ]),
      );

      const result = await svc.list({ activeOnly: true });

      expect(result.find((r) => r.id === 'i1')?.lastConnectionState).toBe('close');
      expect(result.find((r) => r.id === 'i2')?.lastConnectionState).toBe('open');
      // Healing write only for the drifted instance.
      expect(repo.recordConnectionEvent).toHaveBeenCalledWith('i1', 'close');
      expect(repo.recordConnectionEvent).toHaveBeenCalledTimes(1);
    });

    it('keeps the DB state when Evolution does not know the instance', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({ lastConnectionState: 'open' }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(new Map([['other-inst', snap('close')]]));

      const result = await svc.list({ activeOnly: true });

      expect(result[0].lastConnectionState).toBe('open');
      expect(repo.recordConnectionEvent).not.toHaveBeenCalled();
    });

    it('falls back to DB state when Evolution states are unavailable (empty map)', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({ lastConnectionState: 'open' }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(new Map());

      const result = await svc.list({ activeOnly: true });

      expect(result[0].lastConnectionState).toBe('open');
      expect(repo.recordConnectionEvent).not.toHaveBeenCalled();
    });

    it('still returns the live state when the healing write fails', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({ lastConnectionState: 'open' }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(new Map([['evo-1', snap('close')]]));
      repo.recordConnectionEvent.mockRejectedValue(new Error('db down'));

      const result = await svc.list({ activeOnly: true });

      expect(result[0].lastConnectionState).toBe('close');
    });

    it('does not reconcile soft-deleted rows (listAll path)', async () => {
      repo.listAllWithState.mockResolvedValue([
        row({ isActive: false, lastConnectionState: 'open' }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(new Map([['evo-1', snap('close')]]));

      const result = await svc.list({ activeOnly: false });

      expect(result[0].lastConnectionState).toBe('open');
      expect(repo.recordConnectionEvent).not.toHaveBeenCalled();
    });
  });

  // U1: the device (instance) WhatsApp profile — phone (from ownerJid),
  // profileName, profilePicUrl — is reported by fetchInstances but was never
  // persisted, so the Conectar card showed "—" forever and device renames
  // never propagated. list() must heal drifted profiles and serve the fresh
  // values immediately.
  describe('list — device profile healing', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'i1',
      evolutionInstanceName: 'evo-1',
      isActive: true,
      lastConnectionState: 'open',
      phoneE164: null,
      profileName: null,
      profilePictureUrl: null,
      ...over,
    });

    it('persists + returns phone/name/photo derived from ownerJid when they drift', async () => {
      repo.listActiveWithState.mockResolvedValue([row()] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', {
            ownerJid: '559231550102@s.whatsapp.net',
            profileName: 'ORGAMIND',
            profilePicUrl: 'https://pps.whatsapp.net/pic.jpg',
          })],
        ]),
      );

      const result = await svc.list({ activeOnly: true });

      expect(repo.updateDeviceProfile).toHaveBeenCalledWith('i1', {
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
        // number changed (null → value) → warm-up ramp (re)started
        warmupStartedAt: expect.any(Date),
      });
      expect(result[0]).toMatchObject({
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
      });
      // In-sync connection state — no connection-event healing write.
      expect(repo.recordConnectionEvent).not.toHaveBeenCalled();
    });

    it('never blanks stored profile fields when ownerJid is missing', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({
          phoneE164: '+559231550102',
          profileName: 'ORGAMIND',
          profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
        }),
      ] as any);
      // Disconnected instances report no ownerJid/profile — must not wipe.
      evolution.listConnectionStates.mockResolvedValue(new Map([['evo-1', snap('open')]]));

      const result = await svc.list({ activeOnly: true });

      expect(repo.updateDeviceProfile).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
      });
    });

    it('treats null live name/photo as unknown — preserves stored values (ownerJid present)', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({
          phoneE164: '+559231550102',
          profileName: 'ORGAMIND',
          profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
        }),
      ] as any);
      // Evolution can report ownerJid while omitting profileName/profilePicUrl
      // (e.g. a closing session) — null means "unknown", never "cleared".
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', { ownerJid: '559231550102@s.whatsapp.net' })],
        ]),
      );

      const result = await svc.list({ activeOnly: true });

      // Nothing actually drifted once nulls are treated as unknown.
      expect(repo.updateDeviceProfile).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
      });
    });

    it('persists preserved name/photo alongside a drifted phone (null live fields kept)', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({
          phoneE164: null,
          profileName: 'ORGAMIND',
          profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
        }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', { ownerJid: '559231550102@s.whatsapp.net' })],
        ]),
      );

      const result = await svc.list({ activeOnly: true });

      expect(repo.updateDeviceProfile).toHaveBeenCalledWith('i1', {
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
        // number changed (null → value) → warm-up ramp (re)started
        warmupStartedAt: expect.any(Date),
      });
      expect(result[0]).toMatchObject({ phoneE164: '+559231550102', profileName: 'ORGAMIND' });
    });

    it('skips the persist when the stored profile already matches', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({
          phoneE164: '+559231550102',
          profileName: 'ORGAMIND',
          profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
        }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', {
            ownerJid: '559231550102@s.whatsapp.net',
            profileName: 'ORGAMIND',
            profilePicUrl: 'https://pps.whatsapp.net/pic.jpg',
          })],
        ]),
      );

      await svc.list({ activeOnly: true });

      expect(repo.updateDeviceProfile).not.toHaveBeenCalled();
    });

    it('still returns the fresh profile when the persist fails', async () => {
      repo.listActiveWithState.mockResolvedValue([row()] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', {
            ownerJid: '559231550102@s.whatsapp.net',
            profileName: 'ORGAMIND',
            profilePicUrl: null,
          })],
        ]),
      );
      repo.updateDeviceProfile.mockRejectedValue(new Error('db down'));

      const result = await svc.list({ activeOnly: true });

      expect(result[0]).toMatchObject({
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: null,
      });
    });

    it('heals profile AND connection state together when both drifted', async () => {
      repo.listActiveWithState.mockResolvedValue([
        row({ lastConnectionState: 'close' }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', {
            ownerJid: '559231550102@s.whatsapp.net',
            profileName: 'ORGAMIND',
            profilePicUrl: null,
          })],
        ]),
      );

      const result = await svc.list({ activeOnly: true });

      expect(repo.recordConnectionEvent).toHaveBeenCalledWith('i1', 'open');
      expect(repo.updateDeviceProfile).toHaveBeenCalledWith('i1', {
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
        profilePictureUrl: null,
        // number changed (null → value) → warm-up ramp (re)started
        warmupStartedAt: expect.any(Date),
      });
      expect(result[0]).toMatchObject({
        lastConnectionState: 'open',
        phoneE164: '+559231550102',
        profileName: 'ORGAMIND',
      });
    });
  });

  // Anti-ban warm-up: the ramp restarts only when the NUMBER changes (a
  // re-pairing), never on a name/photo-only drift, and list() surfaces the
  // computed warm-up fields the quota panel reads.
  describe('list — warm-up ramp', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const wrow = (over: Record<string, unknown> = {}) => ({
      id: 'i1',
      evolutionInstanceName: 'evo-1',
      isActive: true,
      lastConnectionState: 'open',
      phoneE164: '+559231550102',
      profileName: 'ORGAMIND',
      profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
      dailySendLimit: 500,
      warmupStartedAt: new Date(Date.now() - 10 * DAY), // fully warmed
      ...over,
    });

    it('does NOT reset warm-up when only the name/photo drifts (same number)', async () => {
      repo.listActiveWithState.mockResolvedValue([wrow()] as any);
      evolution.listConnectionStates.mockResolvedValue(
        new Map([
          ['evo-1', snap('open', {
            ownerJid: '559231550102@s.whatsapp.net', // SAME number
            profileName: 'ORGAMIND NOVO', // name drifted
            profilePicUrl: 'https://pps.whatsapp.net/pic.jpg',
          })],
        ]),
      );

      await svc.list({ activeOnly: true });

      expect(repo.updateDeviceProfile).toHaveBeenCalledTimes(1);
      // The profile is persisted, but warmupStartedAt must NOT be passed —
      // otherwise the number would perpetually restart its ramp and never graduate.
      expect(repo.updateDeviceProfile.mock.calls[0][1].warmupStartedAt).toBeUndefined();
    });

    it('attaches computed warmupEffectiveCap / warming / warmupDay', async () => {
      // day-1 number (warmupStartedAt = now) with configured cap 500.
      repo.listActiveWithState.mockResolvedValue([
        wrow({ warmupStartedAt: new Date() }),
      ] as any);
      evolution.listConnectionStates.mockResolvedValue(new Map()); // skip reconcile

      const result = await svc.list({ activeOnly: true });

      expect(result[0]).toMatchObject({
        warmupEffectiveCap: 50,
        warming: true,
        warmupDay: 1,
      });
    });

    it('a fully-warmed number reports the full configured cap and warming=false', async () => {
      repo.listActiveWithState.mockResolvedValue([wrow()] as any); // 10 days old
      evolution.listConnectionStates.mockResolvedValue(new Map());

      const result = await svc.list({ activeOnly: true });

      expect(result[0]).toMatchObject({ warmupEffectiveCap: 500, warming: false });
    });
  });

  // F6: instance lifecycle must be auditable — mirrors campaigns' audit trail.
  describe('audit trail', () => {
    it('create logs instance.create after the row is persisted', async () => {
      evo.createInstance.mockResolvedValue({ apiKey: '' });
      repo.findByEvolutionName.mockResolvedValue(null);
      repo.create.mockResolvedValue({
        id: 'inst1', name: 'Vendas', evolutionInstanceName: 'picoa-vendas-x',
        apiKey: '', isDefault: false, isActive: true,
      } as any);

      await svc.create({ name: 'Vendas' });

      expect(audit.log).toHaveBeenCalledWith(
        'instance.create',
        'WhatsappInstance',
        'inst1',
        expect.objectContaining({
          name: 'Vendas',
          evolutionInstanceName: 'picoa-vendas-x',
        }),
      );
    });

    it('create does not log when Evolution provisioning fails', async () => {
      evo.createInstance.mockRejectedValue(new Error('limit reached'));
      repo.findByEvolutionName.mockResolvedValue(null);

      await expect(svc.create({ name: 'X' })).rejects.toThrow(InstanceCreationFailedError);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('delete logs instance.delete after the soft-delete succeeds', async () => {
      repo.findById.mockResolvedValue({
        id: 'i', name: 'Vendas', evolutionInstanceName: 'evo-1', isActive: true,
      } as any);
      repo.softDelete.mockResolvedValue({ id: 'i' } as any);
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      await svc.delete('i');

      expect(audit.log).toHaveBeenCalledWith(
        'instance.delete',
        'WhatsappInstance',
        'i',
        expect.objectContaining({
          name: 'Vendas',
          evolutionInstanceName: 'evo-1',
        }),
      );
    });

    it('setDefault logs instance.set_default after it succeeds', async () => {
      repo.findById.mockResolvedValue({
        id: 'i', name: 'Vendas', evolutionInstanceName: 'evo-1', isActive: true,
      } as any);

      await svc.setDefault('i');

      expect(audit.log).toHaveBeenCalledWith(
        'instance.set_default',
        'WhatsappInstance',
        'i',
        expect.objectContaining({
          name: 'Vendas',
          evolutionInstanceName: 'evo-1',
        }),
      );
    });

    it('setDefault does not log when the instance is missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(svc.setDefault('missing')).rejects.toThrow(InstanceNotFoundError);
      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});
