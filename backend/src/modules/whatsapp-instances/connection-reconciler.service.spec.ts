import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ConnectionReconcilerService } from './connection-reconciler.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';

describe('ConnectionReconcilerService', () => {
  let svc: ConnectionReconcilerService;
  let instancesRepo: MockProxy<WhatsappInstancesRepository>;
  let providersRepo: MockProxy<WhatsappProvidersRepository>;
  let evolutionAdapter: MockProxy<EvolutionApiAdapter>;

  // A minimal WhatsappInstance shape for testing
  const makeInstance = (overrides: Partial<{ id: string; evolutionInstanceName: string }> = {}) => ({
    id: overrides.id ?? 'inst-1',
    evolutionInstanceName: overrides.evolutionInstanceName ?? 'picoa-test-aaa111',
    name: 'Test',
    apiKey: 'key',
    isActive: true,
    isDefault: false,
    ownerUserId: null,
    sentToday: 0,
    sentTodayResetAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    instancesRepo = mockDeep<WhatsappInstancesRepository>();
    providersRepo = mockDeep<WhatsappProvidersRepository>();
    evolutionAdapter = mockDeep<EvolutionApiAdapter>();

    svc = new ConnectionReconcilerService(instancesRepo, providersRepo, evolutionAdapter);
  });

  // ─── reconcileOne unit tests ────────────────────────────────────────────────

  describe('reconcileOne', () => {
    it('writes a corrective open event when live=open but stored=close', async () => {
      evolutionAdapter.getLiveConnectionState.mockResolvedValueOnce('open');
      providersRepo.findLastEvent.mockResolvedValueOnce({
        id: 'ev-1',
        instanceId: 'inst-1',
        state: 'close',
        reasonCode: null,
        occurredAt: new Date(),
      });

      const changed = await svc.reconcileOne('inst-1', 'picoa-test-aaa111');

      expect(changed).toBe(true);
      expect(providersRepo.createEvent).toHaveBeenCalledOnce();
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'inst-1',
          state: 'open',
          reasonCode: null,
        }),
      );
    });

    it('writes a corrective open event when live=open and there is no stored event (null)', async () => {
      evolutionAdapter.getLiveConnectionState.mockResolvedValueOnce('open');
      providersRepo.findLastEvent.mockResolvedValueOnce(null);

      const changed = await svc.reconcileOne('inst-1', 'picoa-test-aaa111');

      expect(changed).toBe(true);
      expect(providersRepo.createEvent).toHaveBeenCalledOnce();
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'open' }),
      );
    });

    it('writes a corrective close event when live=close but stored=open', async () => {
      evolutionAdapter.getLiveConnectionState.mockResolvedValueOnce('close');
      providersRepo.findLastEvent.mockResolvedValueOnce({
        id: 'ev-2',
        instanceId: 'inst-1',
        state: 'open',
        reasonCode: null,
        occurredAt: new Date(),
      });

      const changed = await svc.reconcileOne('inst-1', 'picoa-test-aaa111');

      expect(changed).toBe(true);
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'close', instanceId: 'inst-1' }),
      );
    });

    it('does NOT create an event when live state matches stored state', async () => {
      evolutionAdapter.getLiveConnectionState.mockResolvedValueOnce('open');
      providersRepo.findLastEvent.mockResolvedValueOnce({
        id: 'ev-3',
        instanceId: 'inst-1',
        state: 'open',
        reasonCode: null,
        occurredAt: new Date(),
      });

      const changed = await svc.reconcileOne('inst-1', 'picoa-test-aaa111');

      expect(changed).toBe(false);
      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });

    it('skips and returns false when live state is "connecting" (transient)', async () => {
      evolutionAdapter.getLiveConnectionState.mockResolvedValueOnce('connecting');

      const changed = await svc.reconcileOne('inst-1', 'picoa-test-aaa111');

      expect(changed).toBe(false);
      expect(providersRepo.findLastEvent).not.toHaveBeenCalled();
      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });

    it('skips and returns false when adapter returns null (poll failure)', async () => {
      evolutionAdapter.getLiveConnectionState.mockResolvedValueOnce(null);

      const changed = await svc.reconcileOne('inst-1', 'picoa-test-aaa111');

      expect(changed).toBe(false);
      expect(providersRepo.findLastEvent).not.toHaveBeenCalled();
      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });
  });

  // ─── process() integration tests ────────────────────────────────────────────

  describe('process', () => {
    it('reconciles all active instances and does not abort on per-instance failure', async () => {
      const inst1 = makeInstance({ id: 'inst-1', evolutionInstanceName: 'picoa-inst1-aaa' });
      const inst2 = makeInstance({ id: 'inst-2', evolutionInstanceName: 'picoa-inst2-bbb' });
      const inst3 = makeInstance({ id: 'inst-3', evolutionInstanceName: 'picoa-inst3-ccc' });

      instancesRepo.listActive.mockResolvedValueOnce([inst1, inst2, inst3] as any);

      // inst1: live=open, stored=close → drift → should write event
      evolutionAdapter.getLiveConnectionState
        .mockResolvedValueOnce('open')  // inst1
        .mockRejectedValueOnce(new Error('Network error'))  // inst2 throws at adapter level
        .mockResolvedValueOnce('close');  // inst3

      providersRepo.findLastEvent
        .mockResolvedValueOnce({ id: 'ev1', instanceId: 'inst-1', state: 'close', reasonCode: null, occurredAt: new Date() })
        // inst2 adapter throws, never reaches findLastEvent
        .mockResolvedValueOnce({ id: 'ev3', instanceId: 'inst-3', state: 'close', reasonCode: null, occurredAt: new Date() });

      await svc.process();

      // inst1 gets a corrective event
      expect(providersRepo.createEvent).toHaveBeenCalledOnce();
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-1', state: 'open' }),
      );
      // inst3 already matches — no extra event
    });

    it('does nothing when there are no active instances', async () => {
      instancesRepo.listActive.mockResolvedValueOnce([]);

      await svc.process();

      expect(evolutionAdapter.getLiveConnectionState).not.toHaveBeenCalled();
      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });

    it('one instance throwing does not prevent other instances from being processed', async () => {
      const inst1 = makeInstance({ id: 'inst-1', evolutionInstanceName: 'picoa-inst1-aaa' });
      const inst2 = makeInstance({ id: 'inst-2', evolutionInstanceName: 'picoa-inst2-bbb' });

      instancesRepo.listActive.mockResolvedValueOnce([inst1, inst2] as any);

      // inst1 throws unexpectedly
      evolutionAdapter.getLiveConnectionState
        .mockRejectedValueOnce(new Error('boom'))  // inst1
        .mockResolvedValueOnce('open');             // inst2

      providersRepo.findLastEvent.mockResolvedValueOnce(null); // inst2 has no history

      // Must not throw
      await expect(svc.process()).resolves.toBeUndefined();

      // inst2 still gets processed and reconciled
      expect(providersRepo.createEvent).toHaveBeenCalledOnce();
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'inst-2', state: 'open' }),
      );
    });
  });
});
