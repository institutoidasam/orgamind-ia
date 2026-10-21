import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { createUserSchema } from './dto/create-user.dto';
import { updateUserSchema } from './dto/update-user.dto';
import { userListResponseSchema } from '../../schemas/contracts/user.schema';

vi.mock('argon2');

let repo: DeepMockProxy<UsersRepository>;
let refresh: DeepMockProxy<RefreshService>;
let svc: UsersService;

// Usuário COMPLETO (todos os campos do USER_SUMMARY_SELECT): o parse do contrato exige.
const fullUser = (over: Partial<UserSummary> = {}): UserSummary => ({
  id: 'u1',
  email: 'u1@idasam.org',
  name: 'Ana',
  role: 'OPERATOR',
  sectorId: 's1',
  sector: { id: 's1', name: 'Produção', code: 'PRD', isActive: true },
  isActive: true,
  sessionVersion: 0,
  mustChangePassword: false,
  lastLoginAt: null,
  phoneE164: '+5592991234567',
  shift: 'FIRST',
  createdAt: new Date('2026-10-01T12:00:00Z'),
  updatedAt: new Date('2026-10-01T12:00:00Z'),
  createdById: null,
  createdBy: null,
  ...over,
});
const invite = (extra: { shift?: 'FIRST' | 'SECOND' | null } = {}) =>
  svc.createUser(
    { email: 'a@idasam.org', role: 'ADMIN', phone: '92991234567', ...extra },
    'admin',
  );
const patchData = () => repo.updateWithLastAdminGuard.mock.calls[0]?.[1];

beforeEach(() => {
  repo = mockDeep();
  refresh = mockDeep();
  const phones = mockDeep<UserPhoneService>();
  svc = new UsersService(repo, mockDeep<AuditService>(), refresh, phones);
  vi.mocked(argon2.hash).mockResolvedValue('hashed');
  repo.findByEmail.mockResolvedValue(null);
  repo.create.mockResolvedValue({
    id: 'u-new',
    email: 'a@idasam.org',
  } as never);
  repo.findById.mockResolvedValue(fullUser());
  repo.updateWithLastAdminGuard.mockResolvedValue({ updated: {} } as never);
  phones.normalize.mockReturnValue('+5592991234567');
  phones.resolveContactId.mockResolvedValue('c1');
});

describe('UsersService — turno no cadastro e na edição', () => {
  it('cadastro grava o turno informado e null quando ausente', async () => {
    await invite({ shift: 'SECOND' });
    await invite();
    expect(repo.create.mock.calls[0][0]).toMatchObject({ shift: 'SECOND' });
    expect(repo.create.mock.calls[1][0]).toMatchObject({ shift: null });
  });

  it('PATCH sem shift não envia shift ao repositório (R5)', async () => {
    await svc.updateUser('u1', { name: 'Ana Maria' }, 'admin');
    expect(patchData()).toMatchObject({ name: 'Ana Maria' });
    expect(patchData()).not.toHaveProperty('shift');
  });

  it('PATCH shift null limpa e não revoga sessão (R5)', async () => {
    await svc.updateUser('u1', { shift: null }, 'admin');
    expect(patchData()).toEqual({ shift: null });
    expect(refresh.revokeAllForUser.mock.calls).toEqual([]);
  });
});

describe('Contrato de usuário — turno', () => {
  it('listUsers devolve shift e passa no contrato', async () => {
    repo.findMany.mockResolvedValue({
      data: [
        fullUser({ shift: null }),
        fullUser({ id: 'u2', shift: 'SECOND' }),
      ],
      total: 2,
    });
    const res = await svc.listUsers(1, 20);
    const wire = userListResponseSchema.parse(JSON.parse(JSON.stringify(res)));
    expect(wire.data.map((u) => u.shift)).toEqual([null, 'SECOND']);
  });

  it('createUserSchema mantém o turno informado e rejeita turno desconhecido', () => {
    const base = { email: 'a@idasam.org', phone: '92991234567' };
    expect(createUserSchema.parse({ ...base, shift: 'FIRST' }).shift).toBe(
      'FIRST',
    );
    expect(
      createUserSchema.safeParse({ ...base, shift: 'THIRD' }).success,
    ).toBe(false);
  });

  it.each([
    [{ shift: null }, true],
    [{ shift: 'SECOND' }, true],
    [{ shift: 'THIRD' }, false],
  ])('updateUserSchema %o → válido=%s', (body, ok) => {
    expect(updateUserSchema.safeParse(body).success).toBe(ok);
  });
});
