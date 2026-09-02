import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { RefreshService } from '../auth/refresh.service';
import argon2 from 'argon2';

vi.mock('argon2');

const adminUser = {
  id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'ADMIN' as const,
  password: 'hash', mustChangePassword: false, lastLoginAt: null,
  createdAt: new Date(), updatedAt: new Date(), createdById: null, createdBy: null,
  invitedUsers: [],
};

const operatorUser = {
  ...adminUser,
  id: 'u2', email: 'op@test.com', name: 'Operator', role: 'OPERATOR' as const,
};

const makeRepo = (overrides: Partial<InstanceType<typeof UsersRepository>> = {}) =>
  ({
    findMany: vi.fn().mockResolvedValue({ data: [adminUser], total: 1 }),
    findById: vi.fn().mockResolvedValue(adminUser),
    findByEmail: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(adminUser),
    deleteWithLastAdminGuard: vi.fn().mockResolvedValue({ deleted: adminUser }),
    updateWithLastAdminGuard: vi.fn().mockResolvedValue({ updated: adminUser }),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as UsersRepository;

const makeAudit = () =>
  ({ log: vi.fn().mockResolvedValue(undefined) }) as unknown as AuditService;

const makeRefresh = () =>
  ({
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
  }) as unknown as RefreshService;

describe('UsersService.listUsers', () => {
  it('strips `password` from every row in the response', async () => {
    const repo = makeRepo();
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    const result = await svc.listUsers(1, 20);
    for (const u of result.data) {
      expect(u).not.toHaveProperty('password');
    }
  });

  it('echoes page and pageSize in the response for frontend pagination', async () => {
    const repo = makeRepo();
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    const result = await svc.listUsers(3, 25);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(25);
    expect(result.total).toBe(1);
  });
});

describe('UsersService.createUser', () => {
  it('throws ConflictError when email already exists', async () => {
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(adminUser) });
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    await expect(
      svc.createUser({ email: 'admin@test.com', role: 'OPERATOR' }, 'creator1'),
    ).rejects.toMatchObject({ code: 'user.email_taken' });
  });

  it('returns user and temporaryPassword on success', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('hashed' as never);
    const repo = makeRepo();
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    const result = await svc.createUser({ email: 'new@test.com', role: 'OPERATOR' }, 'c1');
    expect(result.temporaryPassword).toHaveLength(12);
    expect(result.user!.email).toBe(adminUser.email);
  });

  it('does NOT include `password` in the returned user', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('hashed' as never);
    const repo = makeRepo();
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    const result = await svc.createUser({ email: 'new@test.com', role: 'OPERATOR' }, 'c1');
    expect(result.user).not.toHaveProperty('password');
  });
});

describe('UsersService.updateUser', () => {
  it('throws ForbiddenError when admin tries to edit own role', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    await expect(
      svc.updateUser('u1', { role: 'OPERATOR' }, 'u1'),
    ).rejects.toMatchObject({ code: 'user.cannot_self_edit_role' });
  });

  it('throws ForbiddenError when demoting the last admin (transactional guard)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      updateWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    await expect(
      svc.updateUser('u1', { role: 'OPERATOR' }, 'other'),
    ).rejects.toMatchObject({ code: 'user.last_admin' });
  });

  it('updates name via the transactional guard (which is a no-op when role unchanged)', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    await svc.updateUser('u1', { name: 'New Name' }, 'other');
    expect(repo.updateWithLastAdminGuard).toHaveBeenCalledWith('u1', { name: 'New Name' });
  });

  it('revokes the target user\'s sessions when their role changes', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const refresh = makeRefresh();
    const svc = new UsersService(repo, makeAudit(), refresh);
    await svc.updateUser('u1', { role: 'OPERATOR' }, 'other');
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('does NOT revoke sessions for a name-only update (role unchanged)', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const refresh = makeRefresh();
    const svc = new UsersService(repo, makeAudit(), refresh);
    await svc.updateUser('u1', { name: 'New Name' }, 'other');
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('does NOT revoke sessions when a demotion is rejected (last admin)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      updateWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const refresh = makeRefresh();
    const svc = new UsersService(repo, makeAudit(), refresh);
    await expect(
      svc.updateUser('u1', { role: 'OPERATOR' }, 'other'),
    ).rejects.toMatchObject({ code: 'user.last_admin' });
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe('UsersService.deleteUser', () => {
  it('throws ForbiddenError when deleting self', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    await expect(svc.deleteUser('u1', 'u1')).rejects.toMatchObject({
      code: 'user.cannot_delete_self',
    });
  });

  it('throws ForbiddenError when deleting the last admin (transactional guard)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      deleteWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const svc = new UsersService(repo, makeAudit(), makeRefresh());
    await expect(svc.deleteUser('u1', 'other')).rejects.toMatchObject({
      code: 'user.last_admin',
    });
  });

  it('deletes and logs audit event', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operatorUser) });
    const svc = new UsersService(repo, audit, makeRefresh());
    await svc.deleteUser('u2', 'u1');
    expect(repo.deleteWithLastAdminGuard).toHaveBeenCalledWith('u2');
    expect(audit.log).toHaveBeenCalledWith('user.deleted', 'User', 'u2', expect.any(Object));
  });

  it('revokes the deleted user\'s refresh families', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operatorUser) });
    const refresh = makeRefresh();
    const svc = new UsersService(repo, makeAudit(), refresh);
    await svc.deleteUser('u2', 'u1');
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u2');
  });

  it('does NOT revoke sessions when the delete is rejected (last admin)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      deleteWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const refresh = makeRefresh();
    const svc = new UsersService(repo, makeAudit(), refresh);
    await expect(svc.deleteUser('u1', 'other')).rejects.toMatchObject({
      code: 'user.last_admin',
    });
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe('UsersService.resetPassword', () => {
  it('generates a new temp password and sets mustChangePassword=true', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operatorUser) });
    const audit = makeAudit();
    const svc = new UsersService(repo, audit, makeRefresh());
    const result = await svc.resetPassword('u2', 'u1');
    expect(result.temporaryPassword).toHaveLength(12);
    expect(repo.resetPassword).toHaveBeenCalledWith('u2', 'newhash');
    expect(audit.log).toHaveBeenCalledWith('user.password_reset', 'User', 'u2', expect.any(Object));
  });

  it('revokes the target user\'s refresh families after an admin reset', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operatorUser) });
    const refresh = makeRefresh();
    const svc = new UsersService(repo, makeAudit(), refresh);
    await svc.resetPassword('u2', 'u1');
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u2');
  });
});
