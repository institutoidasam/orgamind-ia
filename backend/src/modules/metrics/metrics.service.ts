import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { MetricsRepository } from './metrics.repository';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import type { DashboardMetrics } from '../../schemas/contracts/metrics.schema';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private static readonly CACHE_KEY = 'metrics:dashboard';
  private static readonly TTL_S = 30;

  constructor(
    private readonly repo: MetricsRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getDashboard(): Promise<DashboardMetrics> {
    try {
      const cached = await this.redis.get(MetricsService.CACHE_KEY);
      if (cached) return JSON.parse(cached) as DashboardMetrics;
    } catch (err) {
      this.logger.warn({ err }, 'metrics cache read failed; computing fresh');
    }

    const value = await this.computeDashboard();

    try {
      await this.redis.set(
        MetricsService.CACHE_KEY,
        JSON.stringify(value),
        'EX',
        MetricsService.TTL_S,
      );
    } catch (err) {
      this.logger.warn({ err }, 'metrics cache write failed; serving fresh');
    }
    return value;
  }

  private async computeDashboard(): Promise<DashboardMetrics> {
    const [
      running,
      contacts,
      templates,
      rate,
      campaignSpark,
      contactSpark,
      templateSpark,
      messageSpark,
      liveFlow,
    ] = await Promise.all([
      this.repo.countRunningCampaigns(),
      this.repo.countActiveContacts(),
      this.repo.countApprovedTemplates(),
      this.repo.deliveryRate7d(),
      this.repo.campaignSparkline7d(),
      this.repo.contactSparkline7d(),
      this.repo.templateSparkline7d(),
      this.repo.messageSparkline7d(),
      this.repo.liveFlowCounts(),
    ]);

    return {
      activeCampaigns: { count: running, meta: 'em curso agora', sparkline: campaignSpark },
      activeContacts: { count: contacts, meta: 'sem opt-out', sparkline: contactSpark },
      approvedTemplates: { count: templates, meta: 'prontos para uso', sparkline: templateSpark },
      deliveryRate7d: { count: rate, meta: 'últimos 7 dias', sparkline: messageSpark },
      liveFlow,
    };
  }
}
