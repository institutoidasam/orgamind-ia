import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { NO_ASSIGNMENT } from './assignment-timeline';
import { NO_PERSON_RECORD } from './users.test-fixtures';

vi.mock('argon2');

let repo: DeepMockProxy<UsersRepository>;
let refresh: DeepMockProxy<RefreshService>;
let svc: UsersService;

// 15:00 UTC = 11:00 em Manaus: o mesmo dia civil nos dois fusos.
const TODAY = '2026-11-19';
const VINCULO = {
  sectorId: 's1',
  shiftId: 'shift_first',
  levelId: 'level_employee',
};
const VINCULO_SHIFT = { id: 'shift_first', isActive: true };
const VINCULO_LEVEL = { id: 'level_employee', isActive: true };
const MOVE = { reason: null, category: 'ASSIGNMENT' } as const;
// As seis chaves que o repositório recusa em `data` (DV15(b)).
const RELATION_KEYS = [
  'sector',
  'sectorId',
  'workShift',
  'shiftId',
  'level',
  'levelId',
];
const relationKeysIn = (data: object | undefined) =>
  RELATION_KEYS.filter((key) => key in (data ?? {}));
const person = {
  id: 'p1',
  hasAccess: false,
  role: 'VIEWER',
  name: 'Maria',
  email: null,
  isActive: true,
  phoneE164: '+5592991234567',
  ...VINCULO,
  ...NO_PERSON_RECORD,
} as unknown as UserSummary;
const createPerson = (actorId: string, over: Record<string, unknown> = {}) =>
  svc.createPersonWithoutAccess(actorId, {
    name: 'Ana',
    phone: '92991234567',
    sectorId: null,
    ...over,
  });
const updateCalls = () => repo.updateWithLastAdminGuard.mock.calls;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T15:00:00Z'));
  repo = mockDeep();
  refresh = mockDeep();
  const phones = mockDeep<UserPhoneService>();
  svc = new UsersService(repo, mockDeep<AuditService>(), refresh, phones);
  vi.mocked(argon2.hash).mockResolvedValue('hashed');
  phones.normalize.mockReturnValue('+5592991234567');
  phones.resolveContactId.mockResolvedValue('c1');
  repo.findByEmail.mockResolvedValue(null);
  repo.findById.mockResolvedValue(person);
  repo.findActiveSector.mockResolvedValue({ id: 's1' } as never);
  repo.findShiftForAssignment.mockResolvedValue(VINCULO_SHIFT);
  repo.findLevelForAssignment.mockResolvedValue(VINCULO_LEVEL);
  repo.createWithAudit.mockResolvedValue(person);
  repo.updateWithLastAdminGuard.mockResolvedValue({ updated: {} } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UsersService — vínculo na criação (aceite 20)', () => {
  it('createUser e createPersonWithoutAccess mandam setor, turno e nível em assignment, nunca em data', async () => {
    await svc.createUser(
      {
        email: 'nova@idasam.org',
        role: 'OPERATOR',
        phone: '92991234567',
        ...VINCULO,
      },
      'admin',
    );
    await createPerson('gestor', VINCULO);
    await createPerson('gestor');

    const calls = repo.createWithAudit.mock.calls;
    expect(calls.map(([data]) => relationKeysIn(data))).toEqual([[], [], []]);
    expect(calls.map(([, , assignment]) => assignment)).toEqual([
      { patch: VINCULO, today: TODAY, actorId: 'admin' },
      { patch: VINCULO, today: TODAY, actorId: 'gestor' },
      { patch: NO_ASSIGNMENT, today: TODAY, actorId: 'gestor' },
    ]);
  });
});

describe('UsersService — vínculo na edição (aceite 20)', () => {
  it('updateUser manda só as chaves do PATCH em assignment; sem chave de vínculo, sem assignment', async () => {
    await svc.updateUser(
      'p1',
      { shiftId: 'shift_first', levelId: '' },
      'admin',
    );
    await svc.updateUser('p1', { sectorId: 's2' }, 'gestor', MOVE);
    await svc.updateUser('p1', { name: 'Bia' }, 'admin');

    expect(updateCalls().map(([, data]) => relationKeysIn(data))).toEqual([
      [],
      [],
      [],
    ]);
    expect(updateCalls().map((call) => call[3])).toEqual([
      {
        patch: { shiftId: 'shift_first', levelId: null },
        today: TODAY,
        actorId: 'admin',
      },
      { patch: { sectorId: 's2' }, today: TODAY, actorId: 'gestor' },
      undefined,
    ]);
  });

  it('tirar do setor (sectorId null) mantém turno e nível fora do patch', async () => {
    await svc.updateUser('p1', { sectorId: null }, 'gestor', MOVE);

    expect(updateCalls()[0]?.[1]).toEqual({ sessionVersion: { increment: 1 } });
    expect(updateCalls()[0]?.[3]).toEqual({
      patch: { sectorId: null },
      today: TODAY,
      actorId: 'gestor',
    });
    expect(refresh.revokeAllForUser.mock.calls).toEqual([['p1']]);
  });
});

describe('UsersService — "hoje" da troca de vínculo (DV7)', () => {
  it('hoje da troca é a data de Manaus, não a de UTC', async () => {
    vi.setSystemTime(new Date('2026-11-20T03:59:00Z'));
    await svc.updateUser('p1', { levelId: null }, 'admin');
    vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
    await createPerson('admin');

    expect(updateCalls()[0]?.[3]?.today).toBe('2026-11-19');
    expect(repo.createWithAudit.mock.calls[0]?.[2]?.today).toBe('2026-11-20');
  });
});

describe('UsersService — concorrência na troca de vínculo (DV7)', () => {
  it('P2002 da linha aberta com tentativas esgotadas → o mesmo 409 do P2034, nunca 500', async () => {
    repo.updateWithLastAdminGuard.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { modelName: 'UserAssignment', target: ['userId'] },
      }),
    );

    await expect(
      svc.updateUser('p1', { sectorId: 's2' }, 'gestor', MOVE),
    ).rejects.toMatchObject({
      status: 409,
      code: 'user.concurrent_admin_change',
    });
    expect(refresh.revokeAllForUser.mock.calls).toEqual([]);
  });
});
