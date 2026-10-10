import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '../auth/jwt.strategy';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateInternalCommentDto } from './dto/create-internal-comment.dto';
import { CreateInternalCommunicationDto } from './dto/create-internal-communication.dto';
import { ListInternalCommunicationsDto } from './dto/list-internal-communications.dto';
import { UpdateDemandDto } from './dto/update-demand.dto';
import { InternalCommunicationsService } from './internal-communications.service';

type AuthRequest = { user: JwtPayload };

@ApiTags('internal-communications')
@Controller('internal')
export class InternalCommunicationsController {
  constructor(private readonly communications: InternalCommunicationsService) {}

  @Get('communications')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  list(@Req() req: AuthRequest, @Query() query: ListInternalCommunicationsDto) {
    return this.communications.list(req.user.sub, query);
  }

  @Post('communications')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR')
  create(@Req() req: AuthRequest, @Body() dto: CreateInternalCommunicationDto) {
    return this.communications.create(req.user.sub, dto);
  }

  @Get('communications/:id')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  detail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.communications.detail(req.user.sub, id);
  }

  @Post('communications/:id/comments')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR')
  comment(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: CreateInternalCommentDto,
  ) {
    return this.communications.comment(req.user.sub, id, dto.message);
  }

  @Patch('communications/:id/demand')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR')
  updateDemand(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDemandDto,
  ) {
    return this.communications.updateDemand(req.user.sub, id, dto);
  }

  @Post('communications/:id/read')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  read(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.communications.markRead(req.user.sub, id);
  }

  @Get('inbox')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  inbox(
    @Req() req: AuthRequest,
    @Query() query: ListInternalCommunicationsDto,
  ) {
    return this.communications.inbox(req.user.sub, query);
  }

  @Get('unread-count')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  unreadCount(@Req() req: AuthRequest) {
    return this.communications.unreadCount(req.user.sub);
  }

  @Get('dashboard')
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  dashboard(@Req() req: AuthRequest) {
    return this.communications.dashboard(req.user.sub);
  }
}
