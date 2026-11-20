import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import {
  actorWith,
  permissionsWith,
} from '../../shared/authz/actor.test-fixtures';
import {
  SectorPeopleRepository,
  toSectorPerson,
} from './sector-people.repository';

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
    registration: 'AB-12',
    registrationKey: 'ab-12',
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

const FULL = { isAdmin: true, fullPhone: true };
const MASKED_ONLY = { isAdmin: false, fullPhone: false };
const MANAGER_VIEW = { isAdmin: false, fullPhone: true };

// I2: a posição na lista não pode depender do número que o leitor não vê. Num setor
// só deles: a pessoa D11 (nome = número) e a sem login que o gestor renomeia.
const ORDER = { d11: '+5592944441234', sector: '', d11Id: '', renamedId: '' };

async function seedOrder(): Promise<void> {
  ORDER.sector = (
    await prisma.sector.create({ data: { name: 'Ordem', code: 'ORD' } })
  ).id;
  const sectorId = ORDER.sector;
  ORDER.d11Id = await user({
    ...WITHOUT_ACCESS,
    name: ORDER.d11,
    phoneE164: ORDER.d11,
    sectorId,
  });
  ORDER.renamedId = await user({ ...WITHOUT_ACCESS, name: 'Rui', sectorId });
}

async function dropOrder(): Promise<void> {
  await prisma.user.deleteMany({ where: { sectorId: ORDER.sector } });
  await prisma.sector.delete({ where: { id: ORDER.sector } });
}

/** Renomeia a pessoa sem login e relê a lista como `viewer`: [id, nome exibido]. */
async function renameAndList(name: string, viewer = MASKED_ONLY) {
  await prisma.user.update({ where: { id: ORDER.renamedId }, data: { name } });
  const rows = await repo.listPeople(ORDER.sector, false, viewer);
  return rows.map((row) => [row.id, toSectorPerson(row, viewer).name]);
}

describe('SectorPeopleRepository — ordem pelo nome exibido (I2), lista', () => {
  beforeAll(seedOrder);
  afterAll(dropOrder);

  it('sem a chave: os números reais trocam de ordem e as máscaras não; a lista não muda', async () => {
    const before = await renameAndList('+5592900000000');
    const after = await renameAndList('+5592999990000');

    expect(before).toEqual([
      [ORDER.renamedId, '•••• 0000'],
      [ORDER.d11Id, '•••• 1234'],
    ]);
    expect(after).toEqual(before);
  });

  it('sem a chave, mesma máscara: desempate pelo id, nunca pelo número', async () => {
    const byId = [ORDER.d11Id, ORDER.renamedId]
      .sort()
      .map((id) => [id, '•••• 1234']);

    expect(await renameAndList('+5592900001234')).toEqual(byId);
    expect(await renameAndList('+5592999991234')).toEqual(byId);
  });

  it('com a chave (ADMIN) segue o nome real, como antes', async () => {
    expect(await renameAndList('+5592999990000', FULL)).toEqual([
      [ORDER.d11Id, ORDER.d11],
      [ORDER.renamedId, '+5592999990000'],
    ]);
    expect((await renameAndList('+5592900000000', FULL))[0]).toEqual([
      ORDER.renamedId,
      '+5592900000000',
    ]);
  });
});

describe('SectorPeopleRepository — ordem pelo nome exibido (I2), contatos', () => {
  // Contato cujo nome é o número (vem assim do WhatsApp): reais 1111 < 0000 pelo número inteiro.
  const phones = ['+5592900001111', '+5592911110000'];
  const created: string[] = [];
  beforeAll(async () => {
    for (const phoneE164 of phones) {
      const data = { phoneE164, name: phoneE164 };
      created.push((await prisma.contact.create({ data })).id);
    }
  });
  afterAll(async () => {
    await prisma.contact.deleteMany({ where: { id: { in: created } } });
  });
  const mine = async (viewer: typeof FULL) =>
    names(
      (await repo.listContactCandidates('', viewer)).filter((item) =>
        created.includes(item.contactId),
      ),
    );

  it('sem a chave, a página sai na ordem do nome exibido; com a chave, na do gravado', async () => {
    expect(await mine(MASKED_ONLY)).toEqual(['•••• 0000', '•••• 1111']);
    expect(await mine(FULL)).toEqual(phones);
  });
});

