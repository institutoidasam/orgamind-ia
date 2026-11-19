import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { PeopleExportQueryDto } from './dto/people-export-query.dto';
import { ScheduleExportQueryDto } from './dto/schedule-export-query.dto';
import { PeopleExportService } from './people-export.service';
import { ScheduleExportService } from './schedule-export.service';

type AuthRequest = { user: JwtPayload };

/**
 * Download de pessoas e da escala (Lote D). A chave `pessoas.exportar` fica só
 * na classe e nenhum handler declara `@Roles`: o `RolesGuard` não confere papel
 * e quem decide é a matriz (ADMIN sempre; VIEWER nunca). Um handler novo sem a
 * chave, ou com `@Roles`, cairia na regra antiga de papéis; o
 * `route-parity.spec.ts` falha nesse caso.
 *
 * Limite próprio de 20 downloads por minuto por usuário (o contador é por rota;
 * o `UserThrottlerGuard` global chaveia pelo usuário autenticado); a 21ª
 * requisição responde 429. O teto global é de 100 por minuto.
 *
 * `@Res()` sem `passthrough`: o serviço escreve o arquivo direto na resposta.
 * Erro lançado antes dos headers rejeita o handler e o Nest o entrega ao
 * filtro global (`application/problem+json`).
 */
@ApiTags('people-export')
@RequirePermission('pessoas.exportar')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
@Controller('internal/people-export')
export class PeopleExportController {
  constructor(
    private readonly people: PeopleExportService,
    private readonly schedule: ScheduleExportService,
  ) {}

  @Get('people')
  @ApiOperation({ summary: 'Baixa as pessoas (CSV ou XLSX) com filtros' })
  async exportPeople(
    @Query() query: PeopleExportQueryDto,
    @Req() req: AuthRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.people.exportPeople(req.user.sub, query, res);
  }

  @Get('schedule')
  @ApiOperation({ summary: 'Baixa a escala de um setor no período' })
  async exportSchedule(
    @Query() query: ScheduleExportQueryDto,
    @Req() req: AuthRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.schedule.exportSchedule(req.user.sub, query, res);
  }
}
