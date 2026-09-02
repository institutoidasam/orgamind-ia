import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchedulerProcessor } from './scheduler.processor';
import type { CampaignsService } from '../campaigns/campaigns.service';

type CampaignsMock = {
  findDueScheduledCampaigns: ReturnType<typeof vi.fn>;
  runScheduled: ReturnType<typeof vi.fn>;
};

describe('SchedulerProcessor', () => {
  let campaigns: CampaignsMock;
  let proc: SchedulerProcessor;

  beforeEach(() => {
    campaigns = {
      findDueScheduledCampaigns: vi.fn(),
      runScheduled: vi.fn(),
    };
    const cls = {
      run: <T>(fn: () => T) => fn(),
      set: vi.fn(),
      get: vi.fn(),
    };
    proc = new SchedulerProcessor(
      campaigns as unknown as CampaignsService,
      cls as never,
    );
  });

  it('does nothing when no campaigns are due', async () => {
    campaigns.findDueScheduledCampaigns.mockResolvedValue([]);

    await proc.process();

    expect(campaigns.findDueScheduledCampaigns).toHaveBeenCalledTimes(1);
    expect(campaigns.runScheduled).not.toHaveBeenCalled();
  });

  it('dispatches every due campaign in order', async () => {
    campaigns.findDueScheduledCampaigns.mockResolvedValue([
      { id: 'c1', name: 'First' },
      { id: 'c2', name: 'Second' },
      { id: 'c3', name: 'Third' },
    ]);
    campaigns.runScheduled.mockResolvedValue({ queued: 1 });

    await proc.process();

    expect(campaigns.runScheduled).toHaveBeenCalledTimes(3);
    expect(campaigns.runScheduled.mock.calls.map((c) => c[0])).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('isolates failures so other campaigns still get dispatched', async () => {
    campaigns.findDueScheduledCampaigns.mockResolvedValue([
      { id: 'c1', name: 'First' },
      { id: 'c2', name: 'Second' },
      { id: 'c3', name: 'Third' },
    ]);
    campaigns.runScheduled
      .mockResolvedValueOnce({ queued: 5 })
      .mockRejectedValueOnce(new Error('boom in c2'))
      .mockResolvedValueOnce({ queued: 2 });

    await expect(proc.process()).resolves.toBeUndefined();

    expect(campaigns.runScheduled).toHaveBeenCalledTimes(3);
    expect(campaigns.runScheduled).toHaveBeenNthCalledWith(1, 'c1');
    expect(campaigns.runScheduled).toHaveBeenNthCalledWith(2, 'c2');
    expect(campaigns.runScheduled).toHaveBeenNthCalledWith(3, 'c3');
  });

  it('passes a current timestamp to findDueScheduledCampaigns', async () => {
    campaigns.findDueScheduledCampaigns.mockResolvedValue([]);
    const before = Date.now();

    await proc.process();

    const arg = campaigns.findDueScheduledCampaigns.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Date);
    expect((arg as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((arg as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