// D11: contato sem nome vira pessoa com o número como nome. Apagados no fim do describe
// para não mudar as listas dos describes seguintes.
const D11 = { loose: '+5592955551234', login: '+5592955555678' };
const d11 = {
  users: [] as string[],
  contacts: { loose: '', login: '', named: '' },
};

async function seedNumberAsName(): Promise<void> {
  const loose = await prisma.contact.create({ data: { phoneE164: D11.loose } });
  const login = await prisma.contact.create({ data: { phoneE164: D11.login } });
  const named = await prisma.contact.create({
    data: { phoneE164: '+5592955554321', name: '(92) 95555-4321' },
  });
  d11.contacts = { loose: loose.id, login: login.id, named: named.id };
  d11.users = [
    await user({
      ...WITHOUT_ACCESS,
      name: D11.loose,
      phoneE164: D11.loose,
      contactId: loose.id,
      registration: 'M-9876',
      registrationKey: 'm-9876',
    }),
    await user({
      name: D11.login,
      email: 'd11@test.local',
      password: 'x',
      role: 'OPERATOR',
      phoneE164: D11.login,
      contactId: login.id,
    }),
  ];
}

async function dropNumberAsName(): Promise<void> {
  await prisma.user.deleteMany({ where: { id: { in: d11.users } } });
  const contacts = Object.values(d11.contacts);
  await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
}

/** [nome do contato, person.name] de cada contato semeado, sem depender da ordem. */
async function contactsOf(viewer: typeof FULL) {
  const items = await repo.listContactCandidates('', viewer);
  const view = (id: string) => {
    const item = items.find((candidate) => candidate.contactId === id);
    return [item?.name, item?.person?.name ?? null];
  };
  const { loose, login, named } = d11.contacts;
  return { named: view(named), loose: view(loose), login: view(login) };
}

describe('SectorPeopleRepository — nome que é telefone (D11), contatos', () => {
  beforeAll(seedNumberAsName);
  afterAll(dropNumberAsName);

  it('sem a chave nem o nome do contato nem person.name trazem o número', async () => {
    const items = await repo.listContactCandidates('', MASKED_ONLY);

    expect(await contactsOf(MASKED_ONLY)).toEqual({
      named: ['•••• 4321', null],
      loose: [null, '•••• 1234'],
      login: [null, '•••• 5678'],
    });
    expect(JSON.stringify(items)).not.toMatch(/55551234|55555678|5555-4321/);
  });

  it('com a chave sai como gravado, menos a pessoa com login para quem não é ADMIN', async () => {
    expect(await contactsOf(MANAGER_VIEW)).toEqual({
      named: ['(92) 95555-4321', null],
      loose: [null, D11.loose],
      login: [null, '•••• 5678'],
    });
    expect(await contactsOf(FULL)).toEqual({
      named: ['(92) 95555-4321', null],
      loose: [null, D11.loose],
      login: [null, D11.login],
    });
  });

  it('sem a chave, busca sem letra devolve vazio; com a chave casa como antes', async () => {
    expect(await repo.listContactCandidates('5555', MASKED_ONLY)).toEqual([]);
    expect(await repo.listContactCandidates('(92) 9', MASKED_ONLY)).toEqual([]);
    expect(names(await repo.listContactCandidates('5555', FULL))).toEqual([
      '(92) 95555-4321',
      null,
      null,
    ]);
  });
});

