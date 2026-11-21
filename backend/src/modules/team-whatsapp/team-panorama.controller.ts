import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { PanoramaQueryDto } from './dto/panorama-query.dto';
import { TeamPanoramaService } from './team-panorama.service';

type AuthRequest = { user: JwtPayload };

/**
 * Panorama da fábrica (Lote J, DJ1): mesmo prefixo e mesmos guards globais do
 * `TeamWhatsappController`, que não muda. Leitura só com `@Roles(...)` (VIEWER
 * barrado pelo RolesGuard); o alcance e o 403 de quem não é remetente ficam no
 * serviço. A leitura não grava trilha.
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamPanoramaController {
  constructor(private readonly panoramaService: TeamPanoramaService) {}

  @Get('panorama')
  @Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')
  @ApiOperation({
    summary:
      'Contagens da escala do dia por setor do alcance: em serviço por turno, folga, férias, sem escala e lacunas de contato (só remetente; sem nome nem telefone)',
  })
  panorama(@Query() query: PanoramaQueryDto, @Req() req: AuthRequest) {
    return this.panoramaService.panorama(req.user.sub, query, new Date());
  }
}
