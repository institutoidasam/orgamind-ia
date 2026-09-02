import { describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { WhatsappInstancesController } from './whatsapp-instances.controller';
import { WhatsappInstancesService } from './whatsapp-instances.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

describe('WhatsappInstancesController', () => {
  let ctrl: WhatsappInstancesController;
  let svc: MockProxy<WhatsappInstancesService>;
  let repo: MockProxy<WhatsappInstancesRepository>;
  let prisma: MockProxy<PrismaService>;
  let evolution: MockProxy<EvolutionApiAdapter>;

  beforeEach(async () => {
    svc = mockDeep<WhatsappInstancesService>();
    repo = mockDeep<WhatsappInstancesRepository>();
    prisma = mockDeep<PrismaService>();
    evolution = mockDeep<EvolutionApiAdapter>();
    const mod = await Test.createTestingModule({
      controllers: [WhatsappInstancesController],
      providers: [
        { provide: WhatsappInstancesService, useValue: svc },
        { provide: WhatsappInstancesRepository, useValue: repo },
        { provide: PrismaService, useValue: prisma },
        { provide: EvolutionApiAdapter, useValue: evolution },
      ],
    }).compile();
    ctrl = mod.get(WhatsappInstancesController);
  });

  // Prod incident: soft-deleted (isActive=false) instances stayed visible to
  // ADMINs because list() passed activeOnly=false for them — operators then
  // pinned campaigns to deleted instances and every send failed. Soft-deleted
  // rows must never be listed, regardless of role.
  it('GET /whatsapp/instances lists active-only for EVERY role (soft-deleted never listed)', async () => {
    svc.list.mockResolvedValueOnce([{ id: '1', lastConnectionState: 'open' } as any]);
    const operator = await ctrl.list({ user: { role: 'OPERATOR' } } as any);
    expect(svc.list).toHaveBeenLastCalledWith({ activeOnly: true });
    expect(operator).toEqual([{ id: '1', lastConnectionState: 'open' }]);

    svc.list.mockResolvedValueOnce([{ id: '1', lastConnectionState: 'open' } as any]);
    const admin = await ctrl.list({ user: { role: 'ADMIN' } } as any);
    expect(svc.list).toHaveBeenLastCalledWith({ activeOnly: true });
    expect(admin).toEqual([{ id: '1', lastConnectionState: 'open' }]);
  });

  // T8: multi-provider channels — the existing instance listing gains
  // `provider` in its response without a shape change; it already flows
  // through the plain-object pass-through in svc.list()/findById(), this
  // just locks it at the HTTP-surface boundary too.
  it('GET /whatsapp/instances surfaces the provider field on every row', async () => {
    svc.list.mockResolvedValueOnce([
      { id: '1', provider: 'TWILIO', lastConnectionState: null } as any,
    ]);
    const result = await ctrl.list({ user: { role: 'OPERATOR' } } as any);
    expect(result[0]).toMatchObject({ id: '1', provider: 'TWILIO' });
  });

  it('GET /whatsapp/instances/:id delegates to service.findById', async () => {
    svc.findById.mockResolvedValue({ id: 'i', lastConnectionState: 'open' } as any);
    const res = await ctrl.get('i');
    expect(svc.findById).toHaveBeenCalledWith('i');
    expect(res.id).toBe('i');
  });

  it('POST /whatsapp/instances delegates to service.create', async () => {
    svc.create.mockResolvedValue({ id: 'new', lastConnectionState: null } as any);
    const res = await ctrl.create({ name: 'Vendas' } as any);
    expect(svc.create).toHaveBeenCalledWith({
      name: 'Vendas',
      ownerUserId: undefined,
      isDefault: undefined,
    });
    expect(res).toEqual({ id: 'new', lastConnectionState: null });
  });

  it('PATCH /whatsapp/instances/:id with isDefault=true calls service.setDefault', async () => {
    repo.findById.mockResolvedValue({ id: 'i' } as any);
    svc.findById.mockResolvedValue({ id: 'i', lastConnectionState: 'open' } as any);
    prisma.channel.update.mockResolvedValue({} as any);
    await ctrl.update('i', { isDefault: true } as any);
    expect(svc.setDefault).toHaveBeenCalledWith('i');
  });

  it('PATCH /whatsapp/instances/:id with anti-ban changes updates via prisma', async () => {
    repo.findById.mockResolvedValue({ id: 'i' } as any);
    svc.findById.mockResolvedValue({ id: 'i', lastConnectionState: null } as any);
    prisma.channel.update.mockResolvedValue({} as any);
    await ctrl.update('i', { dailySendLimit: 750, sendWindowEnabled: false } as any);
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'i' },
      data: { dailySendLimit: 750, sendWindowEnabled: false },
    });
    expect(svc.setDefault).not.toHaveBeenCalled();
    // DB-only fields must NOT be pushed to Evolution.
    expect(evolution.setSettings).not.toHaveBeenCalled();
  });

  it('PATCH /whatsapp/instances/:id pushes Baileys settings to Evolution', async () => {
    repo.findById.mockResolvedValue({ id: 'i', evolutionInstanceName: 'inst-xyz' } as any);
    svc.findById.mockResolvedValue({ id: 'i', lastConnectionState: 'open' } as any);
    prisma.channel.update.mockResolvedValue({} as any);
    await ctrl.update('i', { rejectCall: false, alwaysOnline: true } as any);
    expect(evolution.setSettings).toHaveBeenCalledWith(
      { rejectCall: false, alwaysOnline: true },
      'inst-xyz',
    );
  });

  it('PATCH /whatsapp/instances/:id only forwards Baileys keys to Evolution, not DB-only ones', async () => {
    repo.findById.mockResolvedValue({ id: 'i', evolutionInstanceName: 'inst-xyz' } as any);
    svc.findById.mockResolvedValue({ id: 'i', lastConnectionState: 'open' } as any);
    prisma.channel.update.mockResolvedValue({} as any);
    await ctrl.update('i', { groupsIgnore: true, dailySendLimit: 500 } as any);
    // Full row still persisted to the DB.
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'i' },
      data: { groupsIgnore: true, dailySendLimit: 500 },
    });
    // Only the Baileys flag reaches Evolution.
    expect(evolution.setSettings).toHaveBeenCalledWith({ groupsIgnore: true }, 'inst-xyz');
  });

  it('POST /whatsapp/instances/:id/restart delegates to service.restart', async () => {
    await ctrl.restart('i');
    expect(svc.restart).toHaveBeenCalledWith('i');
  });

  it('DELETE /whatsapp/instances/:id delegates to service.delete', async () => {
    await ctrl.remove('i');
    expect(svc.delete).toHaveBeenCalledWith('i');
  });

  // The connection panel used to show only "desconectado" with no reason. The
  // /qr response now carries a human-readable disconnect reason + guidance so
  // the operator understands WHY the number dropped (e.g. WhatsApp anti-spam
  // logout after a cold bulk) and what to do next.
  describe('GET /:id/qr surfaces the disconnect reason', () => {
    it('includes a human-readable reason + guidance when disconnected with a reason code', async () => {
      svc.findById.mockResolvedValueOnce({ id: 'i', evolutionInstanceName: 'inst-1' } as any);
      evolution.getConnectionInfo.mockResolvedValueOnce({
        state: 'close',
        disconnectionReasonCode: 401,
        disconnectionAt: '2026-07-10T20:28:43.000Z',
      } as any);
      const res = await ctrl.qr('i');
      expect(res.disconnectionReasonCode).toBe(401);
      expect(res.disconnectionAt).toBe('2026-07-10T20:28:43.000Z');
      expect(res.disconnectionReason?.message).toMatch(/deslogada|dispositivo/i);
      expect(res.disconnectionReason?.guidance).toMatch(/Twilio/i);
    });

    it('does NOT surface a stale reason when the instance is connected (state open)', async () => {
      svc.findById.mockResolvedValueOnce({ id: 'i', evolutionInstanceName: 'inst-1' } as any);
      evolution.getConnectionInfo.mockResolvedValueOnce({
        state: 'open',
        disconnectionReasonCode: 401, // stale — Evolution keeps it after a re-pair
      } as any);
      const res = await ctrl.qr('i');
      expect(res.disconnectionReason).toBeNull();
    });

    it('reason is null when there is no reason code', async () => {
      svc.findById.mockResolvedValueOnce({ id: 'i', evolutionInstanceName: 'inst-1' } as any);
      evolution.getConnectionInfo.mockResolvedValueOnce({ state: 'close' } as any);
      const res = await ctrl.qr('i');
      expect(res.disconnectionReason).toBeNull();
      expect(res.disconnectionReasonCode).toBeNull();
    });
  });

  // A5: the apiKey leak is fixed by the repo `omit` (role-independent), so
  // list/get stay OPERATOR-readable — they feed the connection-status indicator
  // and read-only instance views across the app. Only provisioning (qr) and the
  // mutating routes are ADMIN-gated.
  describe('role gating', () => {
    it('GET / (list) stays OPERATOR-readable (not ADMIN-gated)', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, ctrl.list);
      expect(roles).toBeUndefined();
    });

    it('GET /:id (get) stays OPERATOR-readable (not ADMIN-gated)', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, ctrl.get);
      expect(roles).toBeUndefined();
    });

    it('GET /:id/qr (provisioning) requires ADMIN', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, ctrl.qr);
      expect(roles).toEqual(['ADMIN']);
    });
  });
});
