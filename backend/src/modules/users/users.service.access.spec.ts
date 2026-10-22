import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { ConflictError } from '../../shared/errors/domain.error';
import {
  grantAccessResponseSchema,
  userSummarySchema,
} from '../../schemas/contracts/user.schema';

vi.mock('argon2');

let repo: DeepMockProxy<UsersRepository>;
let audit: DeepMockProxy<AuditService>;
let refresh: DeepMockProxy<RefreshService>;
let phones: DeepMockProxy<UserPhoneService>;
let svc: UsersService;

// Hash falso do argon2 (fora de literal em campo "password", sonarjs).
const HASH = 'argon2id-fake';
const SECTOR = { id: 's1', name: 'Produção', code: 'PRD', isActive: true };
// Pessoa sem acesso COMPLETA (todos os campos do USER_SUMMARY_SELECT).
const person = (over: Partial<UserSummary> = {}): UserSummary => ({
  id: 'p1',
  email: null,
  hasAccess: false,
  name: 'Maria',
  role: 'VIEWER',
  sectorId: 's1',
  sector: SECTOR,
  isActive: true,
  sessionVersion: 0,
  mustChangePassword: false,
  lastLoginAt: null,
  phoneE164: '+5592991234567',
  shiftId: null,
  jobTitle: null,
  levelId: null,
  level: null,
  createdAt: new Date('2026-10-22T12:00:00Z'),
  updatedAt: new Date('2026-10-22T12:00:00Z'),
  createdById: 'admin',
  createdBy: { email: 'admin@idasam.org' },
  ...over,
});
const granted = person({
  email: 'maria@idasam.org',
  hasAccess: true,
  role: 'OPERATOR',
  mustChangePassword: true,
});
const createPerson = (over: Record<string, unknown> = {}) =>
  svc.createPersonWithoutAccess('admin', {
    name: '  Maria  ',
    phone: '92991234567',
    sectorId: 's1',
    ...over,
  });
const grant = (role: 'OPERATOR' | 'ADMIN' = 'OPERATOR') =>
  svc.grantAccess('admin', 'p1', { email: '  Maria@IDASAM.org ', role });
const created = () => repo.createSummary.mock.calls[0]?.[0];
const patched = () => repo.updateWithLastAdminGuard.mock.calls[0]?.[1];
// O contrato descreve o JSON (datas viram string).
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const uniqueEmail = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['email'] },
  });

beforeEach(() => {
  repo = mockDeep();
  audit = mockDeep();
  refresh = mockDeep();
  phones = mockDeep();
  svc = new UsersService(repo, audit, refresh, phones);
  vi.mocked(argon2.hash).mockReset().mockResolvedValue(HASH);
  phones.normalize.mockReturnValue('+5592991234567');
  phones.resolveContactId.mockResolvedValue('c1');
  repo.findByEmail.mockResolvedValue(null);
  repo.findById.mockResolvedValue(person());
  repo.findActiveSector.mockResolvedValue({ id: 's1' } as never);
  repo.findLevelForAssignment.mockResolvedValue({
    id: 'level_employee',
    isActive: true,
  });
  repo.createSummary.mockResolvedValue(person());
  repo.grantAccess.mockResolvedValue(granted);
  repo.updateWithLastAdminGuard.mockResolvedValue({ updated: {} } as never);
});

describe('criar sem acesso', () => {
  it('grava hasAccess false, VIEWER, e-mail e senha null, mustChangePassword false e temporaryPassword null', async () => {
    // Papel e e-mail no input são ignorados: D1 vale independente do pedido.
    const user = await createPerson({ role: 'ADMIN', email: 'x@idasam.org' });
    expect(created()).toMatchObject({
      name: 'Maria',
      hasAccess: false,
      role: 'VIEWER',
      email: null,
      password: null,
      mustChangePassword: false,
      phoneE164: '+5592991234567',
      sector: { connect: { id: 's1' } },
      contact: { connect: { id: 'c1' } },
      createdBy: { connect: { id: 'admin' } },
    });
    expect(phones.resolveContactId.mock.calls).toContainEqual([
      '+5592991234567',
      'Maria',
    ]);
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(userSummarySchema.parse(wire(user))).toMatchObject({
      hasAccess: false,
    });
    expect(audit.log.mock.calls).toContainEqual([
      'user.person_created',
      'User',
      'p1',
      {
        actorId: 'admin',
        sectorId: 's1',
        hasAccess: false,
      },
    ]);
  });

  it('sem setor é aceito', async () => {
    await createPerson({ sectorId: null });
    expect(created()?.sector).toBeUndefined();
    expect(repo.findActiveSector.mock.calls).toEqual([]);
  });
});

