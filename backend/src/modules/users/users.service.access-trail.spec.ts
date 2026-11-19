import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { PersonAuditRow } from './person-audit';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { NO_PERSON_RECORD } from './users.test-fixtures';

let repo: DeepMockProxy<UsersRepository>;
let audit: DeepMockProxy<AuditService>;
let refresh: DeepMockProxy<RefreshService>;
let svc: UsersService;

const TX = {} as Prisma.TransactionClient;
const EMAIL = 'maria@idasam.org';
const PHONE = '+5592991234567';
const HASH_PREFIX = '$argon2id$';
const summary = (over: Partial<UserSummary> = {}) =>
  ({
    id: 'p1',
    name: 'Maria',
    email: null,
    hasAccess: false,
    role: 'VIEWER',
    sectorId: 's1',
    isActive: true,
    phoneE164: PHONE,
    ...NO_PERSON_RECORD,
    ...over,
  }) as UserSummary;
// O retrato que o repositório lê no tx e entrega ao callback da trilha.
const row = (over: Partial<PersonAuditRow> = {}): PersonAuditRow => ({
  name: 'Maria',
  registration: null,
  jobTitle: null,
  phoneE164: PHONE,
  email: null,
  role: 'VIEWER',
  hasAccess: false,
  isActive: true,
  contactAuthorization: 'NAO_AUTORIZADO',
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
  sector: { id: 's1', name: 'Produção' },
  workShift: null,
  level: null,
  ...over,
});
const trail = () => audit.recordChange.mock.calls.map(([, change]) => change);

beforeEach(() => {
  repo = mockDeep();
  audit = mockDeep();
  refresh = mockDeep();
  svc = new UsersService(repo, audit, refresh, mockDeep<UserPhoneService>());
  repo.findById.mockResolvedValue(summary());
  repo.findByEmail.mockResolvedValue(null);
  repo.findActiveSector.mockResolvedValue({ id: 's1' } as never);
});

const grant = () =>
  svc.grantAccess('admin', 'p1', {
    email: ' Maria@IDASAM.org ',
    role: 'OPERATOR',
  });
// O repositório de mentira roda a trilha no tx como o real faria.
const dbGrant = () =>
  repo.grantAccess.mockImplementation(async (_id, _data, audited) => {
    const after = row({ email: EMAIL, hasAccess: true, role: 'OPERATOR' });
    await audited(TX, row(), after);
    return summary({ email: EMAIL, hasAccess: true, role: 'OPERATOR' });
  });
const remove = () => svc.deleteUser('p1', 'admin', 'ADMIN');

describe('dar acesso com trilha (aceite 8)', () => {
  it('grava user.access_granted: acesso, papel e e-mail mascarado; sem senha, hash nem e-mail cru', async () => {
    dbGrant();

    const res = await grant();

    expect(audit.recordChange.mock.calls[0]?.[0]).toBe(TX);
    expect(trail()).toEqual([
      {
        action: 'user.access_granted',
        entity: 'User',
        entityId: 'p1',
        category: 'PERSON',
        subjectUserId: 'p1',
        actorId: 'admin',
        reason: null,
        metadata: { role: 'OPERATOR' },
        changes: [
          { field: 'email', before: null, after: 'm•••@idasam.org' },
          { field: 'role', before: 'VIEWER', after: 'OPERATOR' },
          { field: 'hasAccess', before: false, after: true },
        ],
      },
    ]);
    const written = JSON.stringify(trail());
    expect(written).not.toContain(EMAIL);
    expect(written).not.toContain(res.temporaryPassword);
    expect(written).not.toContain(HASH_PREFIX);
    expect(audit.log.mock.calls).toEqual([]);
  });

  it('trilha que lança não é engolida: o acesso não é devolvido', async () => {
    dbGrant();
    audit.recordChange.mockRejectedValue(new Error('trilha falhou'));

    await expect(grant()).rejects.toThrow('trilha falhou');
  });
});

describe('exclusão só sem histórico (aceite 6)', () => {
  it('com histórico → 409 user.has_history com o texto de C9, sem revogar sessão', async () => {
    repo.deleteWithLastAdminGuard.mockResolvedValue({ hasHistory: true });

    await expect(remove()).rejects.toMatchObject({
      status: 409,
      code: 'user.has_history',
      message:
        'Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro.',
    });
    expect(refresh.revokeAllForUser.mock.calls).toEqual([]);
  });

  it.each(['SUPERVISOR', 'OPERATOR', 'VIEWER'] as const)(
    'ator %s → 403 user.delete_forbidden antes de ler ou apagar',
    async (role) => {
      await expect(svc.deleteUser('p1', 'actor', role)).rejects.toMatchObject({
        status: 403,
        code: 'user.delete_forbidden',
      });
      expect(repo.findById.mock.calls).toEqual([]);
      expect(repo.deleteWithLastAdminGuard.mock.calls).toEqual([]);
    },
  );
});

describe('exclusão grava a trilha (aceite 6)', () => {
  it('grava user.deleted com o retrato de antes mascarado e sem depois, no tx da exclusão', async () => {
    const before = row({ email: EMAIL, hasAccess: true, role: 'OPERATOR' });
    repo.deleteWithLastAdminGuard.mockImplementation(async (_id, audited) => {
      await audited(TX, before);
      return { deleted: before };
    });

    await remove();

    expect(audit.recordChange.mock.calls[0]?.[0]).toBe(TX);
    const [event] = trail();
    expect(event).toMatchObject({
      action: 'user.deleted',
      entity: 'User',
      entityId: 'p1',
      category: 'PERSON',
      subjectUserId: 'p1',
      actorId: 'admin',
      reason: null,
    });
    expect(event?.changes).toContainEqual({
      field: 'email',
      before: 'm•••@idasam.org',
      after: null,
    });
    expect(event?.changes).toContainEqual({
      field: 'phone',
      before: '•••• 4567',
      after: null,
    });
    const written = JSON.stringify(trail());
    expect(written).not.toContain(EMAIL);
    expect(written).not.toContain('991234567');
    expect(audit.log.mock.calls).toEqual([]);
    expect(refresh.revokeAllForUser.mock.calls).toEqual([['p1']]);
  });
});
