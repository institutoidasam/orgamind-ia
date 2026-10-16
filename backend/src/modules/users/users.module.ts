import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { UserPhoneService } from './user-phone.service';
import { AuthModule } from '../auth/auth.module';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  // AuthModule exports RefreshService, which UsersService uses to revoke
  // sessions on reset/role-change/delete. The dependency is one-way
  // (AuthModule does not import UsersModule), so there is no cycle.
  // ContactsModule exports ContactsService/ContactsRepository for the user's
  // WhatsApp contact link; it does not import UsersModule either.
  imports: [AuthModule, ContactsModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository, UserPhoneService],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
