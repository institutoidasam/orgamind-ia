import { describe, it, expect, vi } from 'vitest';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { RefreshService } from '../auth/refresh.service';
import { UserPhoneService } from './user-phone.service';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { NO_PERSON_RECORD } from './users.test-fixtures';

vi.mock('argon2');

const PHONE = '92991234567';

const adminUser = {
  id: 'u1',
  email: 'admin@test.com',
  hasAccess: true,
  name: 'Admin',
  role: 'ADMIN' as const,
  password: 'hash',
  mustChangePassword: false,
  lastLoginAt: null,
  sectorId: 'sector-1',
  sector: { id: 'sector-1', name: 'Comercial', code: 'COM', isActive: true },
  isActive: true,
  sessionVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdById: null,
  createdBy: null,
  invitedUsers: [],
  ...NO_PERSON_RECORD,
};

const operatorUser = {
  ...adminUser,
  id: 'u2',
  email: 'op@test.com',
  name: 'Operator',
  role: 'OPERATOR' as const,
};

type UsersRepositoryDouble = {
  findMany: ReturnType<typeof vi.fn>;
  countAuthorizationPending: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findByEmail: ReturnType<typeof vi.fn>;
  findActiveSector: ReturnType<typeof vi.fn>;
  findIdByRegistrationKey: ReturnType<typeof vi.fn>;
  createWithAudit: ReturnType<typeof vi.fn>;
  deleteWithLastAdminGuard: ReturnType<typeof vi.fn>;
  updateWithLastAdminGuard: ReturnType<typeof vi.fn>;
  resetPassword: ReturnType<typeof vi.fn>;
};

type AuditDouble = { log: ReturnType<typeof vi.fn> };
type RefreshDouble = { revokeAllForUser: ReturnType<typeof vi.fn> };
type PhonesDouble = {
  normalize: ReturnType<typeof vi.fn>;
  assertAvailable: ReturnType<typeof vi.fn>;
  resolveContactId: ReturnType<typeof vi.fn>;
};

const makeRepo = (overrides: Partial<UsersRepositoryDouble> = {}) =>
  ({
    findMany: vi.fn().mockResolvedValue({ data: [adminUser], total: 1 }),
    countAuthorizationPending: vi
      .fn()
      .mockResolvedValue({ unverified: 0, notAuthorized: 0 }),
    findById: vi.fn().mockResolvedValue(adminUser),
    findByEmail: vi.fn().mockResolvedValue(null),
    findActiveSector: vi.fn().mockResolvedValue({ id: 'sector-1' }),
    findIdByRegistrationKey: vi.fn().mockResolvedValue(null),
    createWithAudit: vi.fn().mockResolvedValue(adminUser),
    deleteWithLastAdminGuard: vi.fn().mockResolvedValue({ deleted: adminUser }),
    updateWithLastAdminGuard: vi.fn().mockResolvedValue({ updated: adminUser }),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) satisfies UsersRepositoryDouble;

const makeAudit = () =>
  ({ log: vi.fn().mockResolvedValue(undefined) }) satisfies AuditDouble;

const makeRefresh = () =>
  ({
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
  }) satisfies RefreshDouble;

// Telefone tem spec próprio (users.service.phone.spec.ts); aqui só não atrapalha.
const makePhones = () =>
  ({
    normalize: vi.fn().mockReturnValue('+5592991234567'),
    assertAvailable: vi.fn().mockResolvedValue(undefined),
    resolveContactId: vi.fn().mockResolvedValue('contact-1'),
  }) satisfies PhonesDouble;

function makeService(
  repo: UsersRepositoryDouble,
  audit: AuditDouble,
  refresh: RefreshDouble,
  phones: PhonesDouble = makePhones(),
): UsersService {
  return new UsersService(
    repo as unknown as UsersRepository,
    audit as unknown as AuditService,
    refresh as unknown as RefreshService,
    phones as unknown as UserPhoneService,
  );
}

describe('UsersService.listUsers', () => {
  it('strips `password` from every row in the response', async () => {
    const repo = makeRepo();
    const svc = makeService(repo, makeAudit(), makeRefresh());
    const result = await svc.listUsers(1, 20);
    for (const u of result.data) {
      expect(u).not.toHaveProperty('password');
    }
  });

  it('echoes page and pageSize in the response for frontend pagination', async () => {
    const repo = makeRepo();
    const svc = makeService(repo, makeAudit(), makeRefresh());
    const result = await svc.listUsers(3, 25);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(25);
    expect(result.total).toBe(1);
  });

  it('repassa os filtros ao repositório e devolve os contadores de autorização', async () => {
    const counts = { unverified: 3, notAuthorized: 2 };
    const repo = makeRepo({
      countAuthorizationPending: vi.fn().mockResolvedValue(counts),
    });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    const filters = {
      q: 'ab-12',
      status: 'active',
      authorization: 'UNVERIFIED',
    } as const;
    const result = await svc.listUsers(2, 10, filters);
    expect(repo.findMany).toHaveBeenCalledWith(2, 10, filters);
    expect(result.authorizationCounts).toEqual(counts);
  });
});

describe('UsersService.createUser', () => {
  it('throws ConflictError when email already exists', async () => {
    const repo = makeRepo({
      findByEmail: vi.fn().mockResolvedValue(adminUser),
    });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    await expect(
      svc.createUser(
        { email: 'admin@test.com', role: 'OPERATOR', phone: PHONE },
        'creator1',
      ),
    ).rejects.toMatchObject({ code: 'user.email_taken' });
  });

  it('returns user and temporaryPassword on success', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('hashed');
    const repo = makeRepo();
    const svc = makeService(repo, makeAudit(), makeRefresh());
    const result = await svc.createUser(
      {
        email: 'new@test.com',
        role: 'OPERATOR',
        sectorId: 'sector-1',
        phone: PHONE,
      },
      'c1',
    );
    expect(result.temporaryPassword).toHaveLength(12);
    expect(result.user.email).toBe(adminUser.email);
  });

  it('does NOT include `password` in the returned user', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('hashed');
    const repo = makeRepo();
    const svc = makeService(repo, makeAudit(), makeRefresh());
    const result = await svc.createUser(
      {
        email: 'new@test.com',
        role: 'OPERATOR',
        sectorId: 'sector-1',
        phone: PHONE,
      },
      'c1',
    );
    expect(result.user).not.toHaveProperty('password');
  });
});

