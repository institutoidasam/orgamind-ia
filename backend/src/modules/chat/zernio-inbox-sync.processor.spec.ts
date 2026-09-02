import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Job, Queue } from 'bullmq';
import { ZernioInboxSyncProcessor } from './zernio-inbox-sync.processor';
import { ZernioInboxSyncService } from './zernio-inbox-sync.service';
import { ZernioSyncRunsService } from './zernio-sync-runs.service';

const CHANNEL = 'ch1';
const job = (data: unknown) => ({ data }) as Job;

describe('ZernioInboxSyncProcessor', () => {
  let sync: MockProxy<ZernioInboxSyncService>;
  let runs: MockProxy<ZernioSyncRunsService>;
  let queue: MockProxy<Queue>;
  let proc: ZernioInboxSyncProcessor;

  beforeEach(() => {
    sync = mockDeep<ZernioInboxSyncService>();
    runs = mockDeep<ZernioSyncRunsService>();
    queue = mockDeep<Queue>();
    proc = new ZernioInboxSyncProcessor(sync, runs, queue as unknown as Queue);
    runs.get.mockResolvedValue({ id: 'run1', channelId: CHANNEL, cursor: null } as never);
  });

  // O tick repetível (a cada 10 min) continua existindo: é a rede de segurança.
  it('job SEM runId = tick repetível: varre todos os canais', async () => {
    sync.syncAllChannels.mockResolvedValue({
      channels: 1,
      conversations: 3,
      messages: 4,
      failed: 0,
    });

    await proc.process(job({}));

    expect(sync.syncAllChannels).toHaveBeenCalled();
    expect(sync.syncChannel).not.toHaveBeenCalled();
  });

  it('job COM runId = sync manual: roda o canal e fecha o run', async () => {
    sync.syncChannel.mockResolvedValue({ conversations: 100, messages: 300, failed: 0 });

    await proc.process(job({ runId: 'run1', channelId: CHANNEL }));

    expect(runs.markRunning).toHaveBeenCalledWith('run1');
    expect(sync.syncChannel).toHaveBeenCalledWith(CHANNEL, expect.anything());
    expect(runs.finish).toHaveBeenCalledWith(
      'run1',
      expect.objectContaining({ conversations: 100, messages: 300 }),
    );
  });

  /**
   * O 429 que virou 500 morava aqui: a exceção subia até o controller. Agora ela
   * morre no job — o run vira FAILED com o motivo, e a TELA mostra o motivo.
   */
  it('erro no meio NÃO explode o worker: marca o run como FAILED com o motivo', async () => {
    sync.syncChannel.mockRejectedValue(new Error('429 do Zernio'));

    await proc.process(job({ runId: 'run1', channelId: CHANNEL }));

    expect(runs.fail).toHaveBeenCalledWith('run1', expect.any(Error));
  });

  it('retoma do cursor salvo quando o run foi interrompido', async () => {
    runs.get.mockResolvedValue({
      id: 'run1',
      channelId: CHANNEL,
      cursor: 'CUR2',
    } as never);
    sync.syncChannel.mockResolvedValue({ conversations: 1, messages: 1, failed: 0 });

    await proc.process(job({ runId: 'run1', channelId: CHANNEL }));

    expect(sync.syncChannel).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({ startCursor: 'CUR2' }),
    );
  });

  /**
   * O sync cedeu o balde para uma campanha. Ele NÃO pode virar SUCCEEDED (não
   * terminou) nem FAILED (não deu erro): fica PAUSED e volta sozinho depois —
   * quando a campanha tiver acabado.
   */
  it('sync que cedeu o balde: run vira PAUSED e volta reenfileirado com delay', async () => {
    sync.syncChannel.mockResolvedValue({
      conversations: 12,
      messages: 30,
      failed: 0,
      paused: true,
      resumeCursor: 'CUR2',
    });

    await proc.process(job({ runId: 'run1', channelId: CHANNEL }));

    expect(runs.markPaused).toHaveBeenCalledWith('run1');
    expect(runs.finish).not.toHaveBeenCalled(); // não acabou!
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ runId: 'run1', channelId: CHANNEL }),
      expect.objectContaining({ delay: expect.any(Number) }),
    );
  });

  it('o progresso do sync é persistido no run (a tela lê daí)', async () => {
    sync.syncChannel.mockImplementation(async (_ch, opts) => {
      await opts!.onProgress!({
        total: 100,
        processed: 42,
        imported: 137,
        failed: 1,
        nextCursor: 'CUR2',
      });
      return { conversations: 100, messages: 300, failed: 1 };
    });

    await proc.process(job({ runId: 'run1', channelId: CHANNEL }));

    expect(runs.saveProgress).toHaveBeenCalledWith(
      'run1',
      expect.objectContaining({
        totalConversations: 100,
        processedConversations: 42,
        importedMessages: 137,
        failedConversations: 1,
        cursor: 'CUR2',
      }),
    );
  });
});
