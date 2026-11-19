import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { addDays, toDbDate, zonedStart } from '../staff-schedule/civil-date';
import {
  type CandidateFilter,
  PeopleExportRepository,
} from './people-export.repository';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
// Cadastro antigo o bastante para ficar antes de qualquer data de referência dos testes.
const EARLY = new Date('2026-01-01T12:00:00Z');
const FAR = new Date('2100-01-01T00:00:00Z');
const ALL: CandidateFilter = {
  status: 'all',
  createdBefore: FAR,
  mirror: { sectorIds: null, shiftId: null },
};

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: PeopleExportRepository;
const ref = { a: '', b: '', morning: '', night: '' };

// Pessoa sem acesso (CHECK User_access_consistent): e-mail e senha NULL, VIEWER.
const NO_LOGIN = {
  hasAccess: false,
  email: null,
  password: null,
  role: 'VIEWER',
} as const;

function login(id: string) {
  return {
    hasAccess: true,
    email: `${id}@test.local`,
    password: 'x',
    role: 'OPERATOR',
  } as const;
}

async function person(
  id: string,
  extra: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<void> {
  await prisma.user.create({
    data: { id, name: id, ...NO_LOGIN, createdAt: EARLY, ...extra },
  });
}

// p1, p2, p4 e p6 no setor A; p3 no B; p5 sem setor; p4 inativa; p6 com login.
async function seedGrid(): Promise<void> {
  await person('p1', { sectorId: ref.a, shiftId: ref.morning });
  await person('p2', { sectorId: ref.a, shiftId: ref.night });
  await person('p3', { sectorId: ref.b, shiftId: ref.morning });
  await person('p4', {
    sectorId: ref.a,
    shiftId: ref.morning,
    isActive: false,
  });
  await person('p5');
  await person('p6', {
    ...login('p6'),
    sectorId: ref.a,
    shiftId: ref.morning,
    levelId: 'level_leader',
  });
}

beforeAll(async () => {
  if (!TESTCONTAINERS_ENABLED) return;
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new PeopleExportRepository(prisma as never);
  ref.a = (
    await prisma.sector.create({ data: { name: 'Alfa', code: 'ALF' } })
  ).id;
  ref.b = (
    await prisma.sector.create({ data: { name: 'Beta', code: 'BET' } })
  ).id;
  const shift = (name: string, startTime: string, sortOrder: number) =>
    prisma.shift.create({
      data: { name, startTime, endTime: '19:00', sortOrder },
    });
  ref.morning = (await shift('Manhã', '07:00', 97)).id;
  ref.night = (await shift('Noite', '19:00', 98)).id;
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

// Cada teste monta as próprias pessoas; vínculos saem em cascata.
beforeEach(async () => {
  if (TESTCONTAINERS_ENABLED) await prisma.user.deleteMany();
});

async function pageIds(filter: Partial<CandidateFilter>): Promise<string[]> {
  const rows = await repo.pageCandidates({ ...ALL, ...filter }, 100);
  return rows.map((row) => row.id);
}

function mirror(sectorIds: string[] | null, shiftId: string | null = null) {
  return { sectorIds, shiftId };
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('pageCandidates: espelho', () => {
  it('pageCandidates: filtra situação, setor, turno e alcance pelo espelho e pagina por id', async () => {
    await seedGrid();
    const inA = mirror([ref.a]);
    expect(await pageIds({ status: 'active', mirror: inA })).toEqual([
      'p1',
      'p2',
      'p6',
    ]);
    expect(await pageIds({ status: 'inactive', mirror: inA })).toEqual(['p4']);
    expect(await pageIds({ status: 'all', mirror: inA })).toEqual([
      'p1',
      'p2',
      'p4',
      'p6',
    ]);
    const morningInA = mirror([ref.a], ref.morning);
    expect(await pageIds({ status: 'active', mirror: morningInA })).toEqual([
      'p1',
      'p6',
    ]);
    // Alcance de gestor: só os setores dele; o setor alheio não entra.
    expect(
      await pageIds({ status: 'active', mirror: mirror([ref.b]) }),
    ).toEqual(['p3']);
    expect(
      await pageIds({ status: 'active', mirror: mirror([ref.a, ref.b]) }),
    ).toEqual(['p1', 'p2', 'p3', 'p6']);
    const [first] = await repo.pageCandidates({ ...ALL, mirror: inA }, 1);
    expect(first).toStrictEqual({
      id: 'p1',
      name: 'p1',
      hasAccess: false,
      sectorId: ref.a,
      shiftId: ref.morning,
      levelId: null,
    });
  });
});

describe.skipIf(!TESTCONTAINERS_ENABLED)('pageCandidates: sem setor', () => {
  it('pageCandidates com sectorIds nulo traz também quem não tem setor', async () => {
    await seedGrid();
    const active = { status: 'active' } as const;
    expect(await pageIds({ ...active, mirror: mirror(null) })).toEqual([
      'p1',
      'p2',
      'p3',
      'p5',
      'p6',
    ]);
    expect(
      await pageIds({ ...active, mirror: mirror(null, ref.night) }),
    ).toEqual(['p2']);
    // Lista vazia é "nenhum setor", nunca "sem filtro".
    expect(await pageIds({ ...active, mirror: mirror([]) })).toEqual([]);
  });

  it('pageCandidates com mirror nulo (data passada) filtra só situação e cadastro', async () => {
    await seedGrid();
    expect(await pageIds({ status: 'active', mirror: null })).toEqual([
      'p1',
      'p2',
      'p3',
      'p5',
      'p6',
    ]);
    expect(await pageIds({ status: 'inactive', mirror: null })).toEqual(['p4']);
  });
});

async function pagesOf(
  filter: CandidateFilter,
  take: number,
): Promise<string[][]> {
  const pages: string[][] = [];
  let afterId: string | undefined;
  let page = await repo.pageCandidates(filter, take, afterId);
  while (page.length > 0) {
    pages.push(page.map((row) => row.id));
    afterId = page[page.length - 1].id;
    if (page.length < take) break;
    page = await repo.pageCandidates(filter, take, afterId);
  }
  return pages;
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'pageCandidates: cursor e cadastro',
  () => {
    it('pagina por cursor de id em 3 páginas, sem pular nem repetir', async () => {
      await seedGrid();
      expect(await pagesOf(ALL, 2)).toEqual([
        ['p1', 'p2'],
        ['p3', 'p4'],
        ['p5', 'p6'],
      ]);
      // Tamanho que não divide o total: a última página vem curta.
      expect(await pagesOf(ALL, 4)).toEqual([
        ['p1', 'p2', 'p3', 'p4'],
        ['p5', 'p6'],
      ]);
    });

    it('pageCandidates exclui quem foi cadastrado depois do fim do dia da data em Manaus', async () => {
      // Manaus é UTC-4: 03:59Z de 19/11 é 23:59 de 18/11; 04:00Z já é 19/11 00:00.
      await person('in-2359', { createdAt: new Date('2026-11-19T03:59:00Z') });
      await person('out-0000', { createdAt: new Date('2026-11-19T04:00:00Z') });
      await person('old');
      const endOfDay = (date: string) => zonedStart(addDays(date, 1), '00:00');
      expect(endOfDay('2026-11-18')).toEqual(new Date('2026-11-19T04:00:00Z'));
      const past = { mirror: null } as const;
      expect(
        await pageIds({ ...past, createdBefore: endOfDay('2026-11-18') }),
      ).toEqual(['in-2359', 'old']);
      expect(
        await pageIds({ ...past, createdBefore: endOfDay('2026-11-19') }),
      ).toEqual(['in-2359', 'old', 'out-0000']);
      // Vale também no modo espelho (data de hoje ou futura).
      expect(await pageIds({ createdBefore: endOfDay('2026-11-18') })).toEqual([
        'in-2359',
        'old',
      ]);
    });
  },
);

async function seedLines(): Promise<void> {
  await person('u1');
  await person('u2');
  const line = (
    userId: string,
    sectorId: string,
    from: string | null,
    to: string | null,
  ) => ({
    userId,
    sectorId,
    validFrom: from === null ? null : toDbDate(from),
    validTo: to === null ? null : toDbDate(to),
  });
  await prisma.userAssignment.createMany({
    data: [
      line('u1', ref.a, null, '2026-10-31'),
      line('u1', ref.b, '2026-11-01', '2026-11-10'),
      line('u1', ref.a, '2026-11-11', null),
      line('u2', ref.b, '2026-11-05', null),
    ],
  });
}

async function sectorsOn(
  userId: string,
  date: string,
): Promise<(string | null)[] | undefined> {
  const lines = await repo.linesOn(['u1', 'u2'], date);
  return lines.get(userId)?.map((line) => line.sectorId);
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('linesOn', () => {
  it('linesOn devolve a linha de início em branco para data anterior ao histórico e respeita os limites inclusivos', async () => {
    await seedLines();
    const lines = await repo.linesOn(['u1', 'u2'], '2026-01-01');
    expect(lines.get('u1')).toEqual([
      {
        sectorId: ref.a,
        shiftId: null,
        levelId: null,
        from: null,
        to: '2026-10-31',
      },
    ]);
    expect(lines.has('u2')).toBe(false); // nenhuma linha cobre a data: cai no espelho
    expect(await sectorsOn('u1', '2026-10-31')).toEqual([ref.a]); // fim inclusivo
    expect(await sectorsOn('u1', '2026-11-01')).toEqual([ref.b]); // início inclusivo
    expect(await sectorsOn('u1', '2026-11-10')).toEqual([ref.b]); // fim inclusivo
    expect(await sectorsOn('u1', '2026-11-11')).toEqual([ref.a]); // linha aberta
    expect(await sectorsOn('u2', '2026-11-04')).toBeUndefined(); // véspera do início
    expect(await sectorsOn('u2', '2026-11-05')).toEqual([ref.b]);
  });
});

describe.skipIf(!TESTCONTAINERS_ENABLED)('detailsByIds', () => {
  it('detailsByIds traz os campos das células com a data da autorização como data civil', async () => {
    await person('d1', {
      ...login('d1'),
      registration: 'MAT-1',
      phoneE164: '+5592991110001',
      jobTitle: 'Auxiliar',
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'TERMO_ASSINADO',
      authorizationNote: 'Termo 12',
      // Gravada como o resto do sistema grava (toDbDate): a coluna só guarda o dia.
      authorizationDate: toDbDate('2026-11-19'),
      isActive: false,
    });
    await person('d2');
    await person('d3');
    const rows = await repo.detailsByIds(['d2', 'ausente', 'd1']);
    expect(rows.map((row) => row.id).sort()).toEqual(['d1', 'd2']);
    expect(rows.find((row) => row.id === 'd1')).toStrictEqual({
      id: 'd1',
      registration: 'MAT-1',
      name: 'd1',
      phoneE164: '+5592991110001',
      jobTitle: 'Auxiliar',
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'TERMO_ASSINADO',
      authorizationNote: 'Termo 12',
      authorizationDate: '2026-11-19',
      isActive: false,
      hasAccess: true,
    });
    expect(rows.find((row) => row.id === 'd2')).toMatchObject({
      contactAuthorization: 'NAO_AUTORIZADO',
      authorizationSource: null,
      authorizationDate: null,
      hasAccess: false,
    });
  });
});

describe.skipIf(!TESTCONTAINERS_ENABLED)('nameMaps', () => {
  it('nameMaps inclui setor, turno e nível inativos', async () => {
    const [sector, shift, level] = await Promise.all([
      prisma.sector.create({
        data: { name: 'Extinto', code: 'EXT', isActive: false },
      }),
      prisma.shift.create({
        data: {
          name: 'Madrugada',
          startTime: '00:00',
          endTime: '06:00',
          sortOrder: 99,
          isActive: false,
        },
      }),
      prisma.staffLevel.create({
        data: { name: 'Estagiário', sortOrder: 90, isActive: false },
      }),
    ]);
    const maps = await repo.nameMaps();
    expect(maps.sectors.get(sector.id)).toBe('Extinto');
    expect(maps.sectors.get(ref.a)).toBe('Alfa');
    expect(maps.shifts.get(shift.id)).toBe('Madrugada');
    expect(maps.shifts.get(ref.night)).toBe('Noite');
    expect(maps.levels.get(level.id)).toBe('Estagiário');
    expect(maps.levels.get('level_leader')).toBeDefined();
  });
});

// Só leitura e sem ida ao banco quando não há o que buscar: o banco "falso" estoura
// em qualquer acesso, então um acesso indevido derruba o teste.
describe('PeopleExportRepository sem ida ao banco', () => {
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error('o banco não deveria ser consultado');
      },
    },
  );
  const bare = new PeopleExportRepository(untouched as never);

  it('lista vazia de ids ou de setores não consulta o banco', async () => {
    expect(await bare.detailsByIds([])).toEqual([]);
    expect((await bare.linesOn([], '2026-11-18')).size).toBe(0);
    expect(
      await bare.pageCandidates({ ...ALL, mirror: mirror([]) }, 10),
    ).toEqual([]);
  });
});
