import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      include: { sector: true },
    });
  }

  findById(id: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: { sector: true },
    });
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
          sessionVersion: { increment: 1 },
          ...(clearMustChange ? { mustChangePassword: false } : {}),
        },
      })
      .then(() => undefined);
  }
}

export type AuthUser = Prisma.UserGetPayload<{ include: { sector: true } }>;
