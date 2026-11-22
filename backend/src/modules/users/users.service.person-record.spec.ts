import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { PersonAuditRow } from './person-audit';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { NO_PERSON_RECORD } from './users.test-fixtures';
import { userSummarySchema } from '../../schemas/contracts/user.schema';

vi.mock('argon2');

let repo: DeepMockProxy<UsersRepository>;
let audit: DeepMockProxy<AuditService>;
let phones: DeepMockProxy<UserPhoneService>;
let svc: UsersService;

const TX = {} as Prisma.TransactionClient;
const PHONE = '+5592991234567';
const SECTOR = { id: 's1', name: 'Produção', code: 'PRD', isActive: true };
// Pessoa criada como o repositório devolve (todas as colunas do USER_SUMMARY_SELECT).
const created = (over: Partial<UserSummary> = {}): UserSummary => ({
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
  phoneE164: PHONE,
  shiftId: null,
  jobTitle: null,
  ...NO_PERSON_RECORD,
  levelId: null,
  level: null,
  createdAt: new Date('2026-11-19T12:00:00Z'),
  updatedAt: new Date('2026-11-19T12:00:00Z'),
  createdById: 'admin',
  createdBy: { email: 'admin@idasam.org' },
  ...over,
});
// Retrato lido no próprio tx, como o repositório entrega ao callback da trilha.
const auditRow = (over: Partial<PersonAuditRow> = {}): PersonAuditRow => ({
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
const person = (over: Record<string, unknown> = {}) =>
  svc.createPersonWithoutAccess('admin', {
    name: 'Maria',
    phone: '92991234567',
    sectorId: 's1',
    ...over,
  });
const invite = (over: Record<string, unknown> = {}) =>
  svc.createUser(
    {
      email: 'maria@idasam.org',
      role: 'OPERATOR',
      sectorId: 's1',
      phone: '92991234567',
      ...over,
    },
    'admin',
  );
const doors = [
  ['createUser', invite],
  ['createPersonWithoutAccess', person],
] as const;
// O repositório abre o tx, lê o retrato e chama o callback da trilha.
const withTrail = (row: PersonAuditRow, summary: UserSummary) =>
  repo.createWithAudit.mockImplementation(async (_data, trail) => {
    await trail(TX, row, summary.id);
    return summary;
  });
const trailDoors = [
  [
    'createUser',
    invite,
    'user.invited',
    { role: 'OPERATOR', email: 'maria@idasam.org' },
  ],
  [
    'createPersonWithoutAccess',
    person,
    'user.person_created',
    { role: 'VIEWER', email: null },
  ],
] as const;
const savedData = () => repo.createWithAudit.mock.calls[0]?.[0];
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const uniqueOn = (target: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });

beforeEach(() => {
  repo = mockDeep();
  audit = mockDeep();
  phones = mockDeep();
  svc = new UsersService(repo, audit, mockDeep<RefreshService>(), phones);
  vi.mocked(argon2.hash).mockReset().mockResolvedValue('argon2id-fake');
  phones.normalize.mockReturnValue(PHONE);
  phones.resolveContactId.mockResolvedValue('c1');
  repo.findByEmail.mockResolvedValue(null);
  repo.findActiveSector.mockResolvedValue({ id: 's1' } as never);
  repo.findIdByRegistrationKey.mockResolvedValue(null);
  repo.createWithAudit.mockResolvedValue(created());
});

describe('ficha na criação: sem autorização informada', () => {
  it('createUser sem contactAuthorization grava NAO_AUTORIZADO', async () => {
    const { user } = await invite();
    expect(savedData()).toMatchObject({
      registration: null,
      registrationKey: null,
      contactAuthorization: 'NAO_AUTORIZADO',
      authorizationSource: null,
      authorizationDate: null,
      authorizationRecordedById: 'admin',
    });
    expect(userSummarySchema.parse(wire(user))).toMatchObject({
      registration: null,
      contactAuthorization: { status: 'NAO_AUTORIZADO', source: null },
    });
  });
});

describe('ficha na criação: com autorização informada', () => {
  it('createPersonWithoutAccess com TERMO_ASSINADO grava AUTORIZADO, data, autor e a matrícula aparada', async () => {
    repo.createWithAudit.mockResolvedValue(
      created({
        registration: 'Ab-12',
        contactAuthorization: 'AUTORIZADO',
        authorizationSource: 'TERMO_ASSINADO',
        authorizationDate: new Date('2026-11-10T00:00:00.000Z'),
        authorizationRecordedAt: new Date('2026-11-19T12:00:00Z'),
      }),
    );
    const user = await person({
      registration: ' Ab-12 ',
      contactAuthorization: {
        status: 'AUTORIZADO',
        source: 'TERMO_ASSINADO',
        date: '2026-11-10',
      },
    });
    expect(savedData()).toMatchObject({
      registration: 'Ab-12',
      registrationKey: 'ab-12',
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'TERMO_ASSINADO',
      authorizationDate: new Date('2026-11-10T00:00:00.000Z'),
      authorizationRecordedById: 'admin',
    });
    expect(savedData()?.authorizationRecordedAt).toBeInstanceOf(Date);
    expect(userSummarySchema.parse(wire(user))).toMatchObject({
      registration: 'Ab-12',
      contactAuthorization: {
        status: 'AUTORIZADO',
        source: 'TERMO_ASSINADO',
        date: '2026-11-10',
      },
    });
  });
});

describe('ficha na criação: recusas antes de gravar', () => {
  it.each(doors)(
    'data de autorização futura → 422 sem criar contato nem pessoa (%s)',
    async (_door, create) => {
      await expect(
        create({
          contactAuthorization: {
            status: 'AUTORIZADO',
            source: 'TERMO_ASSINADO',
            date: '2999-01-01',
          },
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'user.authorization_future_date',
      });
      expect(phones.resolveContactId.mock.calls).toEqual([]);
      expect(repo.createWithAudit.mock.calls).toEqual([]);
    },
  );

  it.each(doors)(
    'matrícula repetida na pré-checagem, sem diferenciar maiúsculas → 422 user.registration_taken (%s)',
    async (_door, create) => {
      repo.findIdByRegistrationKey.mockResolvedValue('outra-pessoa');
      await expect(create({ registration: 'AB-12' })).rejects.toMatchObject({
        status: 422,
        code: 'user.registration_taken',
      });
      expect(repo.findIdByRegistrationKey.mock.calls).toEqual([['ab-12']]);
      expect(phones.resolveContactId.mock.calls).toEqual([]);
      expect(repo.createWithAudit.mock.calls).toEqual([]);
    },
  );

  it.each(doors)(
    'corrida: P2002 em registrationKey → 422 user.registration_taken (%s)',
    async (_door, create) => {
      repo.createWithAudit.mockRejectedValue(uniqueOn('registrationKey'));
      await expect(create({ registration: 'AB-12' })).rejects.toMatchObject({
        status: 422,
        code: 'user.registration_taken',
      });
    },
  );
});

describe('ficha na criação: trilha no tx (GC1, GC2)', () => {
  it.each(trailDoors)(
    '%s chama recordChange no tx com %s, PERSON, actorId explícito, sem e-mail ou telefone completos',
    async (_door, create, action, { role, email }) => {
      withTrail(auditRow({ email, role }), created({ email, role }));

      await create();

      expect(audit.recordChange.mock.calls).toHaveLength(1);
      const [tx, change] = audit.recordChange.mock.calls[0];
      expect(tx).toBe(TX);
      expect(change).toMatchObject({
        action,
        entity: 'User',
        entityId: 'p1',
        category: 'PERSON',
        subjectUserId: 'p1',
        reason: null,
        actorId: 'admin',
      });
      expect(change.changes).toContainEqual({
        field: 'phone',
        before: null,
        after: '•••• 4567',
      });
      expect(
        change.changes.find((c) => c.field === 'email')?.after ?? null,
      ).toBe(email && 'm•••@idasam.org');
      const trail = JSON.stringify(audit.recordChange.mock.calls);
      expect(trail).not.toContain('5592991234567');
      expect(trail).not.toContain('maria@idasam.org');
      expect(trail).not.toContain('argon2id-fake');
      expect(audit.log.mock.calls.map(([name]) => name)).not.toContain(action);
    },
  );
});
