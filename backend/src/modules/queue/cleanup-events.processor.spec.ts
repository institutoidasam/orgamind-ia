import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CleanupEventsProcessor } from './cleanup-events.processor';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { subDays } from 'date-fns';

function makeRepo() {
  return {
    deleteOldEvents: vi.fn().mockResolvedValue(0),
  } as unknown as WhatsappProvidersRepository;
}

describe('CleanupEventsProcessor', () => {
  let processor: CleanupEventsProcessor;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
    processor = new CleanupEventsProcessor(repo);
  });

  it('calls deleteOldEvents with a cutoff of 7 days ago', async () => {
    const before = new Date();
    await processor.process();
    const call = (repo.deleteOldEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as Date;
    const after = new Date();

    // cutoff should be ~7 days before call time
    const sevenDaysAgo = subDays(before, 7);
    const delta = Math.abs(call.getTime() - sevenDaysAgo.getTime());
    expect(delta).toBeLessThan(5000); // within 5s of expected
    expect(call.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('logs the number of deleted rows', async () => {
    (repo.deleteOldEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(42);
    // Just ensures no error is thrown; logging is fire-and-forget
    await expect(processor.process()).resolves.toBeUndefined();
  });

  it('resolves even when deleteOldEvents throws (defensive)', async () => {
    (repo.deleteOldEvents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB down'));
    await expect(processor.process()).resolves.toBeUndefined();
  });
});
