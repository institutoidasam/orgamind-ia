import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Sse, type MessageEvent } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { Request } from 'express';
import { ChatService } from './chat.service';
import { ChatEventsService } from './chat-events.service';
import { ListConversationsDto } from './dto/list-conversations.dto';
import { ListMessagesDto } from './dto/list-messages.dto';
import { SendReplyDto } from './dto/send-reply.dto';
import { TypingDto } from './dto/typing.dto';
import { AssignConversationDto } from './dto/assign-conversation.dto';

type AuthedRequest = Request & { user: { sub: string; role: string } };

@Controller('chat')
export class ChatController {
  constructor(
    private readonly svc: ChatService,
    private readonly events: ChatEventsService,
  ) {}

  @Get('conversations')
  list(@Query() query: ListConversationsDto, @Req() req: AuthedRequest) {
    return this.svc.listConversations(query, req.user.sub);
  }

  @Get('conversations/:id')
  get(@Param('id') id: string) {
    return this.svc.getConversation(id);
  }

  @Get('conversations/:id/messages')
  messages(@Param('id') id: string, @Query() query: ListMessagesDto) {
    return this.svc.listMessages(id, query);
  }

  /**
   * Live event stream. Authenticated by the global JwtAuthGuard (the frontend
   * connects with a fetch-based EventSource that sends the Bearer token).
   * Phase 1 broadcasts all events (conversations are org-wide).
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.events.stream$.pipe(map((event) => ({ data: event }) as MessageEvent));
  }

  @Post('conversations/:id/messages')
  sendReply(@Param('id') id: string, @Body() body: SendReplyDto, @Req() req: AuthedRequest) {
    return this.svc.sendReply(id, req.user.sub, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  markRead(@Param('id') id: string) {
    return this.svc.markRead(id);
  }

  @Post('conversations/:id/typing')
  @HttpCode(202)
  typing(@Param('id') id: string, @Body() body: TypingDto) {
    return this.svc.sendTyping(id, body.state);
  }

  @Post('conversations/:id/assign')
  @HttpCode(200)
  assign(@Param('id') id: string, @Body() body: AssignConversationDto, @Req() req: AuthedRequest) {
    return this.svc.assignConversation(id, body.userId, req.user.sub);
  }

  @Post('conversations/:id/bot/pause')
  @HttpCode(200)
  pauseBot(@Param('id') id: string) {
    return this.svc.pauseBot(id);
  }

  @Post('conversations/:id/bot/resume')
  @HttpCode(200)
  resumeBot(@Param('id') id: string) {
    return this.svc.resumeBot(id);
  }
}
