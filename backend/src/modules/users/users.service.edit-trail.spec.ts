import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
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
let phones: DeepMockProxy<UserPhoneService>;
let svc: UsersService;

const TX = {} as Prisma.TransactionClient;
const OLD_PHONE = '+5592990000000';
const NEW_PHONE = '+5592991234567';
const REASON = 'ajuste do cadastro';
// O que o serviço lê fora do tx para validar (só as colunas que ele consulta).
const summary = (over: Partial<UserSummary> = {}) =>
  ({
    id: 'p1',
    name: 'Maria',
    email: null,
    hasAccess: false,
    role: 'VIEWER',
    sectorId: 's1',
    isActive: true,
    phoneE164: OLD_PHONE,
    ...NO_PERSON_RECORD,
    ...over,
  }) as UserSummary;
// O que o repositório lê dentro do tx e entrega ao callback da trilha.
const row = (over: Partial<PersonAuditRow> = {}): PersonAuditRow => ({
  name: 'Maria',
  registration: null,
  jobTitle: null,
  phoneE164: OLD_PHONE,
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
// O repositório de mentira roda o callback da trilha como o real faria no tx.
const dbChange = (before: PersonAuditRow, after: PersonAuditRow) =>
  repo.updateWithLastAdminGuard.mockImplementation(
    async (_id, _data, trail) => {
      await trail?.(TX, before, after);
      return { updated: after };
    },
  );
const edit = (
  input: Parameters<UsersService['updateUser']>[1],
  reason = REASON,
) => svc.updateUser('p1', input, 'admin', { reason });
const written = () => repo.updateWithLastAdminGuard.mock.calls[0]?.[1];
const trail = () => audit.recordChange.mock.calls.map(([, change]) => change);
const uniqueOn = (target: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });

const termo = {
  status: 'AUTORIZADO',
  source: 'TERMO_ASSINADO',
  date: '2026-11-10',
} as const;
const authorized = {
  contactAuthorization: 'AUTORIZADO',
  authorizationSource: 'TERMO_ASSINADO',
  authorizationDate: new Date('2026-11-10T00:00:00.000Z'),
} as const;

beforeEach(() => {
  repo = mockDeep();
  audit = mockDeep();
  refresh = mockDeep();
  phones = mockDeep();
  svc = new UsersService(repo, audit, refresh, phones);
  phones.normalize.mockReturnValue(NEW_PHONE);
  phones.resolveContactId.mockResolvedValue('c1');
  repo.findById.mockResolvedValue(summary());
  repo.findActiveSector.mockResolvedValue({ id: 's2' } as never);
  repo.findIdByRegistrationKey.mockResolvedValue(null);
  dbChange(row(), row());
});

describe('edição com trilha (aceite 2)', () => {
  it('telefone e função: grava só os dois campos, telefone mascarado, autor e motivo', async () => {
    dbChange(row(), row({ phoneE164: NEW_PHONE, jobTitle: 'Operadora' }));

    await edit({ phone: '92991234567', jobTitle: 'Operadora' });

    expect(audit.recordChange.mock.calls[0]?.[0]).toBe(TX);
    expect(trail()).toEqual([
      {
        action: 'user.profile_updated',
        entity: 'User',
        entityId: 'p1',
        category: 'PERSON',
        subjectUserId: 'p1',
        actorId: 'admin',
        reason: REASON,
        changes: [
          { field: 'jobTitle', before: null, after: 'Operadora' },
          { field: 'phone', before: '•••• 0000', after: '•••• 4567' },
        ],
      },
    ]);
    expect(JSON.stringify(trail())).not.toContain('991234567');
  });

  it('nada mudou: não grava trilha', async () => {
    await edit({ name: 'Maria' });

    expect(repo.updateWithLastAdminGuard.mock.calls).toHaveLength(1);
    expect(audit.recordChange.mock.calls).toEqual([]);
  });
});

describe('papel e meta na edição com trilha (aceite 2)', () => {
  it('troca de papel entra como campo role, sem senha, e revoga a sessão', async () => {
    repo.findById.mockResolvedValue(summary({ hasAccess: true }));
    dbChange(row({ role: 'OPERATOR' }), row({ role: 'SUPERVISOR' }));

    await edit({ role: 'SUPERVISOR' });

    expect(trail()).toMatchObject([
      {
        action: 'user.role_changed',
        changes: [{ field: 'role', before: 'OPERATOR', after: 'SUPERVISOR' }],
      },
    ]);
    expect(refresh.revokeAllForUser.mock.calls).toEqual([['p1']]);
  });

  it('meta.action e meta.category substituem os derivados (uso do setor)', async () => {
    dbChange(row(), row({ sector: { id: 's2', name: 'Logística' } }));

    await svc.updateUser('p1', { sectorId: 's2' }, 'gestor', {
      reason: null,
      action: 'sector_people.person_moved',
      category: 'ASSIGNMENT',
    });

    expect(trail()).toMatchObject([
      {
        action: 'sector_people.person_moved',
        category: 'ASSIGNMENT',
        actorId: 'gestor',
        reason: null,
        changes: [
          {
            field: 'sector',
            before: { id: 's1', name: 'Produção' },
            after: { id: 's2', name: 'Logística' },
          },
        ],
      },
    ]);
  });
});

describe('inativar e reativar (aceite 6)', () => {
  it('isActive false grava user.deactivated e revoga a sessão; true grava user.reactivated', async () => {
    repo.findById.mockResolvedValue(summary({ hasAccess: true }));
    dbChange(row(), row({ isActive: false }));
    await edit({ isActive: false });
    dbChange(row({ isActive: false }), row());
    await edit({ isActive: true });

    expect(trail()).toMatchObject([
      {
        action: 'user.deactivated',
        reason: REASON,
        changes: [{ field: 'isActive', before: true, after: false }],
      },
      {
        action: 'user.reactivated',
        changes: [{ field: 'isActive', before: false, after: true }],
      },
    ]);
    expect(refresh.revokeAllForUser.mock.calls).toEqual([['p1'], ['p1']]);
  });
});

describe('autorização na edição (A2, D17)', () => {
  it('só autorização grava user.authorization_changed com antes e depois e o autor da coluna', async () => {
    dbChange(row(), row(authorized));

    await edit({ contactAuthorization: termo });

    expect(written()).toMatchObject({
      contactAuthorization: 'AUTORIZADO',
      authorizationRecordedById: 'admin',
    });
    expect(trail()).toMatchObject([
      {
        action: 'user.authorization_changed',
        changes: [
          {
            field: 'contactAuthorization',
            before: 'NAO_AUTORIZADO',
            after: 'AUTORIZADO',
          },
          {
            field: 'authorizationSource',
            before: null,
            after: 'TERMO_ASSINADO',
          },
          { field: 'authorizationDate', before: null, after: '2026-11-10' },
        ],
      },
    ]);
  });

  it('reenviar a mesma autorização não regrava authorizationRecordedAt/RecordedById nem grava trilha (D17)', async () => {
    repo.findById.mockResolvedValue(
      summary({
        ...authorized,
        authorizationRecordedAt: new Date('2026-11-01T12:00:00Z'),
      }),
    );
    dbChange(row(authorized), row(authorized));

    await edit({ contactAuthorization: termo });

    expect(written()).toEqual({});
    expect(audit.recordChange.mock.calls).toEqual([]);
  });
});

describe('matrícula na edição (A1, aceite 7)', () => {
  const taken = { status: 422, code: 'user.registration_taken' };

  it('matrícula de outra pessoa (sem diferenciar maiúsculas) → 422 antes de gravar', async () => {
    repo.findIdByRegistrationKey.mockResolvedValue('outra');

    await expect(edit({ registration: 'AB-12' })).rejects.toMatchObject(taken);

    expect(repo.findIdByRegistrationKey.mock.calls).toEqual([['ab-12']]);
    expect(repo.updateWithLastAdminGuard.mock.calls).toEqual([]);
  });

  it('corrida: P2002 na chave da matrícula durante a gravação → 422', async () => {
    repo.updateWithLastAdminGuard.mockRejectedValue(
      uniqueOn('registrationKey'),
    );

    await expect(edit({ registration: 'AB-12' })).rejects.toMatchObject(taken);
  });

  it('a própria matrícula não conflita e grava a chave; null limpa as duas colunas', async () => {
    repo.findIdByRegistrationKey.mockResolvedValue('p1');
    await edit({ registration: ' AB-12 ' });
    await edit({ registration: null });

    expect(repo.updateWithLastAdminGuard.mock.calls.map((c) => c[1])).toEqual([
      { registration: 'AB-12', registrationKey: 'ab-12' },
      { registration: null, registrationKey: null },
    ]);
  });
});
