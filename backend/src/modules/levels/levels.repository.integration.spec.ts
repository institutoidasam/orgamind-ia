import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { LevelsRepository } from './levels.repository';

// Última migração antes dos níveis: as duas pessoas abaixo já existem em produção.
const BEFORE_STAFF_LEVEL = '20261021130000_team_dispatch_schedule';

// C1: os quatro níveis migrados, com ids fixos.
const MIGRATED_LEVELS = [
  ['level_coordinator', 'Coordenador', 1],
  ['level_leader', 'Líder', 2],
  ['level_employee', 'Funcionário', 3],
  ['level_operator', 'Operador', 4],
].map(([id, name, sortOrder]) => ({ id, name, sortOrder, isActive: true }));

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: LevelsRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_STAFF_LEVEL });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "password", "updatedAt") VALUES
      ('u-1', 'u1@test.local', 'x', now()),
      ('u-2', 'u2@test.local', 'x', now())`,
  );
  deployMigrations({ databaseUrl });
  repo = new LevelsRepository(prisma as never);
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('migração 20261022090000_staff_level', () => {
  it('cria Coordenador, Líder, Funcionário e Operador, ativos, ordem 1 a 4', async () => {
    const levels = await prisma.$queryRaw`
      SELECT "id", "name", "sortOrder", "isActive"
      FROM "StaffLevel" ORDER BY "sortOrder"`;
    expect(levels).toEqual(MIGRATED_LEVELS);
  });

  it('usuários existentes ficam sem nível', async () => {
    const users = await prisma.$queryRaw`
      SELECT "id", "levelId" FROM "User" ORDER BY "id"`;
    expect(users).toEqual([
      { id: 'u-1', levelId: null },
      { id: 'u-2', levelId: null },
    ]);
  });
});

describe('levels.repository — leitura (Postgres exclusivo)', () => {
  it('userCount conta quem tem o nível; nível com usuário não se apaga (Restrict)', async () => {
    await prisma.user.update({
      where: { id: 'u-1' },
      data: { levelId: 'level_leader' },
    });

    const items = await repo.list();

    expect(items.map((l) => [l.id, l.userCount])).toEqual([
      ['level_coordinator', 0],
      ['level_leader', 1],
      ['level_employee', 0],
      ['level_operator', 0],
    ]);
    await expect(
      prisma.staffLevel.delete({ where: { id: 'level_leader' } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('listActive devolve só os ativos por sortOrder; findById diz se está ativo', async () => {
    await repo.update('level_leader', { isActive: false });

    expect(await repo.listActive()).toEqual([
      { id: 'level_coordinator', name: 'Coordenador' },
      { id: 'level_employee', name: 'Funcionário' },
      { id: 'level_operator', name: 'Operador' },
    ]);
    expect(await repo.findById('level_leader')).toEqual({
      id: 'level_leader',
      isActive: false,
    });
    expect(await repo.findById('level_missing')).toBeNull();
  });
});

describe('levels.repository — gravação e ordem (Postgres exclusivo)', () => {
  it('grava após o maior sortOrder, acha nome sem caixa fora do próprio id e reordena 1..n', async () => {
    expect(await repo.maxSortOrder()).toBe(4);
    const created = await repo.create({ name: 'Gerente_%', sortOrder: 5 });

    expect(created).toMatchObject({ isActive: true, userCount: 0 });
    expect(await repo.findByNameInsensitive(' GERENTE_% ')).toMatchObject({
      id: created.id,
    });
    // Sem curinga: '_' e '%' do nome são literais.
    expect(await repo.findByNameInsensitive('Gerentex%')).toBeNull();
    expect(
      await repo.findByNameInsensitive('gerente_%', created.id),
    ).toBeNull();

    await repo.setOrder([
      created.id,
      'level_operator',
      'level_employee',
      'level_leader',
      'level_coordinator',
    ]);

    const rows = await repo.list();
    expect(rows.map((r) => [r.id, r.sortOrder])).toEqual([
      [created.id, 1],
      ['level_operator', 2],
      ['level_employee', 3],
      ['level_leader', 4],
      ['level_coordinator', 5],
    ]);
  });
});
