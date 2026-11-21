import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ShiftHandoverResult } from '../../schemas/contracts/chat.schema';
import { ConversationHandoverService } from './conversation-handover.service';
import type { ChatActor } from './conversation-ownership.repository';
import { ShiftHandoverDto } from './dto/shift-handover.dto';

type AuthedRequest = Request & { user: { sub: string; role: string } };

/**
 * K3-1/DT1: sem `@Roles` nem `@RequirePermission`, como as rotas do K1: o
 * `RolesGuard` cai no legado ADMIN/OPERATOR. Passar as de outro é regra do
 * serviço (só o ADMIN, 403 `chat.not_assignee`).
 */
@Controller('chat')
export class ConversationHandoverController {
  constructor(private readonly svc: ConversationHandoverService) {}

  @Post('handover')
  @HttpCode(200)
  handover(
    @Body() body: ShiftHandoverDto,
    @Req() req: AuthedRequest,
  ): Promise<ShiftHandoverResult> {
    const actor: ChatActor = { id: req.user.sub, role: req.user.role };
    return this.svc.handover(actor, body, new Date());
  }
}
