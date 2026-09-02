import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { ZernioMetricsService } from './zernio-metrics.service';
import type { ZernioMetrics } from '../../schemas/contracts/zernio-metrics.schema';

/** Teto da janela: 366 dias é o limite do próprio `/analytics` do Zernio. */
const MAX_PERIOD_DAYS = 366;

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly zernio: ZernioMetricsService,
  ) {}

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

  // MESMA política do /dashboard e pela mesma razão: são números AGREGADOS de
  // disparo (quantos saíram, quantos chegaram, quantos leram) + o nome do
  // disparo. Sem PII, sem dado por contato, sem credencial. O operador precisa
  // ver — é a tela que responde "o que foi disparado, inclusive fora do orgamind".
  @ApiOperation({
    summary:
      'Métricas dos disparos do Zernio (inclusive os feitos pelo painel do Zernio)',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Janela em dias (padrão 30)',
  })
  @Get('zernio')
  zernioMetrics(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ): Promise<ZernioMetrics> {
    // Clamp: `days=0` faria a janela sumir e `days=99999` varreria a tabela
    // inteira num endpoint que qualquer operador pode chamar em loop.
    const period = Math.min(Math.max(days, 1), MAX_PERIOD_DAYS);
    return this.zernio.getMetrics(period);
  }
}
