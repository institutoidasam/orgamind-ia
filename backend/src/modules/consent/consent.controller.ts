import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ConsentService } from './consent.service';
import {
  ConsentMetricsService,
  type ConsentOverview,
} from './consent-metrics.service';
import {
  SourceOriginService,
  type ClassifyReport,
} from './source-origin.service';

/**
 * C1b/C5 — a superfície de leitura do consentimento.
 *
 * - `GET /consent/purposes`: o que o wizard de campanha precisa para o operador
 *   DECLARAR a finalidade (sem ela, `Campaign.purposeKey` nasce nulo e o gate —
 *   corretamente — pula 100% dos destinatários).
 * - `GET /consent/overview`: o painel de opt-in (spec §7). A métrica de sucesso
 *   do orgamind deixa de ser "mensagens enviadas" e passa a ser "quantos podem
 *   receber campanha hoje".
 * - `POST /consent/audit/classify`: reexecuta a auditoria das coortes (§6.2).
 *
 * Autenticado pelo JwtAuthGuard global. O overview é aberto a qualquer operador
 * (só agregados — nenhum telefone, nenhuma linha de contato); a reclassificação é
 * ADMIN, porque varre e reescreve a base inteira.
 */
@ApiTags('consent')
@Controller('consent')
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly metrics: ConsentMetricsService,
    private readonly sourceOrigin: SourceOriginService,
  ) {}

  @ApiOperation({
    summary:
      'Lista as finalidades de consentimento ATIVAS (key, label, description, isSensitive)',
  })
  @Get('purposes')
  listPurposes() {
    return this.consent.listPurposes();
  }

  @ApiOperation({
    summary:
      'Painel de opt-in: quem pode receber campanha hoje, consentimentos por finalidade e fonte, funil por token de origem, coortes de procedência e quanto da base é inutilizável',
  })
  @Get('overview')
  overview(): Promise<ConsentOverview> {
    return this.metrics.overview();
  }

  @ApiOperation({
    summary:
      'Reclassifica a base em coortes de procedência (§6.2). NÃO envia mensagem e NÃO grava consentimento — é idempotente e re-executável',
  })
  @Roles('ADMIN')
  @HttpCode(200)
  @Post('audit/classify')
  classify(): Promise<ClassifyReport> {
    return this.sourceOrigin.classifyAll();
  }
}
