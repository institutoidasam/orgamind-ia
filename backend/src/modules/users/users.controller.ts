import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { UsersService } from './users.service';
import { ListUsersDto } from './dto/list-users.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user: JwtPayload };

@ApiTags('users')
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({ summary: 'List users (paginated)' })
  @Get()
  listUsers(@Query() query: ListUsersDto, @Req() _req: AuthRequest) {
    return this.users.listUsers(query.page, query.pageSize);
  }

  @ApiOperation({ summary: 'Invite a new user (generates temp password)' })
  @Post()
  createUser(@Body() dto: CreateUserDto, @Req() req: AuthRequest) {
    return this.users.createUser(dto, req.user.sub);
  }

  @ApiOperation({ summary: 'Update user name or role' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Patch(':id')
  updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: AuthRequest,
  ) {
    return this.users.updateUser(id, dto, req.user.sub);
  }

  @ApiOperation({ summary: 'Reset user password (generates new temp password)' })
  @HttpCode(HttpStatus.OK)
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.users.resetPassword(id, req.user.sub);
  }

  @ApiOperation({ summary: 'Delete a user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  deleteUser(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.users.deleteUser(id, req.user.sub);
  }
}
