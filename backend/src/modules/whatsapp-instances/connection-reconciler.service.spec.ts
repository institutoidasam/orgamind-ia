import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import {
  ConnectionReconcilerService,
  WEBHOOK_CHECK_INTERVAL_MS,
} from './connection-reconciler.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { Logger } from '@nestjs/common';

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

// Dublê mínimo de uma linha de instância ativa (só os campos que o reconciler lê).
const row = (id: string, evolutionInstanceName: string | null) =>
  ({ id, evolutionInstanceName }) as never;

describe('ConnectionReconcilerService — log de falha', () => {
  it('falha do reconcileOne loga sem o objeto de erro (sem apikey)', async () => {
    const instancesRepo = mockDeep<WhatsappInstancesRepository>();
    const evolutionAdapter = mockDeep<EvolutionApiAdapter>();
    const svc = new ConnectionReconcilerService(
      instancesRepo,
      mockDeep<WhatsappProvidersRepository>(),
      evolutionAdapter,
    );
    instancesRepo.listActive.mockResolvedValueOnce([
      row('inst-1', 'picoa-inst1-aaa'),
    ]);
    const axiosLike = Object.assign(new Error('Request failed'), {
      config: { headers: { apikey: 'segredo-x' } },
    });
    evolutionAdapter.getLiveConnectionState.mockRejectedValueOnce(axiosLike);

    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    try {
      await svc.process();
      const calls = [...warn.mock.calls, ...log.mock.calls];
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(JSON.stringify(args)).not.toContain('segredo-x');
        expect(args[0]).not.toHaveProperty('err');
      }
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

// ─── E1: conferência do webhook (no máximo 1x por 10 min por canal) ─────────

// Dublês explícitos (vi.fn) em vez de mockDeep: dão acesso a .mock sem
// referenciar métodos soltos, que o lint do projeto proíbe.
function buildWebhookHarness() {
  const armed = vi.fn().mockResolvedValue({ status: 'ok', fields: [] });
  const createEvent = vi.fn();
  const live = vi.fn().mockResolvedValue(null);
  const listActive = vi
    .fn()
    .mockResolvedValue([
      row('inst-1', 'picoa-inst1-aaa'),
      row('inst-2', 'picoa-inst2-bbb'),
    ]);
  const webhookSvc = new ConnectionReconcilerService(
    { listActive } as unknown as WhatsappInstancesRepository,
    {
      findLastEvent: vi.fn().mockResolvedValue(null),
      createEvent,
    } as unknown as WhatsappProvidersRepository,
    {
      getLiveConnectionState: live,
      ensureWebhookArmed: armed,
    } as unknown as EvolutionApiAdapter,
  );
  return { armed, createEvent, live, listActive, webhookSvc };
}

// Registra o setup/teardown do harness no describe que a chamar e devolve o
// objeto que o beforeEach preenche a cada teste.
function useWebhookHarness() {
  const h = {} as ReturnType<typeof buildWebhookHarness>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    Object.assign(h, buildWebhookHarness());
  });
  afterEach(() => vi.useRealTimers());
  return h;
}

describe('process — webhook conferido', () => {
  const h = useWebhookHarness();

  it('primeiro ciclo confere o webhook de cada instância Evolution', async () => {
    await h.webhookSvc.process();

    expect(h.armed.mock.calls).toEqual([
      ['picoa-inst1-aaa'],
      ['picoa-inst2-bbb'],
    ]);
  });

  it('novo ciclo antes de 10 min não confere; depois de 10 min confere', async () => {
    await h.webhookSvc.process();
    h.armed.mockClear();

    vi.setSystemTime(Date.now() + WEBHOOK_CHECK_INTERVAL_MS - 1);
    await h.webhookSvc.process();
    expect(h.armed).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 1);
    await h.webhookSvc.process();
    expect(h.armed).toHaveBeenCalledTimes(2);
  });

  it('instância sem evolutionInstanceName não é conferida', async () => {
    h.listActive.mockResolvedValue([row('inst-1', null)]);

    await h.webhookSvc.process();

    expect(h.armed).not.toHaveBeenCalled();
  });
});

describe('process — webhook: falha e remoção de instância', () => {
  const h = useWebhookHarness();

  it('ensureWebhookArmed rejeitando não interrompe as outras instâncias nem o reconcile', async () => {
    h.live.mockResolvedValue('open');
    h.armed.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { response: { status: 500 } }),
    );

    await expect(h.webhookSvc.process()).resolves.toBeUndefined();

    // O estado das duas foi reconciliado (a conferência vem depois) e a
    // segunda ainda foi conferida apesar da falha da primeira.
    expect(h.createEvent).toHaveBeenCalledTimes(2);
    expect(h.armed).toHaveBeenCalledTimes(2);
  });

  it('instância removida sai do mapa de conferência do webhook', async () => {
    const t0 = Date.now();
    await h.webhookSvc.process(); // ciclo 1: A e B conferidas
    h.listActive.mockResolvedValue([row('inst-1', 'picoa-inst1-aaa')]);
    vi.setSystemTime(t0 + 60_000);
    await h.webhookSvc.process(); // ciclo 2: só A
    h.listActive.mockResolvedValue([
      row('inst-1', 'picoa-inst1-aaa'),
      row('inst-2', 'picoa-inst2-bbb'),
    ]);
    h.armed.mockClear();
    vi.setSystemTime(t0 + 120_000); // ciclo 3: B volta dentro da janela de 10 min
    await h.webhookSvc.process();

    expect(h.armed.mock.calls).toEqual([['picoa-inst2-bbb']]);
  });
});
