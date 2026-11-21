import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AssignConversationDto } from './dto/assign-conversation.dto';
import { ReopenConversationDto } from './dto/reopen-conversation.dto';
import { ResolveConversationDto } from './dto/resolve-conversation.dto';
import type { ChatActor } from './conversation-ownership.repository';
import { ConversationOwnershipService } from './conversation-ownership.service';

type AuthedRequest = Request & { user: { sub: string; role: string } };

/** DK12: o ator é o `req.user` (papel relido do banco a cada request pela `jwt.strategy`). */
const actorOf = (req: AuthedRequest): ChatActor => ({
  id: req.user.sub,
  role: req.user.role,
});

/**
 * Sem `@Roles` nem `@RequirePermission` (DK12): o `RolesGuard` cai no legado
 * ADMIN/OPERATOR, como o resto do chat.
 */
@Controller('chat')
export class ConversationOwnershipController {
  constructor(private readonly svc: ConversationOwnershipService) {}

  @Get('conversations/:id/history')
  history(@Param('id') id: string) {
    return this.svc.history(id);
  }

  @Get('assignees')
  assignees() {
    return this.svc.assignees();
  }

  @Post('conversations/:id/resolve')
  @HttpCode(200)
  resolve(
    @Param('id') id: string,
    @Body() body: ResolveConversationDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.resolve(id, actorOf(req), body);
  }

  @Post('conversations/:id/reopen')
  @HttpCode(200)
  reopen(
    @Param('id') id: string,
    @Body() body: ReopenConversationDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.reopen(id, actorOf(req), body);
  }

  @Post('conversations/:id/assign')
  @HttpCode(200)
  assign(
    @Param('id') id: string,
    @Body() body: AssignConversationDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.assign(id, actorOf(req), body);
  }
}
