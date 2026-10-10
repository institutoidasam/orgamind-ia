import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InternalNumbersService } from '../internal-numbers/internal-numbers.service';
import { InternalSectorsRepository } from './internal-sectors.repository';
import { InternalSectorsService } from './internal-sectors.service';

describe('Setores BDD (Postgres exclusivo)', () => {
  let postgres: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let sectors: InternalSectorsService;

  beforeAll(async () => {
    const credential = randomUUID().replaceAll('-', '');
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('database_test')
      .withUsername(`user_${credential}`)
      .withPassword(randomUUID())
      .start();
    const url = postgres.getConnectionUri();
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        stdio: 'inherit',
        timeout: 60_000,
        env: { ...process.env, DATABASE_URL: url },
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url } } });
    sectors = new InternalSectorsService(
      new InternalSectorsRepository(prisma as never),
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it('ADMIN cria, edita e consulta setor com gestor, membros e números', async () => {
    const manager = await prisma.user.create({
      data: {
        name: 'Gestora ativa',
        email: 'gestora@test.local',
        password: randomUUID(),
        role: 'SUPERVISOR',
      },
    });
    const created = await sectors.create({
      name: 'Compras',
      code: 'COM',
      description: 'Suprimentos',
      managerId: manager.id,
      isActive: true,
    });
    await Promise.all([
      prisma.user.create({
        data: {
          name: 'Operador elegível',
          email: 'operador@test.local',
          password: randomUUID(),
          role: 'OPERATOR',
          sectorId: created.id,
        },
      }),
      prisma.user.create({
        data: {
          name: 'Leitor',
          email: 'leitor@test.local',
          password: randomUUID(),
          role: 'VIEWER',
          sectorId: created.id,
        },
      }),
      prisma.user.create({
        data: {
          name: 'Inativo',
          email: 'inativo@test.local',
          password: randomUUID(),
          role: 'SUPERVISOR',
          sectorId: created.id,
          isActive: false,
        },
      }),
      prisma.sectorNumber.create({
        data: {
          name: 'Recepção Compras',
          phone: '+5592999990001',
          provider: 'META',
          sectorId: created.id,
          routeToSector: true,
        },
      }),
    ]);

    const updated = await sectors.update(created.id, {
      name: 'Compras estratégicas',
      description: 'Suprimentos e contratos',
    });
    const detail = await sectors.get(created.id);

    expect(updated).toMatchObject({
      name: 'Compras estratégicas',
      manager: { id: manager.id, email: manager.email },
      memberCount: 3,
      numberCount: 1,
    });
    expect(detail).toMatchObject({
      id: created.id,
      description: 'Suprimentos e contratos',
      manager: { id: manager.id },
      numbers: [{ phone: '+5592999990001', routeToSector: true }],
    });
    expect(detail.members).toHaveLength(3);
  });

  it('rejeita nome e sigla duplicados, inclusive nome normalizado', async () => {
    await expect(
      sectors.create({ name: 'compras estratégicas', code: 'OUT' }),
    ).rejects.toMatchObject({ status: 409, code: 'sector.conflict' });
    await expect(
      sectors.create({ name: 'Outros', code: 'COM' }),
    ).rejects.toMatchObject({ status: 409, code: 'sector.conflict' });
  });

  it('lista ativos somente quando activeOnly é verdadeiro e mantém inativos no histórico administrativo', async () => {
    const inactive = await sectors.create({
      name: 'Arquivo',
      code: 'ARQ',
      isActive: false,
    });

    const activeOnly = await sectors.list(1, 100, true);
    const all = await sectors.list(1, 100, false);

    expect(activeOnly.items.map((item) => item.id)).not.toContain(inactive.id);
    expect(all.items.map((item) => item.id)).toContain(inactive.id);
  });

  it('retorna apenas membros ativos que podem ser responsáveis quando eligible=true', async () => {
    const sector = await prisma.sector.findUniqueOrThrow({
      where: { code: 'COM' },
    });

    const eligible = await sectors.members(sector.id, true);
    const everyoneActive = await sectors.members(sector.id, false);

    expect(eligible.items).toHaveLength(1);
    expect(eligible.items[0]).toMatchObject({
      role: 'OPERATOR',
      isActive: true,
    });
    expect(everyoneActive.items.map((member) => member.role).sort()).toEqual([
      'OPERATOR',
      'VIEWER',
    ]);
  });

  it('retorna 404 para setor ausente e 409 para gestor ausente, inativo ou VIEWER', async () => {
    const inactive = await prisma.user.findUniqueOrThrow({
      where: { email: 'inativo@test.local' },
    });
    const viewer = await prisma.user.findUniqueOrThrow({
      where: { email: 'leitor@test.local' },
    });

    await expect(sectors.get('setor-inexistente')).rejects.toMatchObject({
      status: 404,
      code: 'sector.not_found',
    });
    await expect(
      sectors.create({
        name: 'Gestor ausente',
        code: 'GAS',
        managerId: 'ausente',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'sector.manager_invalid' });
    await expect(
      sectors.create({
        name: 'Gestor inativo',
        code: 'GIN',
        managerId: inactive.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'sector.manager_invalid' });
    await expect(
      sectors.create({
        name: 'Gestor leitor',
        code: 'GLE',
        managerId: viewer.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'sector.manager_invalid' });
  });

  it('mantém uma linha e devolve conflito 409 em creates concorrentes do mesmo E.164', async () => {
    const sector = await prisma.sector.findUniqueOrThrow({
      where: { code: 'COM' },
    });
    const numbers = new InternalNumbersService(prisma as never);
    const phone = '+5592999990002';
    const outcomes = await Promise.allSettled([
      numbers.create({
        name: 'Linha concorrente A',
        phone,
        provider: 'OTHER',
        sectorId: sector.id,
        routeToSector: false,
      }),
      numbers.create({
        name: 'Linha concorrente B',
        phone,
        provider: 'OTHER',
        sectorId: sector.id,
        routeToSector: false,
      }),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejection).toMatchObject({
      reason: { status: 409, code: 'internal_number.phone_taken' },
    });
    await expect(prisma.sectorNumber.count({ where: { phone } })).resolves.toBe(
      1,
    );
  });
});
