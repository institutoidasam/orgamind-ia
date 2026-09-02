import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService.getDashboard', () => {
  const repo = {
    countRunningCampaigns: vi.fn(),
    countActiveContacts: vi.fn(),
    countApprovedTemplates: vi.fn(),
    deliveryRate7d: vi.fn(),
    messageSparkline7d: vi.fn(),
    campaignSparkline7d: vi.fn(),
    contactSparkline7d: vi.fn(),
    templateSparkline7d: vi.fn(),
    liveFlowCounts: vi.fn(),
  };

  const redis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };

  beforeEach(() => {
    Object.values(repo).forEach((m) => m.mockReset());
    repo.countRunningCampaigns.mockResolvedValue(2);
    repo.countActiveContacts.mockResolvedValue(150);
    repo.countApprovedTemplates.mockResolvedValue(4);
    repo.deliveryRate7d.mockResolvedValue(83);
    repo.campaignSparkline7d.mockResolvedValue([1, 1, 0, 1, 0, 0, 1]);
    repo.contactSparkline7d.mockResolvedValue([2, 3, 1, 4, 0, 1, 2]);
    repo.templateSparkline7d.mockResolvedValue([0, 0, 0, 1, 0, 0, 0]);
    repo.messageSparkline7d.mockResolvedValue([10, 12, 8, 15, 11, 9, 14]);
    repo.liveFlowCounts.mockResolvedValue({
      queued: 1,
      sent: 2,
      delivered: 3,
      read: 4,
      failed: 0,
    });
  });

  it('returns the four metric blocks with sparklines', async () => {
    const svc = new MetricsService(repo as never, redis as never);
    const out = await svc.getDashboard();
    expect(out.activeCampaigns).toEqual({
      count: 2,
      meta: 'em curso agora',
      sparkline: [1, 1, 0, 1, 0, 0, 1],
    });
    expect(out.activeContacts.count).toBe(150);
    expect(out.approvedTemplates.count).toBe(4);
    expect(out.deliveryRate7d.count).toBe(83);
    expect(out.liveFlow).toEqual({
      queued: 1,
      sent: 2,
      delivered: 3,
      read: 4,
      failed: 0,
    });
  });
});
