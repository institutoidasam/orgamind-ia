import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { AuditTrailService } from './audit-trail.service';
import {
  AuditTrailQueryDto,
  PersonHistoryQueryDto,
} from './dto/audit-trail.dto';

type AuthRequest = { user: JwtPayload };

/**
 * Trilha de alterações (C7). A consulta geral é fixa do ADMIN (`@Roles`); o
 * histórico e os vínculos da pessoa exigem `trilha.consultar`
 * (`@RequirePermission`, sem `@Roles`); quem pode qual pessoa é decidido no
 * serviço (`person-actions.policy`).
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
  @RequirePermission('trilha.consultar')
  @ApiOperation({ summary: 'Histórico de uma pessoa, mais recentes primeiro' })
  personHistory(
    @Param('userId') userId: string,
    @Query() query: PersonHistoryQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.trail.personHistory(req.user.sub, userId, query);
  }

  @Get('people/:userId/assignments')
  @RequirePermission('trilha.consultar')
  @ApiOperation({
    summary: 'Vínculos de uma pessoa (setor, turno e nível), atual primeiro',
  })
  personAssignments(@Param('userId') userId: string, @Req() req: AuthRequest) {
    return this.trail.personAssignments(req.user.sub, userId);
  }
}
