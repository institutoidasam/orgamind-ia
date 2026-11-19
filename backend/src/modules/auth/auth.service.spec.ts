import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService, DUMMY_PASSWORD_HASH } from './auth.service';
import { AuthRepository } from './auth.repository';
import { RefreshService } from './refresh.service';
import { AuditService } from '../../shared/audit/audit.service';
import { PermissionsService } from '../permissions/permissions.service';
import { InvalidCredentialsError } from './errors/auth.errors';
import {
  currentAuthUserSchema,
  meResponseSchema,
} from '../../schemas/contracts/auth.schema';
import { PERMISSION_KEYS } from '../../shared/authz/permissions';
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

// Permissões efetivas (CB3): por padrão nenhuma; os testes de sessão usam o
// serviço real sobre um prisma falso (`permissionsOver`).
const makePermissions = () =>
  ({
    effectiveFor: vi.fn().mockResolvedValue([]),
  }) as unknown as PermissionsService;

const makeService = (
  repo: AuthRepository,
  refresh: RefreshService = makeRefresh(),
  audit: AuditService = makeAudit(),
) => new AuthService(repo, refresh, audit, makePermissions());

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

// B1/DB13/GB2/GB3: o login e `me` devolvem as permissões efetivas do papel,
// lidas do banco a cada chamada; ADMIN e VIEWER não consultam a tabela.
const sessionUser = (over: Record<string, unknown> = {}) =>
  accessUser({ role: 'OPERATOR', sectorId: null, sector: null, ...over });

const sessionService = (user: unknown, rows: unknown[] = []) => {
  const findMany = vi.fn().mockResolvedValue(rows);
  const findById = vi.fn().mockResolvedValue(user);
  const repo = makeRepo({
    findByEmail: vi.fn().mockResolvedValue(user),
    findById,
  });
  const refresh = makeRefresh();
  const permissions = new PermissionsService(
    { rolePermission: { findMany } } as never,
    {} as never,
    {} as never,
  );
  const svc = new AuthService(repo, refresh, makeAudit(), permissions);
  return { svc, findById, findMany };
};

describe('AuthService.login quando as permissões falham', () => {
  it('rejeita com o mesmo erro, sem emitir sessão nem auditar o sucesso', async () => {
    vi.mocked(argon2.verify).mockReset().mockResolvedValue(true);
    const failure = new Error('banco fora do ar');
    const issueNew = vi.fn();
    const log = vi.fn();
    const svc = new AuthService(
      makeRepo({
        findByEmail: vi.fn().mockResolvedValue(sessionUser()),
      }),
      { issueNew } as unknown as RefreshService,
      { log } as unknown as AuditService,
      {
        effectiveFor: vi.fn().mockRejectedValue(failure),
      } as unknown as PermissionsService,
    );

    await expect(svc.login({ email: 'a@b.com', password: 'pw' })).rejects.toBe(
      failure,
    );

    expect(issueNew).not.toHaveBeenCalled();
    expect(log.mock.calls).not.toContainEqual(
      expect.arrayContaining(['auth.login_success']),
    );
  });
});

describe('AuthService.login com permissões', () => {
  it('login devolve user.permissions de effectiveFor(role), fora do token', async () => {
    vi.mocked(argon2.verify).mockReset().mockResolvedValue(true);
    const effectiveFor = vi.fn().mockResolvedValue(['pessoas.editar']);
    const issueNew = vi
      .fn()
      .mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
    const svc = new AuthService(
      makeRepo({
        findByEmail: vi
          .fn()
          .mockResolvedValue(sessionUser({ sessionVersion: 3 })),
      }),
      { issueNew } as unknown as RefreshService,
      makeAudit(),
      { effectiveFor } as unknown as PermissionsService,
    );

    const result = await svc.login({ email: 'a@b.com', password: 'pw' });

    expect(effectiveFor).toHaveBeenCalledWith('OPERATOR');
    expect(result.user.permissions).toEqual(['pessoas.editar']);
    expect(currentAuthUserSchema.parse(result.user)).toEqual(result.user);
    expect(issueNew).toHaveBeenCalledWith('u1', 'a@b.com', 'OPERATOR', 3);
  });
});

