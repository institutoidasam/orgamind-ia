import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { InternalSectorsRepository } from './internal-sectors.repository';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: InternalSectorsRepository;
let sectorId: string;
let operatorId: string;
let withoutAccessId: string;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new InternalSectorsRepository(prisma as never);
  sectorId = (
    await prisma.sector.create({ data: { name: 'Acesso', code: 'ACS' } })
  ).id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@test.local', password: 'x', sectorId },
    })
  ).id;
  // GC5: `hasAccess` é o critério. O papel de escrita aqui é de propósito: o
  // VIEWER da D1 é só defesa em profundidade, não pode ser o que a tira.
  withoutAccessId = (
    await prisma.user.create({
      data: {
        name: 'Sem acesso',
        hasAccess: false,
        email: null,
        password: null,
        role: 'OPERATOR',
        sectorId,
      },
    })
  ).id;
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('Setores — pessoa sem acesso (GC5)', () => {
  it('membros elegíveis excluem pessoa sem acesso e mantêm OPERATOR ativo', async () => {
    const eligible = await repo.findMembers(sectorId, true);
    expect(eligible.map((member) => member.id)).toEqual([operatorId]);
  });

  it('membros sem eligible incluem pessoa sem acesso', async () => {
    const everyoneActive = await repo.findMembers(sectorId);
    expect(everyoneActive.map((member) => member.id).sort()).toEqual(
      [operatorId, withoutAccessId].sort(),
    );
  });

  it('findValidManager de pessoa sem acesso → null; com acesso segue válido', async () => {
    await expect(repo.findValidManager(withoutAccessId)).resolves.toBeNull();
    await expect(repo.findValidManager(operatorId)).resolves.toEqual({
      id: operatorId,
    });
  });
});
