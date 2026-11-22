import type { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuditTrailPage } from '../../schemas/contracts/audit-trail.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  actorWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import type {
  AuditTrailRepository,
  AuditTrailRow,
} from './audit-trail.repository';
import { AuditTrailService } from './audit-trail.service';

const SECTOR = 'sector_operation';

function actor(
  role: Role,
  managedSectorIds: string[] = [],
  change: PermissionChange = {},
): TeamActor {
  return {
    ...actorWith(role, { ...change, id: `user_${role.toLowerCase()}` }),
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
    findAssignments: vi.fn().mockResolvedValue([]),
  };
  const service = new AuditTrailService(
    repo as unknown as AuditTrailRepository,
  );
  return { repo, service };
}

const PAGE = { page: 1, pageSize: 20 };
const FORBIDDEN = { status: 403, code: 'audit_trail.forbidden' };

const PHONE_SUBJECT = '+5592988887777';
const PHONE_ACTOR = '+5592977776666';

/** Pessoa e autor cujo nome é o telefone (D11), mais uma pessoa de nome normal. */
function withPhoneNames(repo: ReturnType<typeof setup>['repo']): void {
  const rename = [{ field: 'name', before: PHONE_SUBJECT, after: 'Ana Souza' }];
  const created = [{ field: 'name', before: null, after: PHONE_SUBJECT }];
  const phone = { subjectUserId: 'user_phone', actorId: 'user_boss' };
  repo.findPage.mockResolvedValue({
    rows: [
      row({ id: 'evt_1', ...phone, changes: rename }),
      row({ id: 'evt_2', ...phone, changes: created }),
      row({ id: 'evt_3' }),
    ],
    total: 3,
  });
  repo.findPeopleByIds.mockResolvedValue([
    { id: ADMIN.id, name: 'Admin', registration: null },
    { id: 'user_ana', name: 'Ana', registration: 'A-1' },
    { id: 'user_phone', name: PHONE_SUBJECT, registration: null },
    { id: 'user_boss', name: PHONE_ACTOR, registration: null },
  ]);
}

const nameParts = (page: AuditTrailPage) =>
  page.items.map((item) => [
    item.subject?.name,
    item.actor?.name,
    item.changes?.[0]?.before,
    item.changes?.[0]?.after,
  ]);

const NOT_FOUND = { status: 404, code: 'audit_trail.person_not_found' };
const ref = (id: string, name: string) => ({ id, name });

/** Como o repositório lê (datas `@db.Date` à meia-noite UTC), com um campo fora do contrato. */
const ASSIGNMENT_ROWS = [
  {
    id: 'asg_open',
    validFrom: new Date('2026-06-01T00:00:00.000Z'),
    validTo: null,
    sector: ref(SECTOR, 'Operação'),
    shift: ref('shift_day', 'Diurno'),
    level: null,
    recordedById: ADMIN.id,
  },
  {
    id: 'asg_old',
    validFrom: null,
    validTo: new Date('2026-05-31T00:00:00.000Z'),
    sector: null,
    shift: null,
    level: ref('level_full', 'Pleno'),
    recordedById: null,
  },
];

const ASSIGNMENTS = [
  {
    id: 'asg_open',
    sector: ref(SECTOR, 'Operação'),
    shift: ref('shift_day', 'Diurno'),
    level: null,
    from: '2026-06-01',
    to: null,
  },
  {
    id: 'asg_old',
    sector: null,
    shift: null,
    level: ref('level_full', 'Pleno'),
    from: null,
    to: '2026-05-31',
  },
];

describe('AuditTrailService.personAssignments — alcance (DV13)', () => {
  it('SUPERVISOR vê os vínculos de quem alcança e recebe 403 fora do alcance', async () => {
    const inReach = setup({ actor: SUPERVISOR });
    inReach.repo.findAssignments.mockResolvedValue(ASSIGNMENT_ROWS);

    await expect(
      inReach.service.personAssignments(SUPERVISOR.id, 'user_ana'),
    ).resolves.toEqual({ items: ASSIGNMENTS });
    expect(inReach.repo.findAssignments).toHaveBeenCalledWith('user_ana');

    for (const sectorId of ['sector_it', null]) {
      const outside = setup({ actor: SUPERVISOR, sectorId });
      await expect(
        outside.service.personAssignments(SUPERVISOR.id, 'user_ana'),
        String(sectorId),
      ).rejects.toMatchObject(FORBIDDEN);
      expect(outside.repo.findAssignments).not.toHaveBeenCalled();
    }
  });

  it('pessoa inexistente: 404 para quem vê qualquer pessoa, 403 para os demais', async () => {
    const cases = [
      [ADMIN, NOT_FOUND],
      [SUPERVISOR, FORBIDDEN],
    ] as const;
    for (const [who, error] of cases) {
      const { repo, service } = setup({ actor: who });
      repo.findPerson.mockResolvedValue(null);

      await expect(
        service.personAssignments(who.id, 'user_x'),
        who.role,
      ).rejects.toMatchObject(error);
      expect(repo.findAssignments).not.toHaveBeenCalled();
    }
  });
});

/** `ok` ou `status code` do erro, para comparar as duas rotas da ficha. */
const outcome = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'ok',
    (error: { status: number; code: string }) =>
      `${error.status} ${error.code}`,
  );

