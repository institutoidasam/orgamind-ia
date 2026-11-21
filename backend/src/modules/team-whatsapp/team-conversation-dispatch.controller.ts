import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { TeamConversationDispatchService } from './team-conversation-dispatch.service';

type AuthRequest = { user: JwtPayload };

/**
 * "Último envio à equipe nesta conversa" (Lote K3, DT7): mesmo prefixo do
 * `TeamWhatsappController`, que não muda. Só com `@Roles('ADMIN', 'OPERATOR')`
 * (quem tem a caixa; SUPERVISOR e VIEWER barrados pelo RolesGuard); o alcance da
 * situação e o link do resultado (`canViewDispatch`) ficam no serviço.
 */
@ApiTags('team-whatsapp')
@Controller('internal/team-whatsapp')
export class TeamConversationDispatchController {
  constructor(private readonly service: TeamConversationDispatchService) {}

  @Get('conversations/:conversationId/last-dispatch')
  @Roles('ADMIN', 'OPERATOR')
  @ApiOperation({
    summary:
      'Último envio à equipe nesta conversa: finalidade e data; dispatchId só para quem vê o envio (ADMIN ou autor); situação da pendência só no alcance de quem olha. Conversa inexistente: 404',
  })
  lastDispatch(
    @Param('conversationId') conversationId: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.lastDispatch(req.user.sub, conversationId, new Date());
  }
}
