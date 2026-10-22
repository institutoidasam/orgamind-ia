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
  hasAccess: true,
  name: 'Ana',
  role: 'OPERATOR',
  sectorId: 's1',
  sector: { id: 's1', name: 'Produção', code: 'PRD', isActive: true },
  isActive: true,
  sessionVersion: 0,
  mustChangePassword: false,
  lastLoginAt: null,
  phoneE164: '+5592991234567',
  shiftId: 'shift_first',
  jobTitle: null,
  levelId: null,
  level: null,
  createdAt: new Date('2026-10-01T12:00:00Z'),
  updatedAt: new Date('2026-10-01T12:00:00Z'),
  createdById: null,
  createdBy: null,
  ...over,
});
const invite = (extra: { shiftId?: string | null } = {}) =>
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

const ACTIVE = { id: 'shift_first', isActive: true };
const invalidShift = { status: 422, code: 'users.invalid_shift' };

describe('UsersService — turno (shiftId) no cadastro e na edição', () => {
  it('POST e PATCH com shiftId de turno ativo gravam shift_first; POST sem turno não liga', async () => {
    repo.findShiftForAssignment.mockResolvedValue(ACTIVE);
    await invite({ shiftId: 'shift_first' });
    await invite();
    await svc.updateUser('u1', { shiftId: 'shift_first' }, 'admin');
    const connect = { workShift: { connect: { id: 'shift_first' } } };
    expect(repo.create.mock.calls[0][0]).toMatchObject(connect);
    expect(repo.create.mock.calls[1][0]).not.toHaveProperty('workShift');
    expect(patchData()).toEqual(connect);
    expect(repo.findShiftForAssignment.mock.calls).toEqual([
      ['shift_first'],
      ['shift_first'],
    ]);
  });

  it.each([
    ['inexistente', null],
    ['inativo', { id: 'shift_old', isActive: false }],
  ])('shiftId %s → 422 users.invalid_shift sem gravar', async (_, found) => {
    repo.findShiftForAssignment.mockResolvedValue(found);
    await expect(invite({ shiftId: 'shift_old' })).rejects.toMatchObject(
      invalidShift,
    );
    await expect(
      svc.updateUser('u1', { shiftId: 'shift_old' }, 'admin'),
    ).rejects.toMatchObject(invalidShift);
    expect(repo.create.mock.calls).toEqual([]);
    expect(repo.updateWithLastAdminGuard.mock.calls).toEqual([]);
  });

  it('PATCH sem shiftId não envia shiftId ao repositório', async () => {
    await svc.updateUser('u1', { name: 'Ana Maria' }, 'admin');
    expect(patchData()).toMatchObject({ name: 'Ana Maria' });
    expect(patchData()).not.toHaveProperty('workShift');
    expect(patchData()).not.toHaveProperty('shiftId');
  });

  it('PATCH shiftId null limpa e não revoga sessão', async () => {
    await svc.updateUser('u1', { shiftId: null }, 'admin');
    expect(patchData()).toEqual({ workShift: { disconnect: true } });
    expect(repo.findShiftForAssignment.mock.calls).toEqual([]);
    expect(refresh.revokeAllForUser.mock.calls).toEqual([]);
  });
});

describe('Contrato de usuário — shiftId', () => {
  it('listUsers devolve shiftId e passa no contrato', async () => {
    repo.findMany.mockResolvedValue({
      data: [
        fullUser({ shiftId: null }),
        fullUser({ id: 'u2', shiftId: 'shift_second' }),
      ],
      total: 2,
    });
    const res = await svc.listUsers(1, 20);
    const wire = userListResponseSchema.parse(JSON.parse(JSON.stringify(res)));
    expect(wire.data.map((u) => u.shiftId)).toEqual([null, 'shift_second']);
  });

  it('createUserSchema mantém shiftId, aceita null e rejeita vazio', () => {
    const base = { email: 'a@idasam.org', phone: '92991234567' };
    const parse = (shiftId: unknown) =>
      createUserSchema.safeParse({ ...base, shiftId });
    expect(parse('shift_first').data?.shiftId).toBe('shift_first');
    expect(parse(null).data?.shiftId).toBeNull();
    expect(parse('').success).toBe(false);
  });

  it.each([
    [{ shiftId: null }, true],
    [{ shiftId: 'shift_second' }, true],
    [{ shiftId: '' }, false],
    [{ shift: 'FIRST' }, false],
  ])('updateUserSchema %o → válido=%s', (body, ok) => {
    expect(updateUserSchema.safeParse(body).success).toBe(ok);
  });
});
