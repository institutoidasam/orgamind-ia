import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import crypto from 'crypto';

// Allowlist of fields safe to expose via the API. Crucially does NOT include
// `password` — the argon2 hash must never leave the backend, even logged.
const USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  sectorId: true,
  sector: { select: { id: true, name: true, code: true, isActive: true } },
  isActive: true,
  sessionVersion: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  createdBy: { select: { email: true } },
} satisfies Prisma.UserSelect;

export type UserSummary = Prisma.UserGetPayload<{
  select: typeof USER_SUMMARY_SELECT;
}>;

export type UserListResult = {
  data: UserSummary[];
  total: number;
};

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Generate a 12-char URL-safe temp password via crypto.randomBytes. */
  static generateTempPassword(): string {
    return crypto.randomBytes(9).toString('base64url').slice(0, 12);
  }

  findMany(page: number, pageSize: number): Promise<UserListResult> {
    const skip = (page - 1) * pageSize;
    return Promise.all([
      this.prisma.user.findMany({
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: USER_SUMMARY_SELECT,
      }),
      this.prisma.user.count(),
    ]).then(([data, total]) => ({ data, total }));
  }

  findById(id: string): Promise<UserSummary | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: USER_SUMMARY_SELECT,
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  /**
   * Delete a user, rejecting the operation if removing them would leave zero
   * admins. The count + delete run inside a Serializable transaction so two
   * concurrent requests against two distinct admins both see the same admin
   * pool and only one of them succeeds (the other retries / fails).
   *
   * Returns the deleted user on success, or null when the last-admin rule
   * fired (caller turns this into ForbiddenError). Throws when the user does
   * not exist (caller handles NotFoundError separately via findById).
   */
  deleteWithLastAdminGuard(
    id: string,
  ): Promise<{ deleted: User } | { lastAdmin: true }> {
    return this.runSerializable(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) {
        // Surface as a NotFoundError caller-side. We propagate via a thrown
        // marker — Prisma's findUnique returning null is the only way we'd
        // reach here.
        throw new Error('USER_NOT_FOUND');
      }
      if (user.role === 'ADMIN' && user.isActive) {
        const adminCount = await tx.user.count({
          where: { role: 'ADMIN', isActive: true },
        });
        if (adminCount <= 1) return { lastAdmin: true as const };
      }
      const deleted = await tx.user.delete({ where: { id } });
      return { deleted };
    });
  }

  /**
   * Update a user with the same last-admin guard semantics as
   * deleteWithLastAdminGuard: if `data.role` would demote the last admin, the
   * transaction rejects. Other field-only updates skip the count check.
   */
  updateWithLastAdminGuard(
    id: string,
    data: Prisma.UserUpdateInput,
  ): Promise<{ updated: User } | { lastAdmin: true }> {
    return this.runSerializable(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new Error('USER_NOT_FOUND');
      const nextRole = typeof data.role === 'string' ? data.role : user.role;
      const nextActive =
        typeof data.isActive === 'boolean' ? data.isActive : user.isActive;
      if (
        user.role === 'ADMIN' &&
        user.isActive &&
        (nextRole !== 'ADMIN' || !nextActive)
      ) {
        const adminCount = await tx.user.count({
          where: { role: 'ADMIN', isActive: true },
        });
        if (adminCount <= 1) return { lastAdmin: true as const };
      }
      const updated = await tx.user.update({ where: { id }, data });
      return { updated };
    });
  }

  resetPassword(id: string, passwordHash: string): Promise<void> {
    return this.prisma.user
      .update({
        where: { id },
        data: {
          password: passwordHash,
          mustChangePassword: true,
          sessionVersion: { increment: 1 },
        },
      })
      .then(() => undefined);
  }

  findActiveSector(id: string) {
    return this.prisma.sector.findFirst({ where: { id, isActive: true } });
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!this.isSerializationFailure(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private isSerializationFailure(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }
}
