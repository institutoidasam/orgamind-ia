import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService, DUMMY_PASSWORD_HASH } from './auth.service';
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

// Usuário com acesso (C2): e-mail, senha e `hasAccess` true.
const accessUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'a@b.com',
  password: 'hash',
  role: 'ADMIN',
  mustChangePassword: false,
  name: null,
  hasAccess: true,
  isActive: true,
  ...over,
});

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
      findByEmail: vi.fn().mockResolvedValue(accessUser()),
    });
    vi.mocked(argon2.verify).mockResolvedValue(false);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(svc.login({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('returns accessToken + mustChangePassword and updates lastLoginAt on success', async () => {
    const admin = accessUser({ mustChangePassword: true, name: 'Admin' });
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(admin) });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    const result = await svc.login({ email: 'a@b.com', password: 'pass' });

    expect(result.mustChangePassword).toBe(true);
    expect(result.user.name).toBe('Admin');
    expect(repo.updateLastLoginAt).toHaveBeenCalledWith('u1');
  });
});

// C2/D2: quem não tem acesso cai no mesmo 401, com o mesmo custo de argon2 do
// usuário inexistente; a auditoria nova não grava e-mail (GC8).
describe('login de quem não tem acesso', () => {
  beforeEach(() => {
    vi.mocked(argon2.verify).mockReset().mockResolvedValue(false);
  });

  it.each([
    { hasAccess: false, password: null },
    { hasAccess: true, password: null },
  ])(
    'hasAccess $hasAccess, senha $password → InvalidCredentialsError e verify do hash fictício',
    async (access) => {
      const person = accessUser({
        id: 'u-sem-acesso',
        role: 'VIEWER',
        ...access,
      });
      const issueNew = vi.fn();
      const log = vi.fn().mockResolvedValue(undefined);
      const updateLastLoginAt = vi.fn();
      const svc = new AuthService(
        makeRepo({
          findByEmail: vi.fn().mockResolvedValue(person),
          updateLastLoginAt,
        }),
        { issueNew } as unknown as RefreshService,
        { log } as unknown as AuditService,
      );

      await expect(
        svc.login({ email: 'a@b.com', password: 'pw' }),
      ).rejects.toThrow(InvalidCredentialsError);

      expect(argon2.verify).toHaveBeenCalledTimes(1);
      expect(argon2.verify).toHaveBeenCalledWith(DUMMY_PASSWORD_HASH, 'pw');
      expect(log).toHaveBeenCalledWith(
        'auth.login_failed',
        'User',
        'u-sem-acesso',
        { reason: 'no_access' },
      );
      expect(issueNew).not.toHaveBeenCalled();
      expect(updateLastLoginAt).not.toHaveBeenCalled();
    },
  );

  it('login com o telefone da pessoa → InvalidCredentialsError', async () => {
    const issueNew = vi.fn();
    const svc = new AuthService(
      makeRepo({ findByEmail: vi.fn().mockResolvedValue(null) }),
      { issueNew } as unknown as RefreshService,
      makeAudit(),
    );

    await expect(
      svc.login({ email: '+5592991234567', password: 'pw' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(issueNew).not.toHaveBeenCalled();
  });
});

describe('AuthService.changePassword', () => {
  it('throws InvalidCredentialsError when current password is wrong', async () => {
    const operator = accessUser({ role: 'OPERATOR' });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operator) });
    vi.mocked(argon2.verify).mockResolvedValue(false);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await expect(
      svc.changePassword('u1', { currentPassword: 'wrong', newPassword: 'New1234!' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(repo.updatePassword).not.toHaveBeenCalled();
  });

  it('hashes new password and zeroes mustChangePassword on success', async () => {
    const operator = accessUser({ role: 'OPERATOR', mustChangePassword: true });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operator) });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const svc = new AuthService(repo, makeRefresh(), makeAudit());
    await svc.changePassword('u1', { currentPassword: 'old', newPassword: 'New1234!' });
    expect(repo.updatePassword).toHaveBeenCalledWith('u1', 'newhash', true);
  });

  it('revokes all refresh families for the user after a successful change', async () => {
    const operator = accessUser({ role: 'OPERATOR', mustChangePassword: true });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operator) });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const refresh = makeRefresh();
    const svc = new AuthService(repo, refresh, makeAudit());
    await svc.changePassword('u1', { currentPassword: 'old', newPassword: 'New1234!' });
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('does NOT revoke sessions when the current password is wrong', async () => {
    const operator = accessUser({ role: 'OPERATOR' });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operator) });
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

// Defesa em profundidade: sem acesso não há sessão; mesmo assim a troca recusa
// sem chamar o argon2 com senha NULL.
describe('troca de senha de quem não tem acesso', () => {
  it('hasAccess false, senha null → InvalidCredentialsError sem gravar', async () => {
    vi.mocked(argon2.verify).mockReset();
    const updatePassword = vi.fn();
    const person = accessUser({
      hasAccess: false,
      email: null,
      password: null,
    });
    const repo = makeRepo({
      findById: vi.fn().mockResolvedValue(person),
      updatePassword,
    });
    const svc = new AuthService(repo, makeRefresh(), makeAudit());

    await expect(
      svc.changePassword('u1', { currentPassword: 'x', newPassword: 'y' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(argon2.verify).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
  });
});