describe('UsersService.updateUser', () => {
  it('throws ForbiddenError when admin tries to edit own role', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    await expect(
      svc.updateUser('u1', { role: 'OPERATOR' }, 'u1'),
    ).rejects.toMatchObject({ code: 'user.cannot_self_edit_role' });
  });

  it('throws ForbiddenError when demoting the last admin (transactional guard)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      updateWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    await expect(
      svc.updateUser('u1', { role: 'OPERATOR' }, 'other'),
    ).rejects.toMatchObject({ code: 'user.last_admin' });
  });

  it('updates name via the transactional guard (which is a no-op when role unchanged)', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    await svc.updateUser('u1', { name: 'New Name' }, 'other');
    expect(repo.updateWithLastAdminGuard).toHaveBeenCalledWith(
      'u1',
      { name: 'New Name' },
      expect.any(Function),
    );
  });
});

describe('UsersService.updateUser sessions and contention', () => {
  it("revokes the target user's sessions when their role changes", async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const refresh = makeRefresh();
    const svc = makeService(repo, makeAudit(), refresh);
    await svc.updateUser('u1', { role: 'OPERATOR' }, 'other');
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('does NOT revoke sessions for a name-only update (role unchanged)', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const refresh = makeRefresh();
    const svc = makeService(repo, makeAudit(), refresh);
    await svc.updateUser('u1', { name: 'New Name' }, 'other');
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('does NOT revoke sessions when a demotion is rejected (last admin)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      updateWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const refresh = makeRefresh();
    const svc = makeService(repo, makeAudit(), refresh);
    await expect(
      svc.updateUser('u1', { role: 'OPERATOR' }, 'other'),
    ).rejects.toMatchObject({ code: 'user.last_admin' });
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('maps exhausted serializable contention to a conflict instead of a 500', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      updateWithLastAdminGuard: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('serialization', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      ),
    });
    const service = makeService(repo, makeAudit(), makeRefresh());
    await expect(
      service.updateUser('u1', { isActive: false }, 'other'),
    ).rejects.toMatchObject({ code: 'user.concurrent_admin_change' });
  });
});

describe('UsersService.deleteUser', () => {
  it('throws ForbiddenError when deleting self', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(adminUser) });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    await expect(svc.deleteUser('u1', 'u1', 'ADMIN')).rejects.toMatchObject({
      code: 'user.cannot_delete_self',
    });
  });

  it('throws ForbiddenError when deleting the last admin (transactional guard)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      deleteWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const svc = makeService(repo, makeAudit(), makeRefresh());
    await expect(svc.deleteUser('u1', 'other', 'ADMIN')).rejects.toMatchObject({
      code: 'user.last_admin',
    });
  });

  it('deletes through the guard with the trail inside it (no audit.log)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(operatorUser),
    });
    const svc = makeService(repo, audit, makeRefresh());
    await svc.deleteUser('u2', 'u1', 'ADMIN');
    expect(repo.deleteWithLastAdminGuard).toHaveBeenCalledWith(
      'u2',
      expect.any(Function),
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("revokes the deleted user's refresh families", async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(operatorUser),
    });
    const refresh = makeRefresh();
    const svc = makeService(repo, makeAudit(), refresh);
    await svc.deleteUser('u2', 'u1', 'ADMIN');
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u2');
  });

  it('does NOT revoke sessions when the delete is rejected (last admin)', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(adminUser),
      deleteWithLastAdminGuard: vi.fn().mockResolvedValue({ lastAdmin: true }),
    });
    const refresh = makeRefresh();
    const svc = makeService(repo, makeAudit(), refresh);
    await expect(svc.deleteUser('u1', 'other', 'ADMIN')).rejects.toMatchObject({
      code: 'user.last_admin',
    });
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe('UsersService.resetPassword', () => {
  it('generates a new temp password and sets mustChangePassword=true', async () => {
    vi.mocked(argon2.hash).mockResolvedValue('newhash');
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(operatorUser),
    });
    const audit = makeAudit();
    const svc = makeService(repo, audit, makeRefresh());
    const result = await svc.resetPassword('u2', 'u1');
    expect(result.temporaryPassword).toHaveLength(12);
    expect(repo.resetPassword).toHaveBeenCalledWith('u2', 'newhash');
    expect(audit.log).toHaveBeenCalledWith(
      'user.password_reset',
      'User',
      'u2',
      expect.any(Object),
      { subjectUserId: 'u2' },
    );
  });

  it("revokes the target user's refresh families after an admin reset", async () => {
    vi.mocked(argon2.hash).mockResolvedValue('newhash');
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(operatorUser),
    });
    const refresh = makeRefresh();
    const svc = makeService(repo, makeAudit(), refresh);
    await svc.resetPassword('u2', 'u1');
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u2');
  });
});
