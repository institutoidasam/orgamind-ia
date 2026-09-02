import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  updateLastLoginAt(id: string): Promise<void> {
    return this.prisma.user
      .update({ where: { id }, data: { lastLoginAt: new Date() } })
      .then(() => undefined);
  }

  updatePassword(
    id: string,
    passwordHash: string,
    clearMustChange: boolean,
  ): Promise<void> {
    return this.prisma.user
      .update({
        where: { id },
        data: {
          password: passwordHash,
          ...(clearMustChange ? { mustChangePassword: false } : {}),
        },
      })
      .then(() => undefined);
  }
}
