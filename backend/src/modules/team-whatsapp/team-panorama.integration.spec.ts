import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma, type Role } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import type {
  PanoramaCounts,
  TeamPanoramaResponse,
} from '../../schemas/contracts/team-panorama.schema';
import type { TeamRosterResponse } from '../../schemas/contracts/team-whatsapp.schema';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { toDbDate, todayIn } from '../staff-schedule/civil-date';
import { TeamPanoramaService } from './team-panorama.service';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappService } from './team-whatsapp.service';

// Lote J, T2 (DJ1–DJ3; aceites 1 a 4) contra o Postgres real. "Hoje" é o do
// relógio por `todayIn`, passado explícito ao serviço (GJ8), para o roster real
// (que lê o relógio) ver a mesma data; `createdAt` explícito. Nomes e telefones
// fictícios; nada é enviado (só leitura).
const NOW = new Date();
const TODAY = todayIn(NOW);
const CREATED = new Date('2026-01-05T09:00:00-04:00');

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let panorama: TeamPanoramaService;
let team: TeamWhatsappService;
let seq = 0;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
  panorama = new TeamPanoramaService(repo);
  // O roster só lê: consentimento, trilha e fila não entram; nenhum setor
  // daqui tem número, então o estado ao vivo nunca é consultado.
  team = new TeamWhatsappService(repo, {} as never, {} as never, {} as never);
  Object.assign(team, {
    live: { checkMany: () => Promise.resolve(new Map()) },
  });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const run = (actorId: string) =>
  panorama.panorama(actorId, { date: TODAY }, NOW);

async function sector(over: Partial<Prisma.SectorUncheckedCreateInput> = {}) {
  const n = ++seq;
  return prisma.sector.create({
    data: { name: `Área ${n}`, code: `PAN${n}`, ...over },
  });
}

/** Usuário com login; vira gestor (`managerId`) dos setores pedidos. */
async function actor(role: Role, manages: string[] = []): Promise<string> {
  const n = ++seq;
  const { id } = await prisma.user.create({
    data: {
      email: `pan-${n}@test.local`,
      password: 'x',
      role,
      name: `Gestor ${n}`,
      createdAt: CREATED,
    },
  });
  await prisma.sector.updateMany({
    where: { id: { in: manages } },
    data: { managerId: id },
  });
  return id;
}

/** Pessoa sem login (padrão: sem telefone, sem turno, sem autorização). */
async function person(
  sectorId: string | null,
  over: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  const n = ++seq;
  return prisma.user.create({
    data: {
      name: `Pessoa ${n}`,
      hasAccess: false,
      sectorId,
      createdAt: CREATED,
      ...over,
    },
  });
}

/** Exceção da escala só para hoje. */
async function exceptionToday(
  userId: string,
  kind: Prisma.StaffScheduleExceptionUncheckedCreateInput['kind'],
  over: Partial<Prisma.StaffScheduleExceptionUncheckedCreateInput> = {},
) {
  const day = toDbDate(TODAY);
  await prisma.staffScheduleException.create({
    data: { userId, kind, startDate: day, endDate: day, ...over },
  });
}

const phone = () => `+5592992${String(++seq).padStart(6, '0')}`;
const total = (c: PanoramaCounts | null | undefined) =>
  c
    ? c.byShift.reduce((sum, s) => sum + s.count, 0) +
      c.otherShifts +
      c.dayOff +
      c.vacation +
      c.noSchedule
    : 0;
const countsOf = (res: TeamPanoramaResponse, sectorId: string) =>
  res.sectors.find((s) => s.sectorId === sectorId)?.counts;
const inShift = (c: PanoramaCounts | null | undefined, shiftId: string) =>
  c?.byShift.find((s) => s.shiftId === shiftId)?.count;
const scope = (res: TeamPanoramaResponse) =>
  Object.fromEntries(
    res.sectors.map((s) => [s.sectorId, [s.overLimit, total(s.counts)]]),
  );

/** Contagens tiradas da resposta do roster real, na regra do panorama (DJ4). */
function fromRoster(
  roster: TeamRosterResponse,
  sectorId: string,
  shiftIds: readonly string[],
): PanoramaCounts {
  const c = {
    byShift: shiftIds.map((shiftId) => ({ shiftId, count: 0 })),
    otherShifts: 0,
    dayOff: 0,
    vacation: 0,
    noSchedule: 0,
    noPhone: 0,
    notAuthorized: 0,
  };
  const members = roster.sectors.find((s) => s.sectorId === sectorId)?.members;
  for (const m of members ?? []) {
    const s = m.situation;
    if (s.kind === 'NONE') c.noSchedule += 1;
    else if (s.kind === 'OFF')
      c[s.reason === 'DAY_OFF' ? 'dayOff' : 'vacation'] += 1;
    else {
      const slot = c.byShift.find((b) => b.shiftId === s.shiftId);
      if (slot) slot.count += 1;
      else c.otherShifts += 1;
      if (!m.hasPhone) c.noPhone += 1;
      else if (m.contactAuthorization !== 'AUTORIZADO') c.notAuthorized += 1;
    }
  }
  return c;
}

