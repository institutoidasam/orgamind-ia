import type { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type {
  AuditTrailRepository,
  AuditTrailRow,
} from './audit-trail.repository';
import { AuditTrailService } from './audit-trail.service';

const SECTOR = 'sector_operation';

function actor(role: Role, managedSectorIds: string[] = []): TeamActor {
  return {
    id: `user_${role.toLowerCase()}`,
    role,
    isActive: true,
    hasAccess: true,
    managedSectorIds,
  };
}
const ADMIN = actor('ADMIN');
const SUPERVISOR = actor('SUPERVISOR', [SECTOR]);

function row(over: Partial<AuditTrailRow> = {}): AuditTrailRow {
  return {
    id: 'evt_1',
    createdAt: new Date('2026-11-10T15:30:00.000Z'),
    action: 'user.updated',
    category: 'PERSON',
    actorId: ADMIN.id,
    subjectUserId: 'user_ana',
    reason: 'Correção de cadastro',
    changes: [{ field: 'name', before: 'Ana', after: 'Ana Souza' }],
    ...over,
  };
}

function setup(
  over: { actor?: TeamActor | null; sectorId?: string | null } = {},
) {
  const repo = {
    findActor: vi.fn().mockResolvedValue('actor' in over ? over.actor : ADMIN),
    findPerson: vi.fn().mockResolvedValue({
      id: 'user_ana',
      sectorId: 'sectorId' in over ? over.sectorId : SECTOR,
    }),
    findPage: vi.fn().mockResolvedValue({ rows: [row()], total: 1 }),
    findPeopleByIds: vi.fn().mockResolvedValue([
      { id: ADMIN.id, name: 'Admin', registration: null },
      { id: 'user_ana', name: 'Ana', registration: 'A-1' },
    ]),
    findSubjectIdsByQuery: vi.fn().mockResolvedValue([]),
  };
  const service = new AuditTrailService(
    repo as unknown as AuditTrailRepository,
  );
  return { repo, service };
}

const PAGE = { page: 1, pageSize: 20 };
const FORBIDDEN = { status: 403, code: 'audit_trail.forbidden' };

describe('AuditTrailService.list — filtros', () => {
  it('monta where com categoria, período em Manaus (fim exclusivo no dia seguinte) e q → subjectUserId in', async () => {
    const { repo, service } = setup();
    repo.findSubjectIdsByQuery.mockResolvedValue(['user_ana', 'user_ari']);

    await service.list(ADMIN.id, {
      q: 'an',
      from: '2026-11-01',
      to: '2026-11-03',
      category: 'PERSON',
      page: 2,
      pageSize: 20,
    });

    expect(repo.findSubjectIdsByQuery).toHaveBeenCalledWith('an', 500);
    expect(repo.findPage).toHaveBeenCalledWith(
      {
        category: 'PERSON',
        createdAt: {
          gte: new Date('2026-11-01T04:00:00.000Z'),
          lt: new Date('2026-11-04T04:00:00.000Z'),
        },
        subjectUserId: { in: ['user_ana', 'user_ari'] },
      },
      2,
      20,
    );
  });

  it('sem filtros lista só eventos categorizados (D8)', async () => {
    const { repo, service } = setup();

    await service.list(ADMIN.id, PAGE);

    expect(repo.findPage).toHaveBeenCalledWith(
      { category: { not: null } },
      1,
      20,
    );
    expect(repo.findSubjectIdsByQuery).not.toHaveBeenCalled();
  });
});

describe('AuditTrailService.list — negações', () => {
  it.each([
    ['SUPERVISOR', SUPERVISOR],
    ['OPERATOR', actor('OPERATOR', [SECTOR])],
    ['VIEWER', actor('VIEWER')],
    ['ator inexistente', null],
  ])('%s → 403 audit_trail.forbidden sem consultar', async (_, who) => {
    const { repo, service } = setup({ actor: who });

    await expect(service.list('user_x', PAGE)).rejects.toMatchObject(FORBIDDEN);
    expect(repo.findPage).not.toHaveBeenCalled();
  });
});

describe('AuditTrailService.personHistory — alcance', () => {
  it('ADMIN: where { subjectUserId, category: { not: null } }; pessoa sem setor também', async () => {
    const { repo, service } = setup({ sectorId: null });

    await service.personHistory(ADMIN.id, 'user_ana', PAGE);

    expect(repo.findPage).toHaveBeenCalledWith(
      { subjectUserId: 'user_ana', category: { not: null } },
      1,
      20,
    );
  });

  it('SUPERVISOR no alcance filtra categorias PERSON, ASSIGNMENT, SCHEDULE', async () => {
    const { repo, service } = setup({ actor: SUPERVISOR });

    await service.personHistory(SUPERVISOR.id, 'user_ana', PAGE);

    expect(repo.findPage).toHaveBeenCalledWith(
      {
        subjectUserId: 'user_ana',
        category: { in: ['PERSON', 'ASSIGNMENT', 'SCHEDULE'] },
      },
      1,
      20,
    );
  });

  it('ADMIN com pessoa inexistente → 404', async () => {
    const { repo, service } = setup();
    repo.findPerson.mockResolvedValue(null);

    await expect(
      service.personHistory(ADMIN.id, 'user_x', PAGE),
    ).rejects.toMatchObject({
      status: 404,
      code: 'audit_trail.person_not_found',
    });
  });
});

describe('AuditTrailService.personHistory — negações', () => {
  it.each([
    ['fora do alcance', 'sector_it', true],
    ['sem setor', null, true],
    ['inexistente', SECTOR, false],
  ])(
    'SUPERVISOR com pessoa %s → 403 audit_trail.forbidden',
    async (_, sectorId, exists) => {
      const { repo, service } = setup({ actor: SUPERVISOR, sectorId });
      if (!exists) repo.findPerson.mockResolvedValue(null);

      await expect(
        service.personHistory(SUPERVISOR.id, 'user_ana', PAGE),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(repo.findPage).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['OPERATOR gestor do setor', actor('OPERATOR', [SECTOR])],
    ['VIEWER', actor('VIEWER')],
    ['ator inexistente', null],
  ])(
    '%s → 403 audit_trail.forbidden mesmo com a pessoa ao alcance',
    async (_, who) => {
      const { repo, service } = setup({ actor: who });

      await expect(
        service.personHistory('user_x', 'user_ana', PAGE),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(repo.findPage).not.toHaveBeenCalled();
    },
  );
});

describe('AuditTrailService — resposta', () => {
  it('entrada sem changes sai com changes null; actor e subject resolvidos por id; só os campos do contrato', async () => {
    const { repo, service } = setup();
    const legacy = {
      ...row({ id: 'evt_old', changes: null, reason: null, actorId: null }),
      metadata: { phoneE164: '+5592988887777' },
      ip: 'ip-do-cliente',
      userAgent: 'curl',
    };
    repo.findPage.mockResolvedValue({ rows: [row(), legacy], total: 41 });

    const result = await service.list(ADMIN.id, { page: 3, pageSize: 20 });

    expect(repo.findPeopleByIds).toHaveBeenCalledWith(
      expect.arrayContaining([ADMIN.id, 'user_ana']),
    );
    expect(result).toEqual({
      total: 41,
      page: 3,
      pageSize: 20,
      items: [
        {
          id: 'evt_1',
          createdAt: '2026-11-10T15:30:00.000Z',
          action: 'user.updated',
          category: 'PERSON',
          actor: { id: ADMIN.id, name: 'Admin' },
          subject: { id: 'user_ana', name: 'Ana', registration: 'A-1' },
          reason: 'Correção de cadastro',
          changes: [{ field: 'name', before: 'Ana', after: 'Ana Souza' }],
        },
        {
          id: 'evt_old',
          createdAt: '2026-11-10T15:30:00.000Z',
          action: 'user.updated',
          category: 'PERSON',
          actor: null,
          subject: { id: 'user_ana', name: 'Ana', registration: 'A-1' },
          reason: null,
          changes: null,
        },
      ],
    });
  });
});

describe('AuditTrailService — pessoa apagada', () => {
  it('pessoa apagada: actor e subject mantêm o id, com nome nulo; changes fora do formato → null', async () => {
    const { repo, service } = setup();
    repo.findPeopleByIds.mockResolvedValue([]);
    repo.findPage.mockResolvedValue({
      rows: [row({ changes: { cru: true } })],
      total: 1,
    });

    const { items } = await service.list(ADMIN.id, PAGE);

    expect(items[0]).toMatchObject({
      actor: { id: ADMIN.id, name: null },
      subject: { id: 'user_ana', name: null, registration: null },
      changes: null,
    });
  });
});
