import { Injectable } from '@nestjs/common';
import { differenceInCalendarDays } from 'date-fns';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

type SparklineSpec = { table: Prisma.Sql; column: Prisma.Sql };

const SPARKLINE_SPECS: Record<'Message' | 'Campaign' | 'Contact' | 'Template', SparklineSpec> = {
  Message: { table: Prisma.sql`"Message"`, column: Prisma.sql`"queuedAt"` },
  Campaign: { table: Prisma.sql`"Campaign"`, column: Prisma.sql`"createdAt"` },
  Contact: { table: Prisma.sql`"Contact"`, column: Prisma.sql`"createdAt"` },
  Template: { table: Prisma.sql`"Template"`, column: Prisma.sql`"createdAt"` },
};

@Injectable()
export class MetricsRepository {
  constructor(private readonly prisma: PrismaService) {}

  countRunningCampaigns() {
    return this.prisma.campaign.count({ where: { status: 'RUNNING' } });
  }

  countActiveContacts() {
    return this.prisma.contact.count({ where: { optedOut: false } });
  }

  countApprovedTemplates() {
    return this.prisma.template.count({ where: { status: 'APPROVED' } });
  }

  /**
   * Delivery rate (0-100, integer) over the last 7 days.
   *
   * Denominator = messages with a terminal outcome (DELIVERED, READ, FAILED).
   * QUEUED and SENT are excluded so a fresh blast of 10k messages doesn't
   * artificially crater the metric while waiting for acks to arrive.
   */
  async deliveryRate7d(): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    // Single round-trip: one groupBy returns per-status counts. The numerator
    // (DELIVERED+READ) and denominator (DELIVERED+READ+FAILED) are derived from
    // the same result set, avoiding the two sequential COUNTs the previous
    // implementation issued.
    const rows = await this.prisma.message.groupBy({
      by: ['status'],
      where: {
        queuedAt: { gte: since },
        status: { in: ['DELIVERED', 'READ', 'FAILED'] },
      },
      _count: { _all: true },
    });

    let delivered = 0;
    let total = 0;
    for (const r of rows) {
      // Defensive: only the three terminal statuses contribute, even if a
      // future caller widens the `where`. QUEUED/SENT never count.
      if (r.status !== 'DELIVERED' && r.status !== 'READ' && r.status !== 'FAILED') {
        continue;
      }
      const count = r._count?._all ?? 0;
      total += count;
      if (r.status === 'DELIVERED' || r.status === 'READ') delivered += count;
    }
    if (total === 0) return 0;
    return Math.round((delivered / total) * 100);
  }

  /** 7-bucket daily count of messages queued in the window. */
  async messageSparkline7d(): Promise<number[]> {
    return this.bucketSparkline7d('Message');
  }

  /** 7-bucket daily count of campaigns created in the window. */
  async campaignSparkline7d(): Promise<number[]> {
    return this.bucketSparkline7d('Campaign');
  }

  /** 7-bucket daily count of contacts created in the window. */
  async contactSparkline7d(): Promise<number[]> {
    return this.bucketSparkline7d('Contact');
  }

  /** 7-bucket daily count of templates created in the window. */
  async templateSparkline7d(): Promise<number[]> {
    return this.bucketSparkline7d('Template');
  }

  /**
   * Count messages currently in each status that were last touched in the
   * last 30 minutes. This drives the Dashboard LiveFlow's stage-ring counters.
   * "Last touched" = max(queuedAt, sentAt, deliveredAt, readAt, failedAt).
   *
   * Uses GREATEST() over the timestamp columns; fall back to queuedAt for
   * QUEUED rows (which have only queuedAt set).
   */
  async liveFlowCounts(): Promise<{
    queued: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
  }> {
    const since = new Date(Date.now() - 30 * 60_000);

    const rows = (await this.prisma.$queryRawUnsafe(
      `
      SELECT status, COUNT(*)::int AS count
      FROM "Message"
      WHERE GREATEST(
        "queuedAt",
        COALESCE("sentAt", "queuedAt"),
        COALESCE("deliveredAt", "queuedAt"),
        COALESCE("readAt", "queuedAt"),
        COALESCE("failedAt", "queuedAt")
      ) >= $1
      GROUP BY status
      `,
      since,
    )) as Array<{ status: string; count: number }>;

    const out = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const r of rows) {
      const k = r.status.toLowerCase() as keyof typeof out;
      if (k in out) out[k] = Number(r.count);
    }
    return out;
  }

  private async bucketSparkline7d(
    target: keyof typeof SPARKLINE_SPECS,
  ): Promise<number[]> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);

    // Identifiers come from a closed allowlist (SPARKLINE_SPECS), wrapped in
    // Prisma.sql so they're never concatenated as raw strings. Adding a new
    // sparkline metric requires editing the spec map — there's no path for
    // user input to influence table/column choice.
    const { table, column } = SPARKLINE_SPECS[target];
    const rows = (await this.prisma.$queryRaw(
      Prisma.sql`
        SELECT
          date_trunc('day', ${column})::date AS day,
          COUNT(*)::int AS count
        FROM ${table}
        WHERE ${column} >= ${since}
        GROUP BY 1
        ORDER BY 1
      `,
    )) as Array<{ day: Date; count: number }>;

    const buckets: number[] = Array(7).fill(0);
    for (const r of rows) {
      // Calendar-day diff is DST-safe; raw ms division was off-by-one on
      // 23h/25h days at the spring-forward / fall-back transitions.
      const idx = differenceInCalendarDays(new Date(r.day), since);
      if (idx >= 0 && idx < 7) buckets[idx] = Number(r.count);
    }
    return buckets;
  }
}