describe('TeamPanoramaService — alcance do ator (Postgres real; aceites 1 e 2)', () => {
  it('aceite 1: ADMIN — todos os setores ativos, setor inativo fora', async () => {
    const on = await sector();
    const off = await sector({ isActive: false });
    const res = await run(await actor('ADMIN'));
    const active = await prisma.sector.findMany({ where: { isActive: true } });
    const ids = res.sectors.map((s) => s.sectorId);
    expect(new Set(ids)).toEqual(new Set(active.map((s) => s.id)));
    expect(ids).toContain(on.id);
    expect(ids).not.toContain(off.id);
    const names = res.sectors.map((s) => s.name);
    const ptBR = new Intl.Collator('pt-BR');
    expect(names).toEqual([...names].sort((x, y) => ptBR.compare(x, y)));
    expect(res).toMatchObject({ date: TODAY, today: TODAY });
  });

  it('aceite 2: SUPERVISOR que gere dois setores vê só esses dois', async () => {
    const [a, b] = [await sector(), await sector()];
    await sector();
    const res = await run(await actor('SUPERVISOR', [a.id, b.id]));
    expect(new Set(res.sectors.map((s) => s.sectorId))).toEqual(
      new Set([a.id, b.id]),
    );
  });

  it('aceite 2: SUPERVISOR cujo setor gerido está inativo não vê esse setor; se não gere outro ativo, 403 team_whatsapp.forbidden', async () => {
    const on = await sector();
    const off = await sector({ isActive: false });
    const both = await run(await actor('SUPERVISOR', [on.id, off.id]));
    expect(both.sectors.map((s) => s.sectorId)).toEqual([on.id]);
    const gone = await sector({ isActive: false });
    const onlyInactive = await actor('SUPERVISOR', [gone.id]);
    await expect(run(onlyInactive)).rejects.toMatchObject({
      status: 403,
      code: 'team_whatsapp.forbidden',
    });
  });
});

describe('TeamPanoramaService — quem conta (Postgres real; aceite 4)', () => {
  it('aceite 4: emprestado (OTHER_SECTOR) conta no setor do empréstimo e não no de origem', async () => {
    const [origin, loan] = [await sector(), await sector()];
    const sup = await actor('SUPERVISOR', [origin.id, loan.id]);
    await person(origin.id, { shiftId: 'shift_first' });
    const lent = await person(origin.id, { shiftId: 'shift_first' });
    await exceptionToday(lent.id, 'OTHER_SECTOR', {
      sectorId: loan.id,
      shiftId: 'shift_second',
    });
    const res = await run(sup);
    const o = countsOf(res, origin.id);
    const l = countsOf(res, loan.id);
    expect([total(o), inShift(o, 'shift_first')]).toEqual([1, 1]);
    expect([total(l), inShift(l, 'shift_second')]).toEqual([1, 1]);
  });

  it('aceite 4: pessoa inativa não conta; pessoa sem setor e sem escala não aparece', async () => {
    const s = await sector();
    const admin = await actor('ADMIN');
    await person(s.id, { shiftId: 'shift_first' });
    await person(s.id, { shiftId: 'shift_first', isActive: false });
    const sum = (r: TeamPanoramaResponse) =>
      r.sectors.reduce((acc, card) => acc + total(card.counts), 0);
    const before = await run(admin);
    await person(null);
    await person(null, { shiftId: 'shift_first' });
    const after = await run(admin);
    expect(total(countsOf(after, s.id))).toBe(1);
    expect(sum(after)).toBe(sum(before));
  });
});

/**
 * Setor `r` com um de cada: autorizado e sem autorização no 1º turno, sem
 * telefone no 2º, turno inativo, sem escala, folga, férias e um visitante de
 * `other` emprestado para o 2º turno de `r`.
 */
