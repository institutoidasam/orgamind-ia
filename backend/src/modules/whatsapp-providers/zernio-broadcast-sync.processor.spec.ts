import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Job, Queue } from 'bullmq';
import {
  ZernioBroadcastSyncProcessor,
  ZERNIO_ANALYTICS_JOB,
} from './zernio-broadcast-sync.processor';
import type { ZernioBroadcastSyncService } from './zernio-broadcast-sync.service';
import type { ZernioAnalyticsSyncService } from './zernio-analytics-sync.service';

const job = (name: string, data: Record<string, unknown> = {}) =>
  ({ name, data }) as unknown as Job;

describe('ZernioBroadcastSyncProcessor', () => {
  let sync: MockProxy<ZernioBroadcastSyncService>;
  let analytics: MockProxy<ZernioAnalyticsSyncService>;
  let queue: MockProxy<Queue>;
  let processor: ZernioBroadcastSyncProcessor;

  beforeEach(() => {
    sync = mockDeep<ZernioBroadcastSyncService>();
    analytics = mockDeep<ZernioAnalyticsSyncService>();
    queue = mockDeep<Queue>();
    sync.syncBroadcasts.mockResolvedValue({
      broadcasts: 2,
      skipped: 0,
      failed: 0,
      channels: 1,
    });
    analytics.syncSnapshots.mockResolvedValue({ days: 7, channels: 1, failed: 0 });
    processor = new ZernioBroadcastSyncProcessor(sync, analytics, queue);
  });

  it('o tick de 15 min espelha os disparos', async () => {
    await processor.process(job('sync-broadcasts'));

    expect(sync.syncBroadcasts).toHaveBeenCalledWith({ startSkip: undefined });
    expect(analytics.syncSnapshots).not.toHaveBeenCalled();
  });

  it('o job diário (mesma fila, outro nome) faz o snapshot de volume', async () => {
    await processor.process(job(ZERNIO_ANALYTICS_JOB));

    expect(analytics.syncSnapshots).toHaveBeenCalled();
    expect(sync.syncBroadcasts).not.toHaveBeenCalled();
  });

  it('quando o sync CEDE o balde, reagenda a retomada a partir do skip', async () => {
    sync.syncBroadcasts.mockResolvedValue({
      broadcasts: 1,
      skipped: 0,
      failed: 0,
      channels: 1,
      paused: true,
      resumeSkip: 100,
    });

    await processor.process(job('sync-broadcasts'));

    expect(queue.add).toHaveBeenCalledWith(
      'sync-broadcasts-resume',
      { startSkip: 100 },
      { delay: 60_000 },
    );
  });

  it('a retomada continua do offset que o run anterior deixou', async () => {
    await processor.process(job('sync-broadcasts-resume', { startSkip: 200 }));

    expect(sync.syncBroadcasts).toHaveBeenCalledWith({ startSkip: 200 });
  });

  it('sync que terminou NÃO reagenda nada', async () => {
    await processor.process(job('sync-broadcasts'));

    expect(queue.add).not.toHaveBeenCalled();
  });
});
