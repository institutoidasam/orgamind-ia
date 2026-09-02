import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import { ZernioInboxSyncController } from './zernio-inbox-sync.controller';
import { ZernioSyncRunsService } from './zernio-sync-runs.service';

const CHANNEL = 'ch1';
const run = (over: Record<string, unknown> = {}) => ({
  id: 'run1',
  channelId: CHANNEL,
  status: 'PENDING',
  totalConversations: 0,
  processedConversations: 0,
  importedMessages: 0,
  failedConversations: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe('ZernioInboxSyncController', () => {
  let runs: MockProxy<ZernioSyncRunsService>;
  let queue: MockProxy<Queue>;
  let ctrl: ZernioInboxSyncController;

  beforeEach(() => {
    runs = mockDeep<ZernioSyncRunsService>();
    queue = mockDeep<Queue>();
    ctrl = new ZernioInboxSyncController(runs, queue as unknown as Queue);
  });

  /**
   * O CORAÇÃO da correção. Antes o POST era SÍNCRONO: percorria ~100 conversas
   * (1 requisição ao Zernio cada) dentro da request do operador. Estourava o
   * balde de 60 req/min, tomava 429 e devolvia **HTTP 500** — depois de segurar
   * a tela por minutos. Agora ele ENFILEIRA e devolve na hora.
   */
  it('não sincroniza na request: enfileira e devolve o id da execução', async () => {
    runs.startOrReuse.mockResolvedValue({ run: run() as never, created: true });

    const res = await ctrl.syncInbox(CHANNEL);

    expect(res.runId).toBe('run1');
    expect(res.status).toBe('PENDING');
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ runId: 'run1', channelId: CHANNEL }),
      expect.anything(),
    );
  });

  it('clique repetido não enfileira um segundo sync (dobraria o consumo do balde)', async () => {
    runs.startOrReuse.mockResolvedValue({
      run: run({ status: 'RUNNING' }) as never,
      created: false,
    });

    const res = await ctrl.syncInbox(CHANNEL);

    expect(res.runId).toBe('run1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('status devolve o progresso do run mais recente ("42 de 100")', async () => {
    runs.latest.mockResolvedValue(
      run({
        status: 'RUNNING',
        totalConversations: 100,
        processedConversations: 42,
        importedMessages: 137,
        failedConversations: 1,
      }) as never,
    );

    const res = await ctrl.syncInboxStatus(CHANNEL);

    expect(res).toMatchObject({
      runId: 'run1',
      status: 'RUNNING',
      total: 100,
      processed: 42,
      imported: 137,
      failed: 1,
    });
  });

  it('status sem nenhum run: devolve status IDLE (a tela não quebra)', async () => {
    runs.latest.mockResolvedValue(null as never);

    const res = await ctrl.syncInboxStatus(CHANNEL);

    expect(res.status).toBe('IDLE');
    expect(res.runId).toBeNull();
  });
});
