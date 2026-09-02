import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { UsersRepository } from './users.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { RefreshService } from '../auth/refresh.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/domain.error';
import type { UserListResult, UserSummary } from './users.repository';

export type UserListResponse = UserListResult & { page: number; pageSize: number };

// Defense-in-depth: strip any unexpected fields that the repo might leak (e.g.
// if a future change accidentally swaps the allowlisted select back to a full
// include). The repo already returns UserSummary; this enforces the contract.
function toUserSummary(u: UserSummary): UserSummary {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    createdById: u.createdById,
    createdBy: u.createdBy,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly audit: AuditService,
    private readonly refresh: RefreshService,
  ) {}

  async listUsers(page: number, pageSize: number): Promise<UserListResponse> {
    const { data, total } = await this.repo.findMany(page, pageSize);
    return { data: data.map(toUserSummary), total, page, pageSize };
  }

  async createUser(
    input: { email: string; name?: string; role: 'ADMIN' | 'OPERATOR' },
    createdById: string,
  ): Promise<{ user: UserSummary | null; temporaryPassword: string }> {
    const existing = await this.repo.findByEmail(input.email);
    if (existing) {
      throw new ConflictError('Email already taken', 'user.email_taken');
    }

    const temporaryPassword = UsersRepository.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });

    const created = await this.repo.create({
      email: input.email,
      name: input.name ?? null,
      role: input.role,
      password: passwordHash,
      mustChangePassword: true,
      createdBy: { connect: { id: createdById } },
    });

    await this.audit.log('user.invited', 'User', created.id, {
      email: created.email,
      role: created.role,
      invitedBy: createdById,
    });

    // Re-read via findById to get the password-free UserSummary shape.
    const user = await this.repo.findById(created.id);
    return { user: user ? toUserSummary(user) : null, temporaryPassword };
  }

  async updateUser(
    id: string,
    input: { name?: string; role?: 'ADMIN' | 'OPERATOR' },
    actorId: string,
  ): Promise<void> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);

    if (input.role !== undefined && id === actorId) {
      throw new ForbiddenError('Cannot edit your own role', 'user.cannot_self_edit_role');
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.role !== undefined) data['role'] = input.role;

    // Transactional update with last-admin guard. Two concurrent demotions of
    // the only two admins would otherwise both pass a separate countAdmins
    // check; the serializable transaction prevents that race.
    const result = await this.repo.updateWithLastAdminGuard(id, data);
    if ('lastAdmin' in result) {
      throw new ForbiddenError('Cannot demote the last admin', 'user.last_admin');
    }

    if (input.role !== undefined) {
      // A privilege change must not leave the old role cached in a live access
      // token (valid up to 15min): force re-login so the new role takes effect.
      await this.refresh.revokeAllForUser(id);
      await this.audit.log('user.role_changed', 'User', id, {
        newRole: input.role,
        changedBy: actorId,
      });
    } else {
      await this.audit.log('user.profile_updated', 'User', id, { changedBy: actorId });
    }
  }

  async deleteUser(id: string, actorId: string): Promise<void> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);

    if (id === actorId) {
      throw new ForbiddenError('Cannot delete yourself', 'user.cannot_delete_self');
    }

    // Transactional delete with last-admin guard against concurrent races.
    const result = await this.repo.deleteWithLastAdminGuard(id);
    if ('lastAdmin' in result) {
      throw new ForbiddenError('Cannot delete the last admin', 'user.last_admin');
    }

    // Burn any lingering refresh families so a deleted user's token can't keep
    // rotating until the 7-day family TTL lapses.
    await this.refresh.revokeAllForUser(id);

    await this.audit.log('user.deleted', 'User', id, {
      email: user.email,
      deletedBy: actorId,
    });
  }

  async resetPassword(
    id: string,
    actorId: string,
  ): Promise<{ temporaryPassword: string }> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundError('User', id);

    const temporaryPassword = UsersRepository.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });
    await this.repo.resetPassword(id, passwordHash);
    // Same reasoning as self-service change: invalidate every existing session
    // so the old credential's refresh tokens stop rotating.
    await this.refresh.revokeAllForUser(id);
    await this.audit.log('user.password_reset', 'User', id, { resetBy: actorId });

    return { temporaryPassword };
  }
}