const DENIED = '403 audit_trail.forbidden';
const MISSING = '404 audit_trail.person_not_found';
type AccessCase = [string, TeamActor | null, string | null, boolean, string];
const SAME_ACCESS: AccessCase[] = [
  ['ADMIN, pessoa sem setor', ADMIN, null, true, 'ok'],
  ['SUPERVISOR no alcance', SUPERVISOR, SECTOR, true, 'ok'],
  ['SUPERVISOR fora do alcance', SUPERVISOR, 'sector_it', true, DENIED],
  ['SUPERVISOR, pessoa sem setor', SUPERVISOR, null, true, DENIED],
  ['SUPERVISOR, inexistente', SUPERVISOR, SECTOR, false, DENIED],
  ['ADMIN, inexistente', ADMIN, SECTOR, false, MISSING],
  ['VIEWER', actor('VIEWER'), SECTOR, true, DENIED],
  ['OPERATOR gestor', actor('OPERATOR', [SECTOR]), SECTOR, true, DENIED],
  ['ator inexistente', null, SECTOR, true, DENIED],
];

describe('AuditTrailService — Histórico e Vínculos com a mesma regra de acesso', () => {
  it('personHistory continua com as mesmas respostas', async () => {
    for (const [label, who, sectorId, exists, expected] of SAME_ACCESS) {
      const { repo, service } = setup({ actor: who, sectorId });
      if (!exists) repo.findPerson.mockResolvedValue(null);

      const history = await outcome(
        service.personHistory('user_x', 'user_ana', PAGE),
      );
      const assignments = await outcome(
        service.personAssignments('user_x', 'user_ana'),
      );

      expect([history, assignments], label).toEqual([expected, expected]);
    }
  });
});

describe('AuditTrailService.personHistory — nome que é telefone (D11)', () => {
  it('sem telefone.ver_completo: pessoa, autor e valores do campo name saem mascarados; nome normal intacto', async () => {
    const who = actor('OPERATOR', [SECTOR], {
      grant: ['trilha.consultar'],
      revoke: ['telefone.ver_completo'],
    });
    const { repo, service } = setup({ actor: who });
    withPhoneNames(repo);

    const page = await service.personHistory(who.id, 'user_phone', PAGE);

    expect(nameParts(page)).toEqual([
      ['•••• 7777', '•••• 6666', '•••• 7777', 'Ana Souza'],
      ['•••• 7777', '•••• 6666', null, '•••• 7777'],
      ['Ana', 'Admin', 'Ana', 'Ana Souza'],
    ]);
    expect(JSON.stringify(page)).not.toMatch(/988887777|977776666/);
  });
});

describe('AuditTrailService — nome que é telefone com a matriz inicial', () => {
  const recorded = [
    [PHONE_SUBJECT, PHONE_ACTOR, PHONE_SUBJECT, 'Ana Souza'],
    [PHONE_SUBJECT, PHONE_ACTOR, null, PHONE_SUBJECT],
    ['Ana', 'Admin', 'Ana', 'Ana Souza'],
  ];

  it('ADMIN na consulta geral recebe como gravado', async () => {
    const { repo, service } = setup();
    withPhoneNames(repo);

    const page = await service.list(ADMIN.id, PAGE);

    expect(nameParts(page)).toEqual(recorded);
  });

  it.each([
    ['SUPERVISOR do setor', SUPERVISOR],
    [
      'OPERATOR com trilha.consultar',
      actor('OPERATOR', [SECTOR], { grant: ['trilha.consultar'] }),
    ],
  ])('%s no histórico da pessoa recebe como gravado', async (_l, who) => {
    const { repo, service } = setup({ actor: who });
    withPhoneNames(repo);

    const page = await service.personHistory(who.id, 'user_phone', PAGE);

    expect(nameParts(page)).toEqual(recorded);
  });
});

describe('AuditTrailService.personHistory — por permissão', () => {
  it('OPERATOR com trilha.consultar no alcance recebe só PERSON, ASSIGNMENT e SCHEDULE', async () => {
    const operator = actor('OPERATOR', [SECTOR], {
      grant: ['trilha.consultar'],
    });
    const { repo, service } = setup({ actor: operator });

    await service.personHistory(operator.id, 'user_ana', PAGE);

    expect(repo.findPage).toHaveBeenCalledWith(
      {
        subjectUserId: 'user_ana',
        category: { in: ['PERSON', 'ASSIGNMENT', 'SCHEDULE'] },
      },
      1,
      20,
    );
  });

  it.each([
    [
      'OPERATOR com a chave, pessoa fora do alcance',
      actor('OPERATOR', [SECTOR], { grant: ['trilha.consultar'] }),
      'sector_it',
    ],
    [
      'SUPERVISOR sem a chave, pessoa no alcance',
      actor('SUPERVISOR', [SECTOR], { revoke: ['trilha.consultar'] }),
      SECTOR,
    ],
  ])('%s → 403 audit_trail.forbidden', async (_, who, sectorId) => {
    const { repo, service } = setup({ actor: who, sectorId });

    await expect(
      service.personHistory(who.id, 'user_ana', PAGE),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(repo.findPage).not.toHaveBeenCalled();
  });
});

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
