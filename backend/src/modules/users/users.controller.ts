import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { Roles } from '../auth/decorators/roles.decorator';
import { UsersService } from './users.service';
import { requireReason } from './change-reason';
import { ListUsersDto } from './dto/list-users.dto';
import { createUserSchema, type CreateUserBody } from './dto/create-user.dto';
import { GrantAccessDto } from './dto/grant-access.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user: JwtPayload };

@ApiTags('users')
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({
    summary:
      'List users (paginated; hasAccess, q, status and authorization filters; authorization counters)',
  })
  @Get()
  listUsers(@Query() query: ListUsersDto) {
    return this.users.listUsers(query.page, query.pageSize, {
      hasAccess: query.hasAccess,
      q: query.q,
      status: query.status,
      authorization: query.authorization,
    });
  }

  @ApiOperation({
    summary:
      'Invite a new user (generates temp password) or, with hasAccess false, add a person without access',
  })
  @Post()
  async createUser(
    @Body(new ZodValidationPipe(createUserSchema)) dto: CreateUserBody,
    @Req() req: AuthRequest,
  ) {
    if (dto.hasAccess !== false)
      return this.users.createUser(dto, req.user.sub);
    const user = await this.users.createPersonWithoutAccess(req.user.sub, dto);
    return { user, temporaryPassword: null };
  }

  @ApiOperation({
    summary: 'Grant system access to a person without access (temp password)',
  })
  @HttpCode(HttpStatus.OK)
  @Post(':id/access')
  grantAccess(
    @Param('id') id: string,
    @Body() dto: GrantAccessDto,
    @Req() req: AuthRequest,
  ) {
    return this.users.grantAccess(req.user.sub, id, dto);
  }

  @ApiOperation({
    summary:
      'Update a person (also deactivate or reactivate with isActive); reason is required',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Patch(':id')
  async updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: AuthRequest,
  ) {
    const { reason, ...patch } = dto;
    return this.users.updateUser(id, patch, req.user.sub, {
      reason: requireReason(reason),
    });
  }

  @ApiOperation({
    summary: 'Reset user password (generates new temp password)',
  })
  @HttpCode(HttpStatus.OK)
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.users.resetPassword(id, req.user.sub);
  }

  @ApiOperation({ summary: 'Delete a user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  deleteUser(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.users.deleteUser(id, req.user.sub, req.user.role);
  }
}
