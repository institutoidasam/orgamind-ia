import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { PendencyHandoverDto } from './dto/pendency-handover.dto';
import { PendencyHandoverTargetsQueryDto } from './dto/pendency-handover-targets-query.dto';
import { TeamPendencyHandoverService } from './team-pendency-handover.service';

type AuthRequest = { user: JwtPayload };

/**
 * Passagem de pendências da equipe (Lote K3, DT4): mesmo prefixo do
 * `TeamPendencyController`, que não muda. As rotas só têm
 * `@RequirePermission('equipe.enviar')` (sem `@Roles`); o 403 `forbidden`, o
 * `not_handler` e o alcance de cada pendência ficam no serviço.
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamPendencyHandoverController {
  constructor(private readonly service: TeamPendencyHandoverService) {}

  @Get('pendency-handover/targets')
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Destinos da passagem de pendências: remetentes ativos, com acesso e equipe.enviar, sem quem sai (fromUserId; de outro só ADMIN, senão 403 not_handler), só id e nome (só remetente)',
  })
  targets(
    @Query() query: PendencyHandoverTargetsQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.targets(req.user.sub, query.fromUserId);
  }

  @Post('pendency-handover')
  @HttpCode(200)
  @RequirePermission('equipe.enviar')
  @ApiOperation({
    summary:
      'Passa as pendências assumidas por quem sai (fromUserId; de outro só ADMIN, senão 403 not_handler) a um destino que possa recebê-las (ativo, com acesso e equipe.enviar; senão 404). Por pendência: transferida, ou pulada com o motivo (fora do alcance do destino, já com outro responsável, já ciente, já encerrada, não encontrada). Prazo de 60 min recomeça; a observação vira anotação; nada é enviado',
  })
  handover(@Body() body: PendencyHandoverDto, @Req() req: AuthRequest) {
    return this.service.handover(req.user.sub, body, new Date());
  }
}
