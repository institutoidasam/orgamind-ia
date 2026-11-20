import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import argon2 from 'argon2';
import type { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import type { UserPhoneService } from './user-phone.service';
import type { UsersRepository, UserSummary } from './users.repository';
import type { PersonAuditRow } from './person-audit';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { NO_PERSON_RECORD } from './users.test-fixtures';

vi.mock('argon2');

let repo: DeepMockProxy<UsersRepository>;
let audit: DeepMockProxy<AuditService>;
let phones: DeepMockProxy<UserPhoneService>;
let svc: UsersService;

const TX = {} as Prisma.TransactionClient;
const PHONE = '+5592991234567';
const SECTOR = { id: 's1', name: 'Produção', code: 'PRD', isActive: true };
const summary: UserSummary = {
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
};
const auditRow: PersonAuditRow = {
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
};
const input = { name: 'Maria', phone: '92991234567', sectorId: 's1' };
const invite = () =>
  svc.createUser(
    {
      email: 'maria@idasam.org',
      role: 'OPERATOR',
      sectorId: 's1',
      phone: '92991234567',
    },
    'admin',
  );
const savedData = () => repo.createWithAudit.mock.calls[0]?.[0];
const trailReason = () => audit.recordChange.mock.calls[0]?.[1].reason;

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
  // O repositório abre o tx, lê o retrato e chama o callback da trilha.
  repo.createWithAudit.mockImplementation(async (_data, trail) => {
    await trail(TX, auditRow, summary.id);
    return summary;
  });
});

describe('motivo na criação de pessoa sem acesso', () => {
  it('createPersonWithoutAccess grava o motivo na trilha da criação', async () => {
    await svc.createPersonWithoutAccess('admin', input, {
      reason: 'Importação de planilha: pessoas.csv',
    });
    expect(trailReason()).toBe('Importação de planilha: pessoas.csv');
  });

  it('sem motivo continua gravando motivo nulo', async () => {
    await svc.createPersonWithoutAccess('admin', input);
    expect(audit.recordChange.mock.calls).toHaveLength(1);
    expect(trailReason()).toBeNull();
  });

  it('convite continua sem motivo', async () => {
    await invite();
    expect(audit.recordChange.mock.calls).toHaveLength(1);
    expect(trailReason()).toBeNull();
  });
});

describe('id da pessoa criada pela importação', () => {
  it('createPersonWithoutAccess cria com o id dado em meta.personId', async () => {
    await svc.createPersonWithoutAccess('admin', input, {
      reason: null,
      personId: 'cuid-da-linha',
    });
    expect(savedData()).toMatchObject({ id: 'cuid-da-linha' });
  });

  it('sem personId, data não leva a chave id', async () => {
    await svc.createPersonWithoutAccess('admin', input, { reason: 'motivo' });
    expect(savedData()).not.toHaveProperty('id');
  });
});