describe('criar sem acesso', () => {
  it('telefone de outra pessoa → o erro de hoje do UserPhoneService', async () => {
    phones.assertAvailable.mockRejectedValue(
      new ConflictError('Phone already taken', 'user.phone_taken'),
    );
    await expect(createPerson()).rejects.toMatchObject({
      status: 409,
      code: 'user.phone_taken',
    });
    expect(repo.createSummary.mock.calls).toEqual([]);
  });

  it('nível Funcionário (level_employee) gravado', async () => {
    await createPerson({ levelId: 'level_employee' });
    expect(repo.findLevelForAssignment.mock.calls).toContainEqual([
      'level_employee',
    ]);
    expect(created()).toMatchObject({
      level: { connect: { id: 'level_employee' } },
    });
  });
});

describe('dar acesso', () => {
  it('OPERATOR com setor ativo → hasAccess true, e-mail minúsculo, mustChangePassword true, temporaryPassword devolvida, auditoria sem e-mail', async () => {
    const res = await grant();
    expect(repo.findByEmail.mock.calls).toContainEqual(['maria@idasam.org']);
    expect(repo.grantAccess.mock.calls).toContainEqual([
      'p1',
      {
        email: 'maria@idasam.org',
        role: 'OPERATOR',
        password: HASH,
        mustChangePassword: true,
        hasAccess: true,
      },
    ]);
    expect(res.temporaryPassword).toMatch(/^[\w-]{12}$/);
    expect(argon2.hash).toHaveBeenCalledWith(
      res.temporaryPassword,
      expect.objectContaining({ type: argon2.argon2id }),
    );
    expect(grantAccessResponseSchema.parse(wire(res)).user.hasAccess).toBe(
      true,
    );
    expect(audit.log.mock.calls).toContainEqual([
      'user.access_granted',
      'User',
      'p1',
      {
        actorId: 'admin',
        role: 'OPERATOR',
      },
    ]);
    // GC8: nada de e-mail, nome, telefone nem senha na auditoria.
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(
      /maria|@|9299|argon2id-fake/i,
    );
  });
});

describe('dar acesso', () => {
  it.each([
    ['lido antes de gravar', () => repo.findById.mockResolvedValue(granted)],
    [
      'corrida: outro pedido deu acesso antes',
      () => repo.grantAccess.mockResolvedValue(null),
    ],
  ])(
    'quem já tem acesso → 409 users.already_has_access (%s)',
    async (_case, arrange) => {
      arrange();
      await expect(grant()).rejects.toMatchObject({
        status: 409,
        code: 'users.already_has_access',
      });
      expect(audit.log.mock.calls).toEqual([]);
    },
  );
});

describe('dar acesso — recusas', () => {
  it.each([
    [
      'já cadastrado',
      () => repo.findByEmail.mockResolvedValue({ id: 'u9' } as never),
    ],
    [
      'corrida no update (P2002)',
      () => repo.grantAccess.mockRejectedValue(uniqueEmail()),
    ],
  ])('e-mail de outro → 409 user.email_taken (%s)', async (_case, arrange) => {
    arrange();
    await expect(grant()).rejects.toMatchObject({
      status: 409,
      code: 'user.email_taken',
    });
    expect(audit.log.mock.calls).toEqual([]);
  });

  it.each([
    [
      'sem setor',
      'user.sector_required',
      () =>
        repo.findById.mockResolvedValue(
          person({ sectorId: null, sector: null }),
        ),
    ],
    [
      'setor inativo',
      'user.sector_invalid',
      () => repo.findActiveSector.mockResolvedValue(null),
    ],
  ])('OPERATOR %s → 422 %s', async (_case, code, arrange) => {
    arrange();
    await expect(grant()).rejects.toMatchObject({ status: 422, code });
    expect(repo.grantAccess.mock.calls).toEqual([]);
  });

  it('ADMIN sem setor recebe acesso', async () => {
    repo.findById.mockResolvedValue(person({ sectorId: null, sector: null }));
    await grant('ADMIN');
    expect(repo.grantAccess.mock.calls).toContainEqual([
      'p1',
      expect.objectContaining({ role: 'ADMIN', hasAccess: true }),
    ]);
  });
});

