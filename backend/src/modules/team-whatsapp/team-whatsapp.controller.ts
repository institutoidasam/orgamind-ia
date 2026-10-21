import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { CreateTeamDispatchDto } from './dto/create-team-dispatch.dto';
import { RosterQueryDto } from './dto/roster-query.dto';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappService } from './team-whatsapp.service';

type AuthRequest = { user: JwtPayload };

/**
 * WhatsApp da equipe. VIEWER é barrado pelo RolesGuard; entre os demais papéis,
 * quem decide é a política do serviço (ADMIN ou gestor de setor, senão 403).
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamWhatsappController {
  constructor(
    private readonly team: TeamWhatsappService,
    private readonly schedule: TeamWhatsappScheduleService,
  ) {}

  @Get('targets')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary: 'Canais e setores para os quais o remetente pode enviar',
  })
  targets(@Req() req: AuthRequest) {
    return this.team.targets(req.user.sub);
  }

  @Get('roster')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Escala do setor na data: quem está escalado, de folga ou sem escala',
  })
  roster(@Query() query: RosterQueryDto, @Req() req: AuthRequest) {
    return this.team.roster(req.user.sub, query);
  }

  @Post('dispatches')
  @HttpCode(202)
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Enfileira um recado de WhatsApp para um usuário ou setor, ou agenda para o início do turno',
  })
  createDispatch(@Body() dto: CreateTeamDispatchDto, @Req() req: AuthRequest) {
    return this.team.dispatch(req.user.sub, dto);
  }

  @Get('dispatches')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary: 'Envios recentes (ADMIN vê todos; gestor, os próprios)',
  })
  listDispatches(@Req() req: AuthRequest) {
    return this.team.listDispatches(req.user.sub);
  }

  @Get('scheduled')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Envios agendados ainda não disparados (ADMIN vê todos; gestor, os dos seus setores)',
  })
  listScheduled(@Req() req: AuthRequest) {
    return this.schedule.listScheduled(req.user.sub);
  }

  @Post('dispatches/:id/cancel')
  @HttpCode(200)
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({ summary: 'Cancela um envio agendado antes do disparo' })
  cancel(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.schedule.cancel(req.user.sub, id);
  }
}
