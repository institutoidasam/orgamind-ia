import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule exports RefreshService, which UsersService uses to revoke
  // sessions on reset/role-change/delete. The dependency is one-way
  // (AuthModule does not import UsersModule), so there is no cycle.
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