describe('SectorPeopleRepository — nome que é telefone (D11), busca de candidatos', () => {
  beforeAll(seedNumberAsName);
  afterAll(dropNumberAsName);
  const search = (q: string, searchPhone: boolean) =>
    repo.listCandidates({
      sectorId: ids.operation,
      onlyUnassignedWithoutAccess: false,
      searchPhone,
      q,
    });

  it('sem a chave, termo só de dígitos não casa o nome-telefone, mas casa a matrícula', async () => {
    expect(await search('55551234', false)).toEqual([]);
    expect(await search('+55 92', false)).toEqual([]);
    expect(names(await search('9876', false))).toEqual([D11.loose]);
  });

  it('com a chave casa como antes; termo com letra segue buscando por nome', async () => {
    expect(names(await search('55551234', true))).toEqual([D11.loose]);
    expect(names(await search('tia', false))).toEqual(['Tiago']);
  });
});

describe('SectorPeopleRepository — telefone por permissão', () => {
  const search = (q: string, searchPhone: boolean) =>
    repo.listCandidates({
      sectorId: ids.operation,
      onlyUnassignedWithoutAccess: false,
      searchPhone,
      q,
    });

  it('candidatos: o telefone só entra na busca com a chave; nome e matrícula seguem', async () => {
    const noKey = await search('77770004', false);
    const withKey = await search('77770004', true);
    const byName = await search('tia', false);
    const byRegistration = await search('ab-1', false);

    expect(noKey).toEqual([]);
    expect(names(withKey)).toEqual(['Tiago']);
    expect(names(byName)).toEqual(['Tiago']);
    expect(names(byRegistration)).toEqual(['Tiago']);
  });

  it('contact-candidates sem a chave: phoneE164 null e phoneMasked, e a busca não casa o número', async () => {
    const dora = await prisma.contact.create({
      data: { phoneE164: '+5592966660005', name: 'Dora' },
    });

    const byNumber = await repo.listContactCandidates('66660005', MASKED_ONLY);
    const byName = await repo.listContactCandidates('dor', MASKED_ONLY);
    const withKey = await repo.listContactCandidates('66660005', FULL);

    expect(byNumber).toEqual([]);
    expect(byName).toEqual([
      {
        contactId: dora.id,
        name: 'Dora',
        phoneE164: null,
        phoneMasked: '•••• 0005',
        person: null,
      },
    ]);
    expect(withKey).toEqual([{ ...byName[0], phoneE164: '+5592966660005' }]);
  });
});

describe('SectorPeopleRepository — ator com permissões', () => {
  it('SUPERVISOR traz as 7 chaves da matriz e relê o banco a cada chamada', async () => {
    const supervisor = await user({
      name: 'Sara',
      email: 'sara@test.local',
      password: 'x',
      role: 'SUPERVISOR',
    });
    const where = {
      role_key: { role: 'SUPERVISOR', key: 'estrutura.manter' },
    } as const;
    try {
      const actor = await repo.findActor(supervisor);
      expect(actor).toEqual(actorWith('SUPERVISOR', { id: supervisor }));
      expect(actor?.permissions).toHaveLength(7);

      await prisma.rolePermission.update({ where, data: { granted: true } });
      const regranted = await repo.findActor(supervisor);
      expect(regranted?.permissions).toEqual(
        permissionsWith('SUPERVISOR', { grant: ['estrutura.manter'] }),
      );
    } finally {
      await prisma.rolePermission.update({ where, data: { granted: false } });
      await prisma.user.delete({ where: { id: supervisor } });
    }
  });

  it('ADMIN traz as 10 chaves sem consultar linha de permissão', async () => {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: 'adm@test.local' },
      select: { id: true },
    });
    const findMany = vi.spyOn(prisma.rolePermission, 'findMany');

    const actor = await repo.findActor(admin.id);

    expect(actor).toEqual(actorWith('ADMIN', { id: admin.id }));
    expect(actor?.permissions).toHaveLength(10);
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockRestore();
  });
});

