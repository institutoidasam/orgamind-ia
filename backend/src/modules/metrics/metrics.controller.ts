import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  // GET /metrics/zernio saiu do ar (R5). O ZernioMetricsService segue como
  // provider em metrics.module.ts (GC5), só não é mais injetado aqui.
  constructor(private readonly metrics: MetricsService) {}

  // INTENTIONALLY NOT @Roles('ADMIN'): the dashboard is the operator landing
  // page. It returns only aggregate, non-sensitive figures — campaign/contact/
  // template counts, a 7-day delivery rate, sparklines and live-flow stage
  // counts. No PII, no credentials, no per-contact data. Operators are meant to
  // see it, so it stays readable by any authenticated user (still behind the
  // global JwtAuthGuard). Revisit if this endpoint ever exposes record-level data.
  @ApiOperation({ summary: 'Aggregate dashboard metrics (KPIs + sparklines)' })
  @Get('dashboard')
  dashboard() {
    return this.metrics.getDashboard();
  }
}
