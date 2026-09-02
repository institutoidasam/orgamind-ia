import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsRepository } from './metrics.repository';
import { ZernioMetricsService } from './zernio-metrics.service';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsRepository, ZernioMetricsService],
})
export class MetricsModule {}