describe('SectorPeopleRepository — busca de candidatos sem coringa de LIKE', () => {
  it('"_" e "%" valem como texto em nome, telefone e matrícula; a busca normal acha', async () => {
    const args = {
      sectorId: ids.operation,
      onlyUnassignedWithoutAccess: false,
      searchPhone: true,
    };

    // Sem escape, "_" casaria um caractere qualquer (Tiago, +5592977770004, ab-12) e "%" casaria todos.
    for (const q of ['T_ago', '92977_70004', 'ab_12', '%']) {
      expect(await repo.listCandidates({ ...args, q }), q).toEqual([]);
    }
    for (const q of ['tia', '77770004', 'ab-1']) {
      const found = await repo.listCandidates({ ...args, q });
      expect(names(found), q).toEqual(['Tiago']);
    }
  });
});

describe('SectorPeopleRepository — inativos e matrícula (A3, A1)', () => {
  it('listPeople só traz o inativo (com isActive false) quando a flag vem', async () => {
    const active = await repo.listPeople(ids.operation, false, FULL);
    const all = await repo.listPeople(ids.operation, true, FULL);

    expect(names(active)).toEqual(['Ágata', 'Ana', 'Bruno']);
    expect(all.map((row) => [row.name, row.isActive])).toEqual([
      ['Abel', false],
      ['Ágata', true],
      ['Ana', true],
      ['Bruno', true],
    ]);
  });

  it('candidatos acham pela matrícula, sem diferenciar maiúsculas, e devolvem registration', async () => {
    const args = {
      sectorId: ids.operation,
      onlyUnassignedWithoutAccess: false,
      searchPhone: true,
    };

    const lower = await repo.listCandidates({ ...args, q: 'ab-1' });
    const upper = await repo.listCandidates({ ...args, q: 'AB-12' });

    expect(lower).toEqual([
      expect.objectContaining({ id: ids.tiago, registration: 'AB-12' }),
    ]);
    expect(upper).toEqual(lower);
  });
});

describe('SectorPeopleRepository — pessoas do setor', () => {
  it('lista ativos do setor por nome com nível, função, turno e hasAccess', async () => {
    const rows = await repo.listPeople(ids.operation, false, FULL);

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
      hasPhone: true,
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

    await expect(repo.findActor(ids.tiago)).resolves.toEqual(
      actorWith('OPERATOR', { id: ids.tiago }),
    );
    await expect(repo.findSector(ids.it)).resolves.toEqual({
      id: ids.it,
      name: 'TI',
      code: 'TI',
      isActive: true,
      managerId: ids.tiago,
      manager: { id: ids.tiago, name: 'Tiago' },
      channel: null,
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
      searchPhone: true,
    });

    expect(items).toEqual([
      {
        id: ids.nina,
        name: 'Nina',
        hasAccess: false,
        sector: null,
        registration: null,
      },
    ]);
  });

  it('candidatos do ADMIN excluem quem já está no setor e buscam por nome ou telefone', async () => {
    const args = {
      sectorId: ids.operation,
      onlyUnassignedWithoutAccess: false,
      searchPhone: true,
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
        registration: 'AB-12',
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

    const byNumber = await repo.listContactCandidates('99990003', FULL);
    const byName = await repo.listContactCandidates('carla', FULL);

    expect(byNumber).toEqual([
      {
        contactId: linked.id,
        name: 'Bruno (contato)',
        phoneE164: '+5592999990003',
        phoneMasked: '•••• 0003',
        person: { userId: ids.bruno, name: 'Bruno', sectorName: 'Operação' },
      },
    ]);
    expect(byName).toEqual([
      {
        contactId: loose.id,
        name: 'Carla',
        phoneE164: '+5592988880001',
        phoneMasked: '•••• 0001',
        person: null,
      },
    ]);
  });
});
