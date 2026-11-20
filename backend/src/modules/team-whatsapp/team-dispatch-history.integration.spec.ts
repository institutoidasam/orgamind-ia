import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import {
  TeamWhatsappRepository,
  type DispatchListFilter,
} from './team-whatsapp.repository';

// Lote G, T7 (CG8, DG13, DG14, GG7): filtros da lista, todos os destinatários,
// contagem da reconferência e detalhe, contra o Postgres real. Um container para
// o arquivo; cada teste usa autores próprios e um mês próprio de 2025, e os
// instantes são gravados explícitos no fuso de Manaus (-04:00).
const PAGE = { page: 1, pageSize: 20 };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const at = (iso: string) => new Date(iso);

async function autor(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${tag}@historico.test.local`, password: 'x', name: tag },
  });
  return user.id;
}

type Seed = Omit<
  Prisma.TeamWhatsappDispatchUncheckedCreateInput,
  'targetType' | 'targetId' | 'targetLabel' | 'text'
> & { createdAt: Date };

/** Envio gravado direto, com `createdAt` explícito (GG10). */
async function envio(seed: Seed): Promise<string> {
  const row = await prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 'setor-historico',
      targetLabel: 'Logística',
      text: 'Aviso',
      ...seed,
    },
    select: { id: true },
  });
  return row.id;
}

const ids = (page: { rows: { id: string }[] }) => page.rows.map((r) => r.id);

describe('listDispatches com filtros — autoria (GG7)', () => {
  it('gestor com filtros nunca vê envio de outro autor (findMany e count)', async () => {
    const [a, b] = await Promise.all([autor('gestor-a'), autor('gestor-b')]);
    const filtro: DispatchListFilter = {
      createdFrom: at('2025-01-01T00:00:00.000-04:00'),
      createdBefore: at('2025-02-01T00:00:00.000-04:00'),
      purpose: 'MEETING',
      state: 'DISPATCHED',
    };
    const createdAt = at('2025-01-10T09:00:00.000-04:00');
    const deA = await envio({ authorId: a, createdAt, purpose: 'MEETING' });
    const deB1 = await envio({ authorId: b, createdAt, purpose: 'MEETING' });
    const deB2 = await envio({ authorId: b, createdAt, purpose: 'MEETING' });

    const doA = await repo.listDispatches(a, PAGE, filtro);
    expect(ids(doA)).toEqual([deA]);
    expect(doA.total).toBe(1);
    const doB = await repo.listDispatches(b, PAGE, filtro);
    expect(new Set(ids(doB))).toEqual(new Set([deB1, deB2]));
    expect(doB.total).toBe(2);
    // Chave alheia no filtro (ex.: DTO espalhado) não troca o autor.
    const forjado = { ...filtro, authorId: b } as DispatchListFilter;
    const tentativa = await repo.listDispatches(a, PAGE, forjado);
    expect(ids(tentativa)).toEqual([deA]);
    expect(tentativa.total).toBe(1);
    // ADMIN (authorId null) vê os três com o mesmo filtro.
    expect((await repo.listDispatches(null, PAGE, filtro)).total).toBe(3);
  });
});

describe('listDispatches com filtros — período (DG14)', () => {
  it('filtra por período nas bordas de dia de Manaus', async () => {
    const a = await autor('periodo');
    const em = (iso: string) => envio({ authorId: a, createdAt: at(iso) });
    await em('2025-03-10T23:59:59.999-04:00'); // véspera
    const utcDiaSeguinte = await em('2025-03-11T02:00:00.000Z'); // 10/03 em Manaus
    const primeiro = await em('2025-03-11T00:00:00.000-04:00');
    const noiteUtc = await em('2025-03-13T02:00:00.000Z'); // 12/03 em Manaus
    const ultimo = await em('2025-03-12T23:59:59.999-04:00');
    const depois = await em('2025-03-13T00:00:00.000-04:00');
    const createdFrom = at('2025-03-11T00:00:00.000-04:00');
    const createdBefore = at('2025-03-13T00:00:00.000-04:00');

    const dentro = await repo.listDispatches(a, PAGE, {
      createdFrom,
      createdBefore,
    });
    expect(ids(dentro)).toEqual([ultimo, noiteUtc, primeiro]);
    expect(dentro.total).toBe(3);
    const desde = await repo.listDispatches(a, PAGE, { createdFrom });
    expect(ids(desde)).toEqual([depois, ultimo, noiteUtc, primeiro]);
    const ate = await repo.listDispatches(a, PAGE, { createdBefore });
    expect(ate.total).toBe(5);
    expect(ids(ate)).toContain(utcDiaSeguinte);
    expect(ids(ate)).not.toContain(depois);
  });
});

describe('listDispatches com filtros — finalidade e estado (DG14)', () => {
  it('filtra por finalidade e por estado, inclusive EXPIRED', async () => {
    const a = await autor('finalidade-estado');
    const em = (minute: number, extra: Partial<Seed>) =>
      envio({
        authorId: a,
        createdAt: at(
          `2025-05-10T09:${String(minute).padStart(2, '0')}:00-04:00`,
        ),
        ...extra,
      });
    const reuniao = await em(1, { purpose: 'MEETING' });
    const reuniaoVencida = await em(2, {
      purpose: 'MEETING',
      state: 'EXPIRED',
    });
    const palestraVencida = await em(3, {
      purpose: 'LECTURE',
      state: 'EXPIRED',
    });
    await em(4, { purpose: null });
    await em(5, { purpose: 'SHIFT_NOTICE', state: 'SCHEDULED' });

    const vencidos = await repo.listDispatches(a, PAGE, { state: 'EXPIRED' });
    expect(ids(vencidos)).toEqual([palestraVencida, reuniaoVencida]);
    expect(vencidos.total).toBe(2);
    const reunioes = await repo.listDispatches(a, PAGE, { purpose: 'MEETING' });
    expect(ids(reunioes)).toEqual([reuniaoVencida, reuniao]);
    const ambos = await repo.listDispatches(a, PAGE, {
      purpose: 'MEETING',
      state: 'EXPIRED',
    });
    expect(ids(ambos)).toEqual([reuniaoVencida]);
    expect(ambos.total).toBe(1);
  });
});

describe('listDispatches com filtros — paginação', () => {
  it('filtros combinados com paginação: total do count bate', async () => {
    const [a, outro] = await Promise.all([autor('pag-a'), autor('pag-b')]);
    const base = { purpose: 'ALIGNMENT', state: 'DISPATCHED' } as const;
    const dia = (d: number) =>
      at(`2025-07-${String(d).padStart(2, '0')}T10:00:00-04:00`);
    const certos: string[] = [];
    for (const d of [1, 2, 3, 4, 5]) {
      certos.push(await envio({ authorId: a, createdAt: dia(d), ...base }));
    }
    await envio({
      authorId: a,
      createdAt: dia(6),
      ...base,
      state: 'CANCELLED',
    });
    await envio({
      authorId: a,
      createdAt: at('2025-08-01T10:00:00-04:00'),
      ...base,
    });
    await envio({ authorId: outro, createdAt: dia(7), ...base });
    const filtro: DispatchListFilter = {
      ...base,
      createdFrom: at('2025-07-01T00:00:00-04:00'),
      createdBefore: at('2025-08-01T00:00:00-04:00'),
    };

    const p2 = await repo.listDispatches(a, { page: 2, pageSize: 2 }, filtro);
    expect(ids(p2)).toEqual([certos[2], certos[1]]);
    expect(p2.total).toBe(5);
    const p3 = await repo.listDispatches(a, { page: 3, pageSize: 2 }, filtro);
    expect(ids(p3)).toEqual([certos[0]]);
    expect(p3.total).toBe(5);
  });
});

const PHONE = (n: number) => `+55929911100${String(n).padStart(2, '0')}`;

describe('listAllDispatchRecipients (DG13)', () => {
  it('listAllDispatchRecipients devolve todos, ordenados, com phoneE164', async () => {
    const createdAt = at('2025-09-01T08:00:00-04:00');
    const id = await envio({ createdAt });
    const vizinho = await envio({ createdAt });
    // 25 pessoas (mais que uma página de 20), fora de ordem, com nome repetido.
    const pessoas = Array.from({ length: 25 }, (_, i) => ({
      dispatchId: id,
      userName: `Pessoa ${String(i === 24 ? 7 : 25 - i).padStart(2, '0')}`,
      phoneE164: PHONE(i + 1),
      status: i % 5 === 0 ? ('FAILED' as const) : ('SENT' as const),
    }));
    await prisma.teamWhatsappRecipient.createMany({ data: pessoas });
    await prisma.teamWhatsappRecipient.create({
      data: { dispatchId: vizinho, userName: 'Pessoa 00', status: 'SENT' },
    });

    const todos = await repo.listAllDispatchRecipients(id);
    const esperado = await prisma.teamWhatsappRecipient.findMany({
      where: { dispatchId: id },
      select: { id: true, userName: true, phoneE164: true },
    });
    const ordem = (x: { userName: string; id: string }) =>
      `${x.userName}|${x.id}`;
    esperado.sort((x, y) => (ordem(x) < ordem(y) ? -1 : 1));
    expect(todos.map((r) => [r.id, r.userName, r.phoneE164])).toEqual(
      esperado.map((r) => [r.id, r.userName, r.phoneE164]),
    );
    const falhas = await repo.listAllDispatchRecipients(id, 'FAILED');
    expect(falhas).toHaveLength(5);
    expect(falhas.every((r) => r.status === 'FAILED')).toBe(true);
  });
});

const SKIP_REASONS = [
  'NO_PHONE',
  'SUPPRESSED',
  'INACTIVE',
  'NOT_AUTHORIZED',
  'VACATION',
  'DAY_OFF',
  'LEFT_SECTOR',
  'PHONE_CHANGED',
  'EXPIRED',
] as const;

describe('countRecheckSkips (CG8)', () => {
  it('countRecheckSkips conta só os quatro motivos', async () => {
    const createdAt = at('2025-10-01T08:00:00-04:00');
    const id = await envio({ createdAt });
    const vizinho = await envio({ createdAt });
    await prisma.teamWhatsappRecipient.createMany({
      data: [
        ...SKIP_REASONS.map((skipReason, i) => ({
          dispatchId: id,
          userName: `Pessoa ${i}`,
          status: 'SKIPPED' as const,
          skipReason,
        })),
        { dispatchId: id, userName: 'Pessoa Enviada', status: 'SENT' as const },
        {
          dispatchId: vizinho,
          userName: 'Pessoa Vizinha',
          status: 'SKIPPED' as const,
          skipReason: 'VACATION' as const,
        },
      ],
    });

    expect(await repo.countRecheckSkips(id)).toBe(4);
  });
});

describe('detalhe com reconferência (CG8)', () => {
  it('detalhe traz recheckedAt e audienceLateJoined', async () => {
    const createdAt = at('2025-11-01T08:00:00-04:00');
    const recheckedAt = at('2025-11-02T07:00:00-04:00');
    const tardia = {
      userId: 'u-tardia',
      name: 'Pessoa Tardia',
      sectorId: 's-1',
      sectorName: 'Logística',
      shiftName: '1º turno',
      levelName: null,
    };
    const id = await envio({
      createdAt,
      recheckedAt,
      audienceLateJoined: [tardia],
    });
    const antigo = await envio({ createdAt });

    expect(await repo.findDispatchDetail(id)).toMatchObject({
      recheckedAt,
      audienceLateJoined: [tardia],
    });
    expect(await repo.findDispatchDetail(antigo)).toMatchObject({
      recheckedAt: null,
      audienceLateJoined: null,
    });
  });
});
