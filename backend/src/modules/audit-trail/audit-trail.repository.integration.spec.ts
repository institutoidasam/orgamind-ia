import { randomUUID } from 'node:crypto';
import { type AuditCategory, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { AuditTrailRepository } from './audit-trail.repository';
import { AuditTrailService } from './audit-trail.service';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: AuditTrailRepository;
let service: AuditTrailService;
const ids = { admin: '', supervisor: '', ana: '', ari: '', operation: '' };

// Pessoa sem acesso (CHECK User_access_consistent): e-mail e senha NULL, VIEWER.
const WITHOUT_ACCESS = {
  hasAccess: false,
  email: null,
  password: null,
  role: 'VIEWER',
} as const;

// Instantes de borda do dia civil de Manaus (UTC-4): 01/11 00:00 = 04:00Z.
const AT = {
  before: '2026-11-01T03:59:59.999Z',
  start: '2026-11-01T04:00:00.000Z',
  mid: '2026-11-02T12:00:00.000Z',
  end: '2026-11-04T03:59:59.999Z',
  after: '2026-11-04T04:00:00.000Z',
};

function event(
  subjectUserId: string,
  at: string,
  category: AuditCategory | null,
  action = 'user.updated',
) {
  return prisma.auditEvent.create({
    data: {
      action,
      entity: 'User',
      entityId: subjectUserId,
      subjectUserId,
      category,
      actorId: ids.admin,
      createdAt: new Date(at),
      changes: category
        ? [{ field: 'name', before: 'A', after: 'B' }]
        : undefined,
      metadata: { phoneE164: '+5592988887777' },
      ip: 'ip-do-cliente',
      userAgent: 'vitest',
    },
  });
}

async function seed(): Promise<void> {
  ids.admin = (
    await prisma.user.create({
      data: {
        name: 'Adm',
        email: 'adm@test.local',
        password: 'x',
        role: 'ADMIN',
      },
    })
  ).id;
  ids.supervisor = (
    await prisma.user.create({
      data: {
        name: 'Marta',
        email: 'marta@test.local',
        password: 'x',
        role: 'SUPERVISOR',
      },
    })
  ).id;
  ids.operation = (
    await prisma.sector.create({
      data: { name: 'Operação', code: 'OPE', managerId: ids.supervisor },
    })
  ).id;
  ids.ana = (
    await prisma.user.create({
      data: {
        ...WITHOUT_ACCESS,
        name: 'Ana',
        registration: 'AB-12',
        registrationKey: 'ab-12',
        sectorId: ids.operation,
      },
    })
  ).id;
  ids.ari = (
    await prisma.user.create({ data: { ...WITHOUT_ACCESS, name: 'Ari' } })
  ).id;
  for (const at of Object.values(AT)) await event(ids.ana, at, 'PERSON');
  await event(
    ids.ana,
    '2026-11-02T14:00:00.000Z',
    'STRUCTURE',
    'sector.updated',
  );
  await event(ids.ana, '2026-11-02T13:00:00.000Z', null, 'auth.refresh');
  await event(ids.ari, '2026-11-02T11:00:00.000Z', 'PERSON');
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new AuditTrailRepository(prisma as never);
  service = new AuditTrailService(repo);
  await seed();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const times = (items: readonly { createdAt: string }[]) =>
  items.map((item) => item.createdAt);

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
const link = { bia: '', storage: '', front: '', morning: '', full: '' };

/** Bia na Operação (alcance de Marta), com três linhas gravadas fora de ordem. */
async function seedAssignments(): Promise<void> {
  const sector = (name: string, code: string) =>
    prisma.sector.create({ data: { name, code } });
  link.storage = (await sector('Almoxarifado', 'ALM')).id;
  link.front = (await sector('Recepção', 'REC')).id;
  link.morning = (
    await prisma.shift.create({
      data: {
        name: 'Manhã',
        startTime: '07:00',
        endTime: '13:00',
        sortOrder: 1,
      },
    })
  ).id;
  link.full = (
    await prisma.staffLevel.create({ data: { name: 'Pleno', sortOrder: 1 } })
  ).id;
  link.bia = (
    await prisma.user.create({
      data: { ...WITHOUT_ACCESS, name: 'Bia', sectorId: ids.operation },
    })
  ).id;
  const rows = [
    {
      sectorId: link.storage,
      shiftId: link.morning,
      validFrom: day('2026-02-01'),
      validTo: day('2026-05-31'),
    },
    {
      sectorId: ids.operation,
      shiftId: link.morning,
      levelId: link.full,
      validFrom: day('2026-06-01'),
      validTo: null,
    },
    { sectorId: link.front, validFrom: null, validTo: day('2026-01-31') },
  ];
  for (const row of rows) {
    await prisma.userAssignment.create({ data: { userId: link.bia, ...row } });
  }
}

const refOf = (id: string, name: string) => ({ id, name });

describe('AuditTrailService + repositório — Vínculos da pessoa', () => {
  beforeAll(seedAssignments);

  it('devolve aberta primeiro e depois por fim decrescente, com nomes de setor, turno e nível', async () => {
    const { items } = await service.personAssignments(ids.supervisor, link.bia);

    expect(items).toMatchObject([
      {
        sector: refOf(ids.operation, 'Operação'),
        shift: refOf(link.morning, 'Manhã'),
        level: refOf(link.full, 'Pleno'),
        from: '2026-06-01',
        to: null,
      },
      { from: '2026-02-01', to: '2026-05-31' },
      {
        sector: refOf(link.front, 'Recepção'),
        shift: null,
        level: null,
        from: null,
        to: '2026-01-31',
      },
    ]);
  });

  it('setor inativado depois continua aparecendo pelo nome na linha fechada', async () => {
    await prisma.sector.update({
      where: { id: link.storage },
      data: { isActive: false },
    });

    const { items } = await service.personAssignments(ids.admin, link.bia);

    expect(items[1]).toMatchObject({
      sector: refOf(link.storage, 'Almoxarifado'),
      shift: refOf(link.morning, 'Manhã'),
      level: null,
      to: '2026-05-31',
    });
  });
});

describe('AuditTrailService + repositório — busca q sem coringa de LIKE', () => {
  it('"_" e "%" em q valem como texto; nome e matrícula normais acham', async () => {
    const total = async (q: string) =>
      (await service.list(ids.admin, { q, page: 1, pageSize: 50 })).total;

    // Sem escape, "A_i" casaria Ari, "AB_12" casaria ab-12 e "%" casaria todos.
    for (const q of ['A_i', 'AB_12', '%']) expect(await total(q), q).toBe(0);
    expect(await total('ana')).toBe(6);
    expect(await total('ari')).toBe(1);
    expect(await total('AB-1')).toBe(6);
  });
});

describe('AuditTrailService + repositório — histórico da pessoa', () => {
  it('evento sem categoria fica de fora; ordem createdAt desc, paginação e total', async () => {
    const first = await service.personHistory(ids.admin, ids.ana, {
      page: 1,
      pageSize: 4,
    });
    const second = await service.personHistory(ids.admin, ids.ana, {
      page: 2,
      pageSize: 4,
    });

    // 7 eventos de Ana, 1 sem categoria (auth.refresh): total 6.
    expect(first.total).toBe(6);
    expect(first.items.map((item) => item.action)).toEqual([
      'user.updated',
      'user.updated',
      'sector.updated',
      'user.updated',
    ]);
    expect(times(first.items)).toEqual([
      AT.after,
      AT.end,
      '2026-11-02T14:00:00.000Z',
      AT.mid,
    ]);
    expect(times(second.items)).toEqual([AT.start, AT.before]);
    expect(JSON.stringify([first, second])).not.toMatch(
      /auth\.refresh|5592988887777|ip-do-cliente|vitest|metadata/,
    );
  });

  it('SUPERVISOR do setor vê só as categorias da ficha; ADMIN vê Estrutura também', async () => {
    const supervisor = await service.personHistory(ids.supervisor, ids.ana, {
      page: 1,
      pageSize: 20,
    });

    expect(supervisor.total).toBe(5);
    expect(supervisor.items.map((item) => item.category)).not.toContain(
      'STRUCTURE',
    );
    await expect(
      service.personHistory(ids.supervisor, ids.ari, { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'audit_trail.forbidden' });
  });
});

describe('AuditTrailService + repositório — consulta geral', () => {
  it('período em Manaus inclusivo nos dois extremos e q por nome', async () => {
    const result = await service.list(ids.admin, {
      q: 'ana',
      from: '2026-11-01',
      to: '2026-11-03',
      page: 1,
      pageSize: 50,
    });

    expect(times(result.items)).toEqual([
      AT.end,
      '2026-11-02T14:00:00.000Z',
      AT.mid,
      AT.start,
    ]);
    expect(result.items[0]?.subject).toEqual({
      id: ids.ana,
      name: 'Ana',
      registration: 'AB-12',
    });
    expect(result.items[0]?.actor).toEqual({ id: ids.admin, name: 'Adm' });
  });

  it('q por matrícula (sem caixa) e filtro de categoria; sem q traz todas as pessoas', async () => {
    const byRegistration = await service.list(ids.admin, {
      q: 'AB-1',
      category: 'STRUCTURE',
      page: 1,
      pageSize: 50,
    });
    const all = await service.list(ids.admin, { page: 1, pageSize: 50 });

    expect(byRegistration.items.map((item) => item.action)).toEqual([
      'sector.updated',
    ]);
    // Categorizados: Ana 6 + Ari 1; o auth.refresh de Ana não entra.
    expect(all.total).toBe(7);
  });

  it('findPeopleByIds devolve nome e matrícula; sem ids não consulta', async () => {
    await expect(repo.findPeopleByIds([ids.ana])).resolves.toEqual([
      { id: ids.ana, name: 'Ana', registration: 'AB-12' },
    ]);
    await expect(repo.findPeopleByIds([])).resolves.toEqual([]);
  });
});
