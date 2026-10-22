import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { SectorPeopleRepository } from './sector-people.repository';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: SectorPeopleRepository;
const ids = {
  operation: '',
  it: '',
  shift: '',
  bruno: '',
  tiago: '',
  nina: '',
};

// Pessoa sem acesso (D1/CHECK User_access_consistent): e-mail e senha NULL, VIEWER.
const WITHOUT_ACCESS = {
  hasAccess: false,
  email: null,
  password: null,
  role: 'VIEWER',
} as const;

async function user(data: Prisma.UserUncheckedCreateInput): Promise<string> {
  return (await prisma.user.create({ data, select: { id: true } })).id;
}

async function seedPeople(): Promise<void> {
  ids.bruno = await user({
    name: 'Bruno',
    email: 'bruno@test.local',
    password: 'x',
    role: 'OPERATOR',
    sectorId: ids.operation,
    levelId: 'level_leader',
    jobTitle: 'Líder de turno',
    shiftId: ids.shift,
    phoneE164: '+5592999990003',
  });
  await user({ ...WITHOUT_ACCESS, name: 'Ana', sectorId: ids.operation });
  await user({ ...WITHOUT_ACCESS, name: 'Ágata', sectorId: ids.operation });
  await user({
    ...WITHOUT_ACCESS,
    name: 'Abel',
    sectorId: ids.operation,
    isActive: false,
  });
  ids.tiago = await user({
    name: 'Tiago',
    email: 'tiago@test.local',
    password: 'x',
    role: 'OPERATOR',
    sectorId: ids.it,
    phoneE164: '+5592977770004',
  });
  ids.nina = await user({ ...WITHOUT_ACCESS, name: 'Nina' });
  await user({ ...WITHOUT_ACCESS, name: 'Ivo', isActive: false });
  await user({
    name: 'Adm',
    email: 'adm@test.local',
    password: 'x',
    role: 'ADMIN',
  });
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
  repo = new SectorPeopleRepository(prisma as never);
  ids.operation = (
    await prisma.sector.create({ data: { name: 'Operação', code: 'OPE' } })
  ).id;
  ids.it = (
    await prisma.sector.create({ data: { name: 'TI', code: 'TI' } })
  ).id;
  ids.shift = (
    await prisma.shift.create({
      data: {
        name: 'Plantão',
        startTime: '07:00',
        endTime: '19:00',
        sortOrder: 99,
      },
    })
  ).id;
  await seedPeople();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

function names(items: readonly { name: string | null }[]): (string | null)[] {
  return items.map((item) => item.name);
}

describe('SectorPeopleRepository — pessoas do setor', () => {
  it('lista ativos do setor por nome com nível, função, turno e hasAccess', async () => {
    const rows = await repo.listPeople(ids.operation);

    // Ordem pt-BR (Ágata antes de Ana), sem a pessoa inativa nem a de TI.
    expect(names(rows)).toEqual(['Ágata', 'Ana', 'Bruno']);
    expect(rows[2]).toMatchObject({
      id: ids.bruno,
      hasAccess: true,
      role: 'OPERATOR',
      jobTitle: 'Líder de turno',
      phoneE164: '+5592999990003',
      level: { id: 'level_leader', name: 'Líder', isActive: true },
      workShift: { id: ids.shift, name: 'Plantão' },
    });
    expect(rows[1]).toMatchObject({
      hasAccess: false,
      level: null,
      workShift: null,
    });
  });

  it('findPerson traz setor, acesso e situação; inexistente → null', async () => {
    await expect(repo.findPerson(ids.tiago)).resolves.toEqual({
      id: ids.tiago,
      name: 'Tiago',
      sectorId: ids.it,
      hasAccess: true,
      isActive: true,
    });
    await expect(repo.findPerson('user_ghost')).resolves.toBeNull();
  });
});

describe('SectorPeopleRepository — o que a P1 lê', () => {
  it('findActor traz papel, situação e acesso; findSector traz gestor e situação', async () => {
    await prisma.sector.update({
      where: { id: ids.it },
      data: { managerId: ids.tiago },
    });

    await expect(repo.findActor(ids.tiago)).resolves.toEqual({
      id: ids.tiago,
      role: 'OPERATOR',
      isActive: true,
      hasAccess: true,
    });
    await expect(repo.findSector(ids.it)).resolves.toEqual({
      id: ids.it,
      name: 'TI',
      code: 'TI',
      isActive: true,
      managerId: ids.tiago,
      manager: { id: ids.tiago, name: 'Tiago' },
    });
    await expect(repo.findSector('sector_ghost')).resolves.toBeNull();
  });
});

describe('SectorPeopleRepository — candidatos', () => {
  it('candidatos do gestor: só sem setor e sem acesso', async () => {
    const items = await repo.listCandidates({
      sectorId: ids.operation,
      q: '',
      onlyUnassignedWithoutAccess: true,
    });

    expect(items).toEqual([
      { id: ids.nina, name: 'Nina', hasAccess: false, sector: null },
    ]);
  });

  it('candidatos do ADMIN excluem quem já está no setor e buscam por nome ou telefone', async () => {
    const args = {
      sectorId: ids.operation,
      onlyUnassignedWithoutAccess: false,
    };

    const all = await repo.listCandidates({ ...args, q: '' });
    const byName = await repo.listCandidates({ ...args, q: 'tia' });
    const byPhone = await repo.listCandidates({ ...args, q: '77770004' });

    expect(names(all)).toEqual(['Adm', 'Nina', 'Tiago']);
    expect(byName).toEqual([
      {
        id: ids.tiago,
        name: 'Tiago',
        hasAccess: true,
        sector: { id: ids.it, name: 'TI' },
      },
    ]);
    expect(byPhone).toEqual(byName);
  });
});

describe('SectorPeopleRepository — contatos', () => {
  it('contact-candidates marca person { name, sectorName } no contato ligado a uma pessoa e busca por número', async () => {
    const linked = await prisma.contact.create({
      data: { phoneE164: '+5592999990003', name: 'Bruno (contato)' },
    });
    await prisma.user.update({
      where: { id: ids.bruno },
      data: { contactId: linked.id },
    });
    const loose = await prisma.contact.create({
      data: { phoneE164: '+5592988880001', name: 'Carla' },
    });

    const byNumber = await repo.listContactCandidates('99990003');
    const byName = await repo.listContactCandidates('carla');

    expect(byNumber).toEqual([
      {
        contactId: linked.id,
        name: 'Bruno (contato)',
        phoneE164: '+5592999990003',
        person: { userId: ids.bruno, name: 'Bruno', sectorName: 'Operação' },
      },
    ]);
    expect(byName).toEqual([
      {
        contactId: loose.id,
        name: 'Carla',
        phoneE164: '+5592988880001',
        person: null,
      },
    ]);
  });
});
