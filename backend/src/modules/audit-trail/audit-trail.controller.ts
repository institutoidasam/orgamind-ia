import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { AuditTrailService } from './audit-trail.service';
import {
  AuditTrailQueryDto,
  PersonHistoryQueryDto,
} from './dto/audit-trail.dto';

type AuthRequest = { user: JwtPayload };

/**
 * Trilha de alterações (C7). O `@Roles` de cada rota espelha a matriz de
 * `person-actions.policy` (sem ele a rota abriria a ADMIN e OPERATOR); quem
 * pode qual pessoa é decidido no serviço.
 */
@ApiTags('audit-trail')
@Controller('audit-trail')
export class AuditTrailController {
  constructor(private readonly trail: AuditTrailService) {}

  @Get()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Consulta geral da trilha, mais recentes primeiro' })
  list(@Query() query: AuditTrailQueryDto, @Req() req: AuthRequest) {
    return this.trail.list(req.user.sub, query);
  }

  @Get('people/:userId')
  @Roles('ADMIN', 'SUPERVISOR')
  @ApiOperation({ summary: 'Histórico de uma pessoa, mais recentes primeiro' })
  personHistory(
    @Param('userId') userId: string,
    @Query() query: PersonHistoryQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.trail.personHistory(req.user.sub, userId, query);
  }
}