describe('regras de quem não tem acesso', () => {
  it('reset de senha → 422 users.no_access sem gravar', async () => {
    await expect(svc.resetPassword('p1', 'admin')).rejects.toMatchObject({
      status: 422,
      code: 'users.no_access',
    });
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(repo.resetPassword.mock.calls).toEqual([]);
    expect(refresh.revokeAllForUser.mock.calls).toEqual([]);
    expect(audit.log.mock.calls).toEqual([]);
  });

  it('PATCH role em sem acesso → 422 users.no_access', async () => {
    await expect(
      svc.updateUser('p1', { role: 'OPERATOR' }, 'admin'),
    ).rejects.toMatchObject({ status: 422, code: 'users.no_access' });
    expect(repo.updateWithLastAdminGuard.mock.calls).toEqual([]);
  });

  it('PATCH sectorId null em sem acesso é aceito', async () => {
    await svc.updateUser('p1', { sectorId: null }, 'admin');
    expect(patched()).toMatchObject({ sector: { disconnect: true } });
  });
});

describe('nível na edição', () => {
  it.each([
    ['inexistente', null],
    ['inativo e diferente do atual', { id: 'level_old', isActive: false }],
  ])(
    'levelId inválido → 422 users.invalid_level (%s)',
    async (_case, level) => {
      repo.findById.mockResolvedValue(person({ levelId: 'level_employee' }));
      repo.findLevelForAssignment.mockResolvedValue(level);
      await expect(
        svc.updateUser('p1', { levelId: 'level_old' }, 'admin'),
      ).rejects.toMatchObject({ status: 422, code: 'users.invalid_level' });
      expect(repo.updateWithLastAdminGuard.mock.calls).toEqual([]);
    },
  );

  it('PATCH com o mesmo nível inativo atual é aceito', async () => {
    repo.findById.mockResolvedValue(person({ levelId: 'level_old' }));
    repo.findLevelForAssignment.mockResolvedValue({
      id: 'level_old',
      isActive: false,
    });
    await svc.updateUser('p1', { levelId: 'level_old' }, 'admin');
    expect(patched()).toEqual({ level: { connect: { id: 'level_old' } } });
  });

  it('PATCH levelId null limpa o nível sem consultar', async () => {
    await svc.updateUser('p1', { levelId: null }, 'admin');
    expect(patched()).toEqual({ level: { disconnect: true } });
    expect(repo.findLevelForAssignment.mock.calls).toEqual([]);
  });
});

describe('nível no convite (com acesso)', () => {
  const invite = (levelId: string | null) =>
    svc.createUser(
      {
        email: 'nova@idasam.org',
        role: 'OPERATOR',
        sectorId: 's1',
        phone: '92991234567',
        levelId,
      },
      'admin',
    );

  beforeEach(() => {
    repo.create.mockResolvedValue({
      id: 'u9',
      email: 'nova@idasam.org',
      role: 'OPERATOR',
    } as never);
  });

  it('convite com levelId grava o nível', async () => {
    await invite('level_employee');
    expect(repo.create.mock.calls[0]?.[0]).toMatchObject({
      level: { connect: { id: 'level_employee' } },
    });
  });

  it.each([
    ['inexistente', null],
    ['inativo', { id: 'level_old', isActive: false }],
  ])(
    'levelId inválido no convite → 422 users.invalid_level sem criar (%s)',
    async (_case, level) => {
      repo.findLevelForAssignment.mockResolvedValue(level);
      await expect(invite('level_old')).rejects.toMatchObject({
        status: 422,
        code: 'users.invalid_level',
      });
      expect(repo.create.mock.calls).toEqual([]);
      expect(phones.resolveContactId.mock.calls).toEqual([]);
    },
  );
});

describe('nome na edição', () => {
  it('PATCH name vazio (aparado) em sem acesso → 422 users.name_required sem gravar', async () => {
    await expect(
      svc.updateUser('p1', { name: '   ' }, 'admin'),
    ).rejects.toMatchObject({ status: 422, code: 'users.name_required' });
    expect(repo.updateWithLastAdminGuard.mock.calls).toEqual([]);
  });

  it.each([
    ['sem acesso', person(), '  Ana  ', 'Ana'],
    ['com acesso, vazio como hoje', granted, '', ''],
  ])('PATCH name é gravado aparado (%s)', async (_case, user, name, saved) => {
    repo.findById.mockResolvedValue(user);
    await svc.updateUser('p1', { name }, 'admin');
    expect(patched()).toEqual({ name: saved });
  });
});
