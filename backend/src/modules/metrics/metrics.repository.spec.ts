import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MetricsRepository } from './metrics.repository';

describe('MetricsRepository', () => {
  let prisma: {
    campaign: { count: ReturnType<typeof vi.fn> };
    contact: { count: ReturnType<typeof vi.fn> };
    template: { count: ReturnType<typeof vi.fn> };
    message: { count: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let repo: MetricsRepository;

  beforeEach(() => {
    prisma = {
      campaign: { count: vi.fn() },
      contact: { count: vi.fn() },
      template: { count: vi.fn() },
      message: { count: vi.fn(), groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    };
    repo = new MetricsRepository(prisma as never);
  });

  it('countRunningCampaigns delegates to prisma', async () => {
    prisma.campaign.count.mockResolvedValueOnce(3);
    expect(await repo.countRunningCampaigns()).toBe(3);
    expect(prisma.campaign.count).toHaveBeenCalledWith({
      where: { status: 'RUNNING' },
    });
  });

  it('countActiveContacts excludes opted-out contacts', async () => {
    prisma.contact.count.mockResolvedValueOnce(42);
    expect(await repo.countActiveContacts()).toBe(42);
    expect(prisma.contact.count).toHaveBeenCalledWith({
      where: { optedOut: false },
    });
  });

  it('countApprovedTemplates filters by APPROVED status', async () => {
    prisma.template.count.mockResolvedValueOnce(7);
    expect(await repo.countApprovedTemplates()).toBe(7);
    expect(prisma.template.count).toHaveBeenCalledWith({
      where: { status: 'APPROVED' },
    });
  });

  it('deliveryRate7d returns 0 when no terminal-status messages in window', async () => {
    prisma.message.groupBy.mockResolvedValueOnce([]); // no rows at all
    expect(await repo.deliveryRate7d()).toBe(0);
    // Single round-trip — no sequential COUNTs.
    expect(prisma.message.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.message.count).not.toHaveBeenCalled();
  });

  it('deliveryRate7d divides by terminal outcomes only (excludes QUEUED/SENT) in one groupBy', async () => {
    // groupBy returns per-status counts; only DELIVERED/READ/FAILED count toward
    // the denominator, DELIVERED/READ toward the numerator. QUEUED/SENT ignored.
    prisma.message.groupBy.mockResolvedValueOnce([
      { status: 'DELIVERED', _count: { _all: 100 } },
      { status: 'READ', _count: { _all: 50 } },
      { status: 'FAILED', _count: { _all: 50 } },
      { status: 'QUEUED', _count: { _all: 999 } },
      { status: 'SENT', _count: { _all: 999 } },
    ]);
    expect(await repo.deliveryRate7d()).toBe(75); // (100+50) / (100+50+50)
    expect(prisma.message.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.message.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['status'],
        where: expect.objectContaining({
          queuedAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });
});
