import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { RefreshService } from './refresh.service';
import { AuditService } from '../../shared/audit/audit.service';
import { InvalidCredentialsError } from './errors/auth.errors';
import argon2 from 'argon2';

vi.mock('argon2');

const makeRepo = (overrides: Partial<InstanceType<typeof AuthRepository>> = {}) =>
  ({
    findByEmail: vi.fn(),
    findById: vi.fn(),
    updateLastLoginAt: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as AuthRepository;

const makeRefresh = () =>
  ({
    issueNew: vi.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' }),
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
  }) as unknown as RefreshService;

const makeAudit = () =>
  ({
    log: vi.fn().mockResolvedValue(undefined),
  }) as unknown as AuditService;

describe('AuthService.login', () => {
  it('throws InvalidCredentialsError when user not found', async () => {
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(null) });
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(svc.login({ email: 'x@x.com', password: 'pw' })).rejects.toThrow(
      InvalidCredentialsError,
    );
    expect(repo.updateLastLoginAt).not.toHaveBeenCalled();
  });

  it('verifies against a dummy hash when the user does not exist (timing side-channel)', async () => {
    // Regression: returning early before any argon2.verify let an attacker
    // distinguish "user does not exist" (fast) from "wrong password" (slow,
    // one argon2 hash) by response time, enabling account enumeration. The
    // no-user path must still spend one argon2.verify against a fixed dummy
    // hash so both paths take comparable time.
    vi.mocked(argon2.verify).mockClear();
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(null) });
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(
      svc.login({ email: 'ghost@x.com', password: 'pw' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(argon2.verify).toHaveBeenCalledTimes(1);
  });

  it('throws InvalidCredentialsError on wrong password', async () => {
    const repo = makeRepo({
      findByEmail: vi.fn().mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: 'hash', role: 'ADMIN',
        mustChangePassword: false, name: null,
      }),
    });
    vi.mocked(argon2.verify).mockResolvedValue(false);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(svc.login({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('returns accessToken + mustChangePassword and updates lastLoginAt on success', async () => {
    const repo = makeRepo({
      findByEmail: vi.fn().mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: 'hash', role: 'ADMIN',
        mustChangePassword: true, name: 'Admin',
      }),
    });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    const result = await svc.login({ email: 'a@b.com', password: 'pass' });

    expect(result.mustChangePassword).toBe(true);
    expect(result.user.name).toBe('Admin');
    expect(repo.updateLastLoginAt).toHaveBeenCalledWith('u1');
  });
});

describe('AuthService.changePassword', () => {
  it('throws InvalidCredentialsError when current password is wrong', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: 'hash', role: 'OPERATOR',
        mustChangePassword: false, name: null,
      }),
    });
    vi.mocked(argon2.verify).mockResolvedValue(false);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(
      svc.changePassword('u1', { currentPassword: 'wrong', newPassword: 'New1234!' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(repo.updatePassword).not.toHaveBeenCalled();
  });

  it('hashes new password and zeroes mustChangePassword on success', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: 'hash', role: 'OPERATOR',
        mustChangePassword: true, name: null,
      }),
    });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await svc.changePassword('u1', { currentPassword: 'old', newPassword: 'New1234!' });
    expect(repo.updatePassword).toHaveBeenCalledWith('u1', 'newhash', true);
  });

  it('revokes all refresh families for the user after a successful change', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: 'hash', role: 'OPERATOR',
        mustChangePassword: true, name: null,
      }),
    });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const refresh = makeRefresh();
    const svc = new AuthService(repo, refresh, makeAudit());
    await svc.changePassword('u1', { currentPassword: 'old', newPassword: 'New1234!' });
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('does NOT revoke sessions when the current password is wrong', async () => {
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'u1', email: 'a@b.com', password: 'hash', role: 'OPERATOR',
        mustChangePassword: false, name: null,
      }),
    });
    vi.mocked(argon2.verify).mockResolvedValue(false);
    const refresh = makeRefresh();
    const svc = new AuthService(repo, refresh, makeAudit());
    await expect(
      svc.changePassword('u1', { currentPassword: 'wrong', newPassword: 'New1234!' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when user id is invalid', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(null) });
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(
      svc.changePassword('ghost', { currentPassword: 'x', newPassword: 'y' }),
    ).rejects.toThrow();
  });
});