describe('AuthService.me', () => {
  beforeEach(() => {
    vi.mocked(argon2.verify).mockReset().mockResolvedValue(true);
  });

  it('me devolve o mesmo user do login e mustChangePassword', async () => {
    const user = sessionUser({ name: 'Op', mustChangePassword: true });
    const { svc, findById } = sessionService(user);

    const login = await svc.login({ email: 'a@b.com', password: 'pw' });
    const me = await svc.me('u1');

    expect(findById).toHaveBeenCalledWith('u1');
    expect(me).toEqual({ user: login.user, mustChangePassword: true });
    // o parse descarta campo desconhecido: igualdade prova que nada vaza (senha, sessionVersion)
    expect(meResponseSchema.parse(me)).toEqual(me);
  });

  it.each([
    ['ADMIN', [...PERMISSION_KEYS]],
    ['VIEWER', []],
  ])(
    '%s recebe as permissões fixas sem consultar a tabela',
    async (role, keys) => {
      const { svc, findMany } = sessionService(sessionUser({ role }));

      const me = await svc.me('u1');

      expect(me.user.permissions).toEqual(keys);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
});

describe('AuthService.me lê do banco e recusa sessão inválida', () => {
  it('lê a tabela a cada chamada, sem cache', async () => {
    const { svc, findMany } = sessionService(sessionUser());
    const before = await svc.me('u1');
    findMany.mockResolvedValue([{ key: 'pessoas.editar', granted: false }]);
    const after = await svc.me('u1');

    expect(before.user.permissions).toContain('pessoas.editar');
    expect(after.user.permissions).not.toContain('pessoas.editar');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['inexistente', null],
    ['inativo', sessionUser({ isActive: false })],
    [
      'sem acesso',
      sessionUser({ hasAccess: false, email: null, password: null }),
    ],
  ])(
    'usuário %s → InvalidCredentialsError sem ler permissões',
    async (_c, user) => {
      const { svc, findMany } = sessionService(user);

      await expect(svc.me('u1')).rejects.toThrow(InvalidCredentialsError);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
});

describe('AuthService.login', () => {
  it('throws InvalidCredentialsError when user not found', async () => {
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(null) });
    const svc = makeService(repo);
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
    const svc = makeService(repo);
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
    const svc = makeService(repo);
    await expect(svc.login({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('returns accessToken + mustChangePassword and updates lastLoginAt on success', async () => {
    const admin = accessUser({ mustChangePassword: true, name: 'Admin' });
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(admin) });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    const svc = makeService(repo);
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
      const svc = makeService(
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
    const svc = makeService(
      makeRepo({ findByEmail: vi.fn().mockResolvedValue(null) }),
      { issueNew } as unknown as RefreshService,
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
    const svc = makeService(repo);
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
    const svc = makeService(repo);
    await svc.changePassword('u1', { currentPassword: 'old', newPassword: 'New1234!' });
    expect(repo.updatePassword).toHaveBeenCalledWith('u1', 'newhash', true);
  });

  it('revokes all refresh families for the user after a successful change', async () => {
    const operator = accessUser({ role: 'OPERATOR', mustChangePassword: true });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operator) });
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(argon2.hash).mockResolvedValue('newhash' as never);
    const refresh = makeRefresh();
    const svc = makeService(repo, refresh);
    await svc.changePassword('u1', { currentPassword: 'old', newPassword: 'New1234!' });
    expect(refresh.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('does NOT revoke sessions when the current password is wrong', async () => {
    const operator = accessUser({ role: 'OPERATOR' });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(operator) });
    vi.mocked(argon2.verify).mockResolvedValue(false);
    const refresh = makeRefresh();
    const svc = makeService(repo, refresh);
    await expect(
      svc.changePassword('u1', { currentPassword: 'wrong', newPassword: 'New1234!' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when user id is invalid', async () => {
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(null) });
    const svc = makeService(repo);
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
    const svc = makeService(repo);

    await expect(
      svc.changePassword('u1', { currentPassword: 'x', newPassword: 'y' }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(argon2.verify).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
  });
});
