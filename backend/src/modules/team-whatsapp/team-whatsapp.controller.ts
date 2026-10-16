import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { CreateTeamDispatchDto } from './dto/create-team-dispatch.dto';
import { TeamWhatsappService } from './team-whatsapp.service';

type AuthRequest = { user: JwtPayload };

/**
 * WhatsApp da equipe. VIEWER é barrado pelo RolesGuard; entre os demais papéis,
 * quem decide é a política do serviço (ADMIN ou gestor de setor, senão 403).
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamWhatsappController {
  constructor(private readonly team: TeamWhatsappService) {}

  @Get('targets')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary: 'Canais e setores para os quais o remetente pode enviar',
  })
  targets(@Req() req: AuthRequest) {
    return this.team.targets(req.user.sub);
  }

  @Post('dispatches')
  @HttpCode(202)
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary: 'Enfileira um recado de WhatsApp para um usuário ou setor',
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
}