async function seedMixed(r: string, other: string) {
  const off = await prisma.shift.create({
    data: {
      name: `Turno inativo ${++seq}`,
      startTime: '01:00',
      endTime: '05:00',
      isActive: false,
      sortOrder: 90,
    },
  });
  const ok = {
    contactAuthorization: 'AUTORIZADO',
    authorizationSource: 'TERMO_ASSINADO',
  } as const;
  await person(r, { shiftId: 'shift_first', phoneE164: phone(), ...ok });
  await person(r, { shiftId: 'shift_first', phoneE164: phone() });
  await person(r, { shiftId: 'shift_second' });
  await person(r, { shiftId: off.id });
  await person(r);
  const folga = await person(r, { shiftId: 'shift_first' });
  await exceptionToday(folga.id, 'DAY_OFF');
  const ferias = await person(r, { shiftId: 'shift_first' });
  await exceptionToday(ferias.id, 'VACATION');
  const visitor = await person(other, { shiftId: 'shift_first' });
  await exceptionToday(visitor.id, 'OTHER_SECTOR', {
    sectorId: r,
    shiftId: 'shift_second',
  });
}

describe('TeamPanoramaService — igual ao roster (Postgres real; aceite 4)', () => {
  it('aceite 4: números batem com o roster na mesma data', async () => {
    const [r, other] = [await sector(), await sector()];
    const sup = await actor('SUPERVISOR', [r.id, other.id]);
    await seedMixed(r.id, other.id);
    const query = { sectorIds: [r.id, other.id], date: TODAY };
    const [pan, roster] = await Promise.all([
      run(sup),
      team.roster(sup, query),
    ]);
    const shiftIds = pan.shifts.map((s) => s.id);
    for (const id of [r.id, other.id]) {
      expect(countsOf(pan, id)).toEqual(fromRoster(roster, id, shiftIds));
    }
    expect(countsOf(pan, r.id)).toMatchObject({
      otherShifts: 1,
      dayOff: 1,
      vacation: 1,
      noSchedule: 1,
      noPhone: 3,
      notAuthorized: 1,
    });
    expect([
      inShift(countsOf(pan, r.id), 'shift_first'),
      inShift(countsOf(pan, r.id), 'shift_second'),
    ]).toEqual([2, 2]);
  });
});

describe('TeamPanoramaService — dado pessoal e trilha (Postgres real; aceite 3)', () => {
  it('aceite 3: a resposta não contém nome nem telefone semeados', async () => {
    const s = await sector();
    const sup = await actor('SUPERVISOR', [s.id]);
    const name = 'Marina Fictícia';
    const tel = '+5592991110001';
    await person(s.id, { name, shiftId: 'shift_first', phoneE164: tel });
    const res = await run(sup);
    const body = JSON.stringify(res);
    expect(total(countsOf(res, s.id))).toBe(1);
    for (const secret of [name, 'Marina', tel, '991110001']) {
      expect(body).not.toContain(secret);
    }
    expect(new Set(Object.keys(res.sectors[0]))).toEqual(
      new Set(['sectorId', 'name', 'overLimit', 'counts']),
    );
  });

  it('aceite 3: a leitura não grava AuditEvent', async () => {
    const admin = await actor('ADMIN');
    const before = await prisma.auditEvent.count();
    await run(admin);
    expect(await prisma.auditEvent.count()).toBe(before);
  });
});

/** `count` pessoas ativas no 1º turno, numa gravação só. */
async function bulk(sectorId: string, count: number) {
  const n = ++seq;
  await prisma.user.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      name: `Lote ${n}-${i}`,
      hasAccess: false,
      sectorId,
      shiftId: 'shift_first',
      createdAt: CREATED,
    })),
  });
}

// Por último no arquivo: os setores grandes entram no alcance do ADMIN.
describe('TeamPanoramaService — mais de 2000 pessoas (Postgres real; aceite 3, DJ3)', () => {
  it('aceite 3: alcance com mais de 2000 pessoas responde 200', async () => {
    const [a, b] = [await sector(), await sector()];
    await bulk(a.id, 1100);
    await bulk(b.id, 1100);
    const res = await run(await actor('SUPERVISOR', [a.id, b.id]));
    expect(scope(res)).toEqual({
      [a.id]: [false, 1100],
      [b.id]: [false, 1100],
    });
    expect(inShift(countsOf(res, a.id), 'shift_first')).toBe(1100);
  }, 120_000);

  it('aceite 3: setor sozinho com 2001 — overLimit e counts null; os outros com contagens', async () => {
    const [big, small] = [await sector(), await sector()];
    await bulk(big.id, 2001);
    await bulk(small.id, 3);
    const res = await run(await actor('SUPERVISOR', [big.id, small.id]));
    expect(scope(res)).toEqual({ [big.id]: [true, 0], [small.id]: [false, 3] });
    expect(res.sectors.find((s) => s.sectorId === big.id)?.counts).toBeNull();
  }, 120_000);
});
