import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  TeamWhatsappRepository,
  type NewTeamDispatch,
  type NewTeamDispatchRecipient,
} from './team-whatsapp.repository';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { dayMembers } from './team-whatsapp.roster';
import {
  NO_CHANNEL,
  NO_SECTOR,
  NO_SHIFT,
  NO_SNAPSHOT,
  PHONE,
} from './team-whatsapp.test-fixtures';

// Um container + `migrate deploy` para o arquivo inteiro (inclui a migração
// 20261016100000_team_whatsapp: FKs SetNull/Cascade de verdade).
const FIRST_PAGE = { page: 1, pageSize: 50 };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('TeamWhatsappRepository — ator e alvo (Postgres real)', () => {
  it('findActor ignora setor desativado em managedSectorIds', async () => {
    const boss = await prisma.user.create({
      data: { email: 'gestor@test.local', password: 'x', role: 'OPERATOR' },
    });
    const s1 = await prisma.sector.create({
      data: { name: 'Ativo', code: 'ATV', managerId: boss.id },
    });
    await prisma.sector.create({
      data: {
        name: 'Inativo',
        code: 'INA',
        managerId: boss.id,
        isActive: false,
      },
    });
    await expect(repo.findActor(boss.id)).resolves.toEqual({
      id: boss.id,
      role: 'OPERATOR',
      isActive: true,
      hasAccess: true,
      managedSectorIds: [s1.id],
    });
    await expect(repo.findActor('missing')).resolves.toBeNull();
  }, 60_000);

  it('findTargetUser traz sector.isActive', async () => {
    const off = await prisma.sector.create({
      data: { name: 'Desligado', code: 'OFF', isActive: false },
    });
    const user = await prisma.user.create({
      data: {
        email: 'alvo@test.local',
        password: 'x',
        sectorId: off.id,
        phoneE164: '+5592991230000',
      },
    });
    await expect(repo.findTargetUser(user.id)).resolves.toMatchObject({
      id: user.id,
      sectorId: off.id,
      sector: { isActive: false },
      phoneE164: '+5592991230000',
      contact: null,
    });
  }, 60_000);
});

// Autor + canal + envio com dois destinatários (QUEUED e SKIPPED).
async function criarEnvioComDoisDestinatarios() {
  const author = await prisma.user.create({
    data: { email: 'autor@test.local', password: 'x' },
  });
  const channel = await prisma.channel.create({
    data: { name: 'Canal equipe', provider: 'GOZAP' },
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'USER',
    targetId: author.id,
    targetLabel: 'Autor',
    ...NO_SNAPSHOT,
    channelId: channel.id,
    text: 'oi',
    sectors: [],
    recipients: [
      {
        userId: author.id,
        userName: 'Autor',
        ...NO_SHIFT,
        status: 'QUEUED',
        skipReason: null,
        ...NO_SECTOR,
        ...NO_CHANNEL,
      },
      {
        userId: author.id,
        userName: 'Autor',
        ...NO_SHIFT,
        status: 'SKIPPED',
        skipReason: 'NO_PHONE',
        ...NO_SECTOR,
        ...NO_CHANNEL,
      },
    ],
  });
  return { author, channel, created };
}

describe('TeamWhatsappRepository — envio e histórico (Postgres real)', () => {
  it('grava, marca falha só nos QUEUED, conta por status e sobrevive à remoção do canal', async () => {
    const { author, channel, created } = await criarEnvioComDoisDestinatarios();
    const ids = created.recipients.map((r) => r.id);
    await expect(
      repo.markFailed(ids, 'team_whatsapp.queue_unavailable'),
    ).resolves.toBe(1);
    const counts = await repo.countByStatus([created.id]);
    expect(counts.sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { dispatchId: created.id, status: 'FAILED', count: 1 },
      { dispatchId: created.id, status: 'SKIPPED', count: 1 },
    ]);
    await prisma.channel.delete({ where: { id: channel.id } });
    const {
      rows: [row],
    } = await repo.listDispatches(author.id, FIRST_PAGE);
    expect(row).toMatchObject({ id: created.id, author: { id: author.id } });
    await expect(
      repo.listDispatches('someone-else', FIRST_PAGE),
    ).resolves.toEqual({ rows: [], total: 0 });
  }, 60_000);
});

// Setor com João (2º turno, migrado pela T1) e Zé (sem turno).
async function criarSetorComTurnos() {
  const prod = await prisma.sector.create({
    data: { name: 'Produção', code: 'PRD' },
  });
  const user = (email: string, name: string, shiftId: string | null) =>
    prisma.user.create({
      data: { email, password: 'x', name, sectorId: prod.id, shiftId },
    });
  const joao = await user('joao@test.local', 'João', 'shift_second');
  const ze = await user('ze@test.local', 'Zé', null);
  const channel = await prisma.channel.create({
    data: { name: 'Canal turno', provider: 'GOZAP' },
  });
  return { prod, joao, ze, channel };
}

const snapshotOf = (
  joaoId: string,
  zeId: string,
): NewTeamDispatchRecipient[] => [
  {
    userId: joaoId,
    userName: 'João',
    shiftId: 'shift_second',
    shiftName: '2º turno',
    status: 'QUEUED',
    skipReason: null,
    ...NO_SECTOR,
    ...NO_CHANNEL,
  },
  {
    userId: zeId,
    userName: 'Zé',
    ...NO_SHIFT,
    status: 'SKIPPED',
    skipReason: 'NO_PHONE',
    ...NO_SECTOR,
    ...NO_CHANNEL,
  },
];

const SECOND = {
  shiftId: 'shift_second',
  shiftName: '2º turno',
  shiftStartTime: '14:00',
  shiftEndTime: '22:00',
};

function linhasEsperadas(recipients: NewTeamDispatchRecipient[]) {
  return recipients.map((r) => ({
    userName: r.userName,
    shiftName: r.shiftName,
    status: r.status,
    errorCode: null,
    skipReason: r.skipReason,
    sectorName: r.sectorName,
    levelName: r.levelName,
  }));
}

describe('TeamWhatsappRepository — turno (Postgres real)', () => {
  it('createDispatch grava snapshot do turno e listDispatchRecipients devolve shiftName', async () => {
    const { prod, joao, ze, channel } = await criarSetorComTurnos();
    const found = await repo.findMembersForDay([prod.id], []);
    expect(found.map((m) => [m.id, m.shiftId, m.workShift])).toEqual([
      [joao.id, 'shift_second', { name: '2º turno' }],
      [ze.id, null, null],
    ]);
    await expect(repo.findSector(prod.id)).resolves.toEqual({
      id: prod.id,
      name: 'Produção',
      isActive: true,
    });
    // Sem `members` (C6): a lista do dia vem de findMembersForDay.
    await expect(repo.listSectors([prod.id])).resolves.toEqual([
      { id: prod.id, name: 'Produção', code: 'PRD' },
    ]);
    const recipients = snapshotOf(joao.id, ze.id);
    const created = await repo.createDispatch({
      authorId: joao.id,
      targetType: 'SECTOR',
      targetId: prod.id,
      targetLabel: 'Produção · 2º turno',
      ...SECOND,
      channelId: channel.id,
      text: 'oi',
      sectors: [{ sectorId: prod.id, sectorName: 'Produção' }],
      recipients,
    });
    const {
      rows: [row],
    } = await repo.listDispatches(joao.id, FIRST_PAGE);
    expect(row).toMatchObject({ id: created.id, ...SECOND });
    const { rows, total } = await repo.listDispatchRecipients(
      created.id,
      FIRST_PAGE,
    );
    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        linhasEsperadas(recipients).map((r): unknown =>
          expect.objectContaining(r),
        ),
      ),
    );
  }, 60_000);
});

describe('TeamWhatsappRepository — turno do filtro (Postgres real)', () => {
  it('listActiveShifts devolve só os turnos ativos, por sortOrder', async () => {
    await prisma.shift.create({
      data: {
        id: 'shift_old',
        name: 'Antigo',
        startTime: '22:00',
        endTime: '06:00',
        isActive: false,
        sortOrder: 9,
      },
    });
    await expect(repo.listActiveShifts()).resolves.toEqual([
      {
        id: 'shift_first',
        name: '1º turno',
        startTime: '06:00',
        endTime: '14:00',
      },
      {
        id: 'shift_second',
        name: '2º turno',
        startTime: '14:00',
        endTime: '22:00',
      },
    ]);
  }, 60_000);
});

// Montagem com Ana (ativa) e uma inativa; Caio, Lia e Ivo (inativo) da Logística.
async function criarSetorComVisitantes() {
  const mnt = await prisma.sector.create({
    data: { name: 'Montagem', code: 'MNT' },
  });
  const log = await prisma.sector.create({
    data: { name: 'Logística', code: 'LGT' },
  });
  const user = (
    email: string,
    data: {
      name: string;
      sectorId: string;
      isActive?: boolean;
      jobTitle?: string;
      levelId?: string;
    },
  ) => prisma.user.create({ data: { email, password: 'x', ...data } });
  const coord = await prisma.staffLevel.create({
    data: { name: 'Coordenador (escala do dia)', sortOrder: 1 },
    select: { id: true, name: true },
  });
  const ana = await user('ana.dia@test.local', {
    name: 'Ana',
    sectorId: mnt.id,
    jobTitle: 'Técnica',
    levelId: coord.id,
  });
  await user('ina.dia@test.local', {
    name: 'Inativa',
    sectorId: mnt.id,
    isActive: false,
  });
  const caio = await user('caio.dia@test.local', {
    name: 'Caio',
    sectorId: log.id,
  });
  await user('lia.dia@test.local', { name: 'Lia', sectorId: log.id });
  const ivo = await user('ivo.dia@test.local', {
    name: 'Ivo',
    sectorId: log.id,
    isActive: false,
  });
  return { mnt, log, ana, caio, ivo, coord };
}

describe('TeamWhatsappRepository — escala do dia (Postgres real)', () => {
  it('findMembersForDay traz os ativos do setor e os visitantes pedidos, sem inativos', async () => {
    const { mnt, log, caio, ivo, coord } = await criarSetorComVisitantes();
    const found = await repo.findMembersForDay([mnt.id], [caio.id, ivo.id]);
    // T8b: o nível vem junto (filtro do envio e `levelName` gravado, C5/C6).
    expect(
      found.map((m) => [m.name, m.jobTitle, m.sectorId, m.levelId, m.level]),
    ).toEqual([
      ['Ana', 'Técnica', mnt.id, coord.id, coord],
      ['Caio', null, log.id, null, null],
    ]);
    // loadDayPeople acha o visitante pela exceção OTHER_SECTOR da data e a carrega.
    const day = new Date('2026-10-21T00:00:00.000Z');
    await prisma.staffScheduleException.create({
      data: {
        userId: caio.id,
        kind: 'OTHER_SECTOR',
        sectorId: mnt.id,
        shiftId: 'shift_first',
        startDate: day,
        endDate: day,
      },
    });
    const people = await repo.loadDayPeople(mnt.id, '2026-10-21');
    expect(
      people.map((p) => [
        p.name,
        p.level,
        p.cycle,
        p.exceptions.map((e) => e.kind),
      ]),
    ).toEqual([
      ['Ana', coord, null, []],
      ['Caio', null, null, ['OTHER_SECTOR']],
    ]);
  }, 60_000);
});

describe('TeamWhatsappRepository — canais elegíveis (Postgres real)', () => {
  it('listEligibleChannels traz só o último evento de conexão do canal', async () => {
    const channel = await prisma.channel.create({
      data: {
        name: 'Canal estado',
        provider: 'EVOLUTION',
        connectionEvents: {
          create: [
            { state: 'open', occurredAt: new Date('2026-10-19T10:00:00Z') },
            { state: 'close', occurredAt: new Date('2026-10-19T11:00:00Z') },
          ],
        },
      },
    });
    const found = (await repo.listEligibleChannels()).find(
      (c) => c.id === channel.id,
    );
    expect(found?.connectionEvents).toEqual([{ state: 'close' }]);
  }, 60_000);
});

// Autor + canal próprios (e-mail único por chamada) e envio a um setor.
async function criarEnvioDaEscala(
  tag: string,
  roster: Partial<
    Pick<NewTeamDispatch, 'rosterDate' | 'includeOff' | 'roster'>
  >,
) {
  const author = await prisma.user.create({
    data: { email: `escala-${tag}@test.local`, password: 'x' },
  });
  const channel = await prisma.channel.create({
    data: { name: `Canal ${tag}`, provider: 'GOZAP' },
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'SECTOR',
    targetId: 'setor',
    targetLabel: 'Produção · 2º turno · 21/10',
    ...SECOND,
    channelId: channel.id,
    text: 'oi',
    sectors: [{ sectorId: 'setor', sectorName: 'Produção' }],
    recipients: [],
    ...roster,
  });
  const row = await prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: created.id },
  });
  const detail = await repo.findDispatchDetail(created.id);
  return { created, row, detail };
}

// Foto sem telefone (GC10): só os campos de C8.
const ROSTER = {
  working: [
    {
      userId: 'u1',
      name: 'Ana',
      jobTitle: 'Operadora',
      shiftName: '2º turno',
      reason: null,
      // T8b (C6): setor em que entrou e nível na hora ficam na foto.
      sectorName: 'Produção',
      levelName: 'Coordenador',
    },
    {
      userId: null,
      name: 'Bia',
      jobTitle: null,
      shiftName: '2º turno',
      reason: null,
    },
  ],
  off: [
    {
      userId: 'u2',
      name: 'Caio',
      jobTitle: null,
      shiftName: null,
      reason: 'VACATION' as const,
    },
  ],
};

describe('TeamWhatsappRepository — foto da escala (Postgres real)', () => {
  it('createDispatch grava rosterDate, includeOff e roster; findDispatchDetail devolve a foto', async () => {
    const { created, row, detail } = await criarEnvioDaEscala('com-foto', {
      rosterDate: '2026-10-21',
      includeOff: true,
      // Telefone em runtime (tipagem estrutural deixa passar): não pode ser gravado.
      roster: {
        working: ROSTER.working.map((p) => ({ ...p, phoneE164: PHONE })),
        off: ROSTER.off,
      },
    });
    expect(row).toMatchObject({ id: created.id, includeOff: true });
    expect(row.roster).toEqual(ROSTER);
    expect(detail?.roster).toEqual(ROSTER);
    expect(JSON.stringify(row.roster)).not.toMatch(/phone|\+55/i);
    expect(row.rosterDate?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  }, 60_000);

  it('createDispatch sem os campos novos grava rosterDate null, includeOff false e roster null', async () => {
    const { created, row } = await criarEnvioDaEscala('sem-foto', {});
    expect(row).toMatchObject({
      id: created.id,
      rosterDate: null,
      includeOff: false,
      roster: null,
    });
  }, 60_000);
});

// Agendado da T8: alvo setor, turno gravado, um SCHEDULED e um SKIPPED.
async function agendar(code: string, scheduledFor: string) {
  const sector = await prisma.sector.create({ data: { name: code, code } });
  const author = await prisma.user.create({
    data: { email: `${code}@test.local`, password: 'x', name: code },
  });
  const channel = await prisma.channel.create({
    data: { name: `Canal ${code}`, provider: 'GOZAP' },
  });
  const recipient = (userName: string): NewTeamDispatchRecipient => ({
    userId: author.id,
    userName,
    ...NO_SHIFT,
    status: 'SCHEDULED',
    skipReason: null,
    sectorId: sector.id,
    sectorName: code,
    levelName: null,
    ...NO_CHANNEL,
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'SECTOR',
    targetId: sector.id,
    targetLabel: `Agendado ${code}`,
    shiftId: 'shift_second',
    shiftName: '2º turno',
    shiftStartTime: '14:00',
    shiftEndTime: '22:00',
    channelId: channel.id,
    text: 'oi',
    rosterDate: '2026-10-21',
    state: 'SCHEDULED',
    scheduledFor: new Date(scheduledFor),
    sectors: [{ sectorId: sector.id, sectorName: code }],
    recipients: [
      recipient('Ana'),
      { ...recipient('Bia'), status: 'SKIPPED', skipReason: 'NO_PHONE' },
    ],
  });
  return { id: created.id, sectorId: sector.id };
}

describe('TeamWhatsappRepository — lista de agendados (Postgres real)', () => {
  it('lista só SCHEDULED por scheduledFor asc, com filtro de setor e contagem dos SCHEDULED', async () => {
    const late = await agendar('AGA', '2026-10-22T02:00:00.000Z');
    const early = await agendar('AGB', '2026-10-21T18:00:00.000Z');

    const { rows: all, total } = await repo.listScheduled(null, FIRST_PAGE);
    expect(total).toBe(2);
    expect(all.map((r) => [r.id, r.recipientCount])).toEqual([
      [early.id, 1],
      [late.id, 1],
    ]);
    expect(all[0]).toMatchObject({
      shiftStartTime: '14:00',
      author: { name: 'AGB' },
      channel: { name: 'Canal AGB' },
    });
    expect(
      (await repo.listScheduled([late.sectorId], FIRST_PAGE)).rows.map(
        (r) => r.id,
      ),
    ).toEqual([late.id]);
    expect(await repo.findDispatchForCancel(late.id)).toEqual({
      id: late.id,
      targetType: 'SECTOR',
      targetId: late.sectorId,
      state: 'SCHEDULED',
      sectorIds: [late.sectorId],
    });
  });
});

describe('TeamWhatsappRepository — cancelamento condicional (Postgres real)', () => {
  it('cancela uma vez só: o 2º cancelScheduled perde (false) e não mexe em nada', async () => {
    const d = await agendar('AGC', '2026-10-23T18:00:00.000Z');
    const now = new Date('2026-10-21T20:00:00.000Z');

    expect(await repo.cancelScheduled(d.id, 'actor-1', now)).toBe(true);
    expect(await repo.cancelScheduled(d.id, 'actor-2', now)).toBe(false);

    const row = await prisma.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: d.id },
      select: { state: true, cancelledAt: true, cancelledById: true },
    });
    expect(row).toEqual({
      state: 'CANCELLED',
      cancelledAt: now,
      cancelledById: 'actor-1',
    });
    const statuses = await prisma.teamWhatsappRecipient.findMany({
      where: { dispatchId: d.id },
      orderBy: { userName: 'asc' },
      select: { status: true },
    });
    expect(statuses.map((r) => r.status)).toEqual(['CANCELLED', 'SKIPPED']);
    const { rows } = await repo.listScheduled(null, FIRST_PAGE);
    expect(rows.map((r) => r.id)).not.toContain(d.id);
  });
});

// D13: autores A (25 envios) e B (3), um canal; e agendados por setor.
async function criarAutorComEnvios(tag: string, total: number) {
  const author = await prisma.user.create({
    data: { email: `pag-${tag}@test.local`, password: 'x' },
  });
  const channel = await prisma.channel.create({
    data: { name: `Canal pag ${tag}`, provider: 'GOZAP' },
  });
  for (let i = 0; i < total; i += 1) {
    await repo.createDispatch({
      authorId: author.id,
      targetType: 'USER',
      targetId: author.id,
      targetLabel: `Envio ${i}`,
      ...NO_SNAPSHOT,
      channelId: channel.id,
      text: 'oi',
      sectors: [],
      recipients: [],
    });
  }
  return author;
}

async function agendarEm(tag: string, sectorIds: string[]) {
  const author = await prisma.user.create({
    data: { email: `agpag-${tag}@test.local`, password: 'x' },
  });
  const channel = await prisma.channel.create({
    data: { name: `Canal agpag ${tag}`, provider: 'GOZAP' },
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'SECTOR',
    targetId: sectorIds[0],
    targetLabel: `Agendado ${tag}`,
    ...NO_SNAPSHOT,
    channelId: channel.id,
    text: 'oi',
    rosterDate: '2026-10-21',
    state: 'SCHEDULED',
    scheduledFor: new Date('2026-10-22T18:00:00.000Z'),
    sectors: sectorIds.map((sectorId) => ({ sectorId, sectorName: sectorId })),
    recipients: [],
  });
  return created.id;
}

describe('TeamWhatsappRepository — paginação (Postgres real)', () => {
  it('histórico: 2ª página só do autor, total e ordem; null traz os de todos', async () => {
    const a = await criarAutorComEnvios('a', 25);
    const b = await criarAutorComEnvios('b', 3);

    const page2 = await repo.listDispatches(a.id, { page: 2, pageSize: 20 });

    expect(page2.total).toBe(25);
    expect(page2.rows).toHaveLength(5);
    expect(page2.rows.every((r) => r.author?.id === a.id)).toBe(true);
    const times = page2.rows.map((r) => r.createdAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    const all = await repo.listDispatches(null, { page: 1, pageSize: 50 });
    expect(all.total).toBe(await prisma.teamWhatsappDispatch.count());
    const mine = all.rows.filter((r) =>
      [a.id, b.id].includes(r.author?.id ?? ''),
    );
    expect(mine).toHaveLength(28);
  }, 120_000);

  it('agendados do gestor de A: só o envio com todos os setores entre os dele', async () => {
    const onlyA = await agendarEm('a', ['pag-a']);
    await agendarEm('ab', ['pag-a', 'pag-b']);
    await agendarEm('b', ['pag-b']);

    const mine = await repo.listScheduled(['pag-a'], { page: 1, pageSize: 20 });

    expect(mine.rows.map((r) => r.id)).toEqual([onlyA]);
    expect(mine.total).toBe(1);
  }, 60_000);
});

// Ana em A, Bia em B e Caio (de A) visitando B na data por OTHER_SECTOR.
async function criarDoisSetoresComVisitante() {
  const [a, b] = await Promise.all(
    ['DIAA', 'DIAB'].map((code) =>
      prisma.sector.create({ data: { name: `Dia ${code}`, code } }),
    ),
  );
  const user = (name: string, sectorId: string) =>
    prisma.user.create({
      data: {
        email: `${name}.rodada@test.local`,
        password: 'x',
        name,
        sectorId,
      },
    });
  await user('Ana', a.id);
  await user('Bia', b.id);
  const caio = await user('Caio', a.id);
  const day = new Date('2026-10-21T00:00:00.000Z');
  await prisma.staffScheduleException.create({
    data: {
      userId: caio.id,
      kind: 'OTHER_SECTOR',
      sectorId: b.id,
      shiftId: 'shift_first',
      startDate: day,
      endDate: day,
    },
  });
  return { a, b };
}

describe('TeamWhatsappRepository — lista do dia em uma rodada (Postgres real)', () => {
  it('loadDayPeopleMany = loadDayPeople por setor, com o visitante em B', async () => {
    const { a, b } = await criarDoisSetoresComVisitante();
    const date = '2026-10-21';

    const many = await repo.loadDayPeopleMany([a.id, b.id], date);

    expect(many.get(a.id)).toEqual(await repo.loadDayPeople(a.id, date));
    expect(many.get(b.id)).toEqual(await repo.loadDayPeople(b.id, date));
    const roster = (sectorId: string) =>
      dayMembers({ sectorId, date, people: many.get(sectorId) ?? [] }).map(
        (m) => [m.name, m.fromOtherSector],
      );
    expect(roster(a.id)).toEqual([['Ana', false]]);
    expect(roster(b.id)).toEqual([
      ['Bia', false],
      ['Caio', true],
    ]);
  }, 60_000);

  it('2000 ativos passam; 2001 → 422 too_many_people, nunca corte silencioso', async () => {
    const big = await prisma.sector.create({
      data: { name: 'Lotado', code: 'LOT' },
    });
    await prisma.user.createMany({
      data: Array.from({ length: 2001 }, (_, i) => ({
        email: `lot${i}@test.local`,
        password: 'x',
        sectorId: big.id,
      })),
    });

    await expect(
      repo.loadDayPeopleMany([big.id], '2026-10-21'),
    ).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.too_many_people',
    });
    await prisma.user.delete({ where: { email: 'lot0@test.local' } });
    const ok = await repo.loadDayPeopleMany([big.id], '2026-10-21');
    expect(ok.get(big.id)).toHaveLength(2000);
  }, 180_000);
});

// Cinco áreas (A..E): duas no canal Evolution, uma em GoZap desligado, uma em Meta, uma sem canal.
async function criarAreasComNumeros() {
  const mk = (name: string, over: object) =>
    prisma.channel.create({
      data: { name, phoneE164: `+55929999${name.length}`, ...over },
    });
  const evo = await mk('Evolution número', {
    provider: 'EVOLUTION',
    evolutionInstanceName: 'inst-numero-area',
  });
  const off = await mk('GoZap desligado', {
    provider: 'GOZAP',
    isActive: false,
  });
  const meta = await mk('Meta fora da equipe', { provider: 'META' });
  const sector = (code: string, channelId: string | null) =>
    prisma.sector.create({
      data: { name: `Área ${code}`, code: `NA${code}`, channelId },
    });
  const [a, b, c, d, e] = await Promise.all([
    sector('A', evo.id),
    sector('B', evo.id),
    sector('C', off.id),
    sector('D', meta.id),
    sector('E', null),
  ]);
  return { evo, a, b, c, d, e };
}

// Pessoa remanejada (OTHER_SECTOR) só no dia 2026-10-21, sem ciclo de escala.
async function criarPessoaRemanejada() {
  const sec = await prisma.sector.create({
    data: { name: 'Área F', code: 'NAF' },
  });
  const user = await prisma.user.create({
    data: { email: 'remanejado@test.local', password: 'x' },
  });
  const day = new Date('2026-10-21T00:00:00.000Z');
  await prisma.staffScheduleException.create({
    data: {
      userId: user.id,
      kind: 'OTHER_SECTOR',
      sectorId: sec.id,
      shiftId: 'shift_first',
      startDate: day,
      endDate: day,
    },
  });
  return { sec, user };
}

describe('TeamWhatsappRepository — número da área e escala da pessoa (Postgres real)', () => {
  it('findSectorChannels: número efetivo por área; inativo, fora do envio e sem canal = null (R2)', async () => {
    const { evo, a, b, c, d, e } = await criarAreasComNumeros();

    const found = await repo.findSectorChannels([
      a.id,
      b.id,
      c.id,
      d.id,
      e.id,
      'nao-existe',
    ]);

    const ref = {
      id: evo.id,
      name: 'Evolution número',
      phoneE164: evo.phoneE164,
      provider: 'EVOLUTION',
      evolutionInstanceName: 'inst-numero-area',
    };
    expect([...found]).toEqual([
      [a.id, ref],
      [b.id, ref],
      [c.id, null],
      [d.id, null],
      [e.id, null],
      ['nao-existe', null],
    ]);
  }, 60_000);

  it('loadPersonSchedule traz as exceções que cruzam a data; sem escala, ciclo null e nada', async () => {
    const { sec, user } = await criarPessoaRemanejada();

    const withEx = await repo.loadPersonSchedule(user.id, '2026-10-21');
    expect(withEx.cycle).toBeNull();
    expect(withEx.exceptions.map((x) => [x.kind, x.sectorId])).toEqual([
      ['OTHER_SECTOR', sec.id],
    ]);
    await expect(
      repo.loadPersonSchedule(user.id, '2026-10-22'),
    ).resolves.toEqual({ cycle: null, exceptions: [] });
  }, 60_000);
});

// Envio sem canal único: um destinatário em cada um de dois números (1111 e 2222).
async function criarEnvioComDoisNumeros() {
  const author = await prisma.user.create({
    data: { email: 'numero@test.local', password: 'x' },
  });
  const [n1111, n2222] = await Promise.all(
    ['1111', '2222'].map((digits) =>
      prisma.channel.create({
        data: {
          name: `Número ${digits}`,
          provider: 'GOZAP',
          phoneE164: `+55929${digits}0000`,
        },
      }),
    ),
  );
  const via = (n: typeof n1111): NewTeamDispatchRecipient => ({
    userId: author.id,
    userName: 'Autor',
    ...NO_SHIFT,
    status: 'QUEUED',
    skipReason: null,
    ...NO_SECTOR,
    channelId: n.id,
    channelName: n.name,
    channelPhoneE164: n.phoneE164,
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'USER',
    targetId: author.id,
    targetLabel: 'Autor',
    ...NO_SNAPSHOT,
    channelId: null,
    text: 'oi',
    sectors: [],
    recipients: [via(n1111), via(n2222)],
  });
  const rows = () =>
    prisma.teamWhatsappRecipient.findMany({
      where: { dispatchId: created.id },
      orderBy: { channelName: 'asc' },
      select: {
        channelId: true,
        channelName: true,
        channelPhoneE164: true,
        dispatch: { select: { channelId: true } },
      },
    });
  return { n1111, n2222, rows };
}

describe('TeamWhatsappRepository — número do destinatário (Postgres real)', () => {
  it('createDispatch grava o canal e o snapshot de cada destinatário, o envio sem canal único, e o snapshot sobrevive à remoção do canal', async () => {
    const { n1111, n2222, rows } = await criarEnvioComDoisNumeros();
    await expect(rows()).resolves.toMatchObject([
      {
        channelId: n1111.id,
        channelName: 'Número 1111',
        channelPhoneE164: '+5592911110000',
        dispatch: { channelId: null },
      },
      { channelId: n2222.id, channelName: 'Número 2222' },
    ]);
    await prisma.channel.delete({ where: { id: n1111.id } });
    await expect(rows()).resolves.toMatchObject([
      { channelId: null, channelName: 'Número 1111' },
      { channelId: n2222.id },
    ]);
  }, 60_000);
});

// Autor (único `userId` válido para os destinatários) + envio ao alvo pessoa com os destinatários dados.
async function criarEnvioParaResultado(
  tag: string,
  build: (author: { id: string }) => NewTeamDispatchRecipient[],
  channelId: string | null = null,
) {
  const author = await prisma.user.create({
    data: { email: `res-${tag}@test.local`, password: 'x' },
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'USER',
    targetId: author.id,
    targetLabel: `Resultado ${tag}`,
    ...NO_SNAPSHOT,
    channelId,
    text: 'oi',
    sectors: [],
    recipients: build(author),
  });
  return { author, id: created.id };
}

const resultRecipient = (
  userId: string,
  userName: string,
  over: Partial<NewTeamDispatchRecipient> = {},
): NewTeamDispatchRecipient => ({
  userId,
  userName,
  ...NO_SHIFT,
  status: 'QUEUED',
  skipReason: null,
  ...NO_SECTOR,
  ...NO_CHANNEL,
  ...over,
});

// Cada nome aparece duas vezes (desempata pelo id); 12 falhas; inseridos de trás para frente.
function criarEnvioPaginado() {
  return criarEnvioParaResultado('pag', (a) =>
    Array.from({ length: 120 }, (_, k) => 119 - k).map((i) =>
      resultRecipient(a.id, `P${String(Math.floor(i / 2)).padStart(3, '0')}`, {
        status: i % 10 === 0 ? 'FAILED' : 'QUEUED',
      }),
    ),
  );
}

describe('TeamWhatsappRepository — resultado: destinatários paginados (Postgres real)', () => {
  it('120 destinatários, pageSize 50, página 3 → 20, por userName e depois id; status filtra e conta', async () => {
    const { id } = await criarEnvioPaginado();

    const page3 = await repo.listDispatchRecipients(id, {
      page: 3,
      pageSize: 50,
    });

    expect(page3.total).toBe(120);
    expect(page3.rows).toHaveLength(20);
    const keys = page3.rows.map((r) => `${r.userName}|${r.id}`);
    expect(keys).toEqual([...keys].sort());
    expect(page3.rows[0].userName).toBe('P050');
    const failed = await repo.listDispatchRecipients(id, {
      status: 'FAILED',
      ...FIRST_PAGE,
    });
    expect(failed.total).toBe(12);
    expect(failed.rows).toHaveLength(12);
    expect(failed.rows.every((r) => r.status === 'FAILED')).toBe(true);
  }, 60_000);

  it('findDispatchForActor traz autor e setores; findDispatchDetail, o texto; inexistente → null', async () => {
    const { author, id } = await criarEnvioParaResultado('det', (a) => [
      resultRecipient(a.id, 'Ana'),
    ]);
    await expect(repo.findDispatchForActor(id)).resolves.toEqual({
      id,
      authorId: author.id,
      targetType: 'USER',
      targetId: author.id,
      state: 'DISPATCHED',
      sectors: [],
    });
    await expect(repo.findDispatchDetail(id)).resolves.toMatchObject({
      id,
      text: 'oi',
      roster: null,
      author: { id: author.id },
    });
    await expect(
      repo.findRecipientUserIds(id, [author.id, 'outro']),
    ).resolves.toEqual([author.id]);
    await expect(repo.findDispatchForActor('missing')).resolves.toBeNull();
    await expect(repo.findDispatchDetail('missing')).resolves.toBeNull();
  }, 60_000);
});

const NEW_STATUSES = [
  'SENT',
  'DELIVERED',
  'READ',
  'REPLIED',
  'UNCERTAIN',
] as const;

// Envio legado: A e B no snapshot do GBR, C sem snapshot (cai no canal do envio), D pulado.
async function criarEnvioLegado() {
  const gbr = await prisma.channel.create({
    data: { name: 'GBR', provider: 'GOZAP', phoneE164: '+5592930001111' },
  });
  const via = {
    channelId: gbr.id,
    channelName: 'GBR',
    channelPhoneE164: gbr.phoneE164,
  };
  const { id } = await criarEnvioParaResultado(
    'leg',
    (a) => [
      resultRecipient(a.id, 'A', via),
      resultRecipient(a.id, 'B', { ...via, status: 'SENT' }),
      resultRecipient(a.id, 'C', { status: 'FAILED' }),
      resultRecipient(a.id, 'D', {
        status: 'SKIPPED',
        skipReason: 'NO_PHONE',
      }),
    ],
    gbr.id,
  );
  return { gbr, id };
}

describe('TeamWhatsappRepository — resultado: contagens e números (Postgres real)', () => {
  it('countByStatus devolve uma linha por situação, inclusive as novas', async () => {
    const { id } = await criarEnvioParaResultado('cnt', (a) =>
      NEW_STATUSES.map((status, i) =>
        resultRecipient(a.id, `N${i}`, { status }),
      ),
    );

    const counts = await repo.countByStatus([id]);

    expect(counts.map((c) => c.status).sort()).toEqual(
      [...NEW_STATUSES].sort(),
    );
    expect(counts.every((c) => c.dispatchId === id && c.count === 1)).toBe(
      true,
    );
  }, 60_000);

  it('envio legado: snapshot do backfill, destinatário sem snapshot cai no canal do envio e pulado fica de fora; canal removido vira null', async () => {
    const { gbr, id } = await criarEnvioLegado();

    await expect(repo.channelsByDispatch([id])).resolves.toEqual([
      { dispatchId: id, name: 'GBR', phoneE164: '+5592930001111', count: 3 },
    ]);
    const { rows } = await repo.listDispatchRecipients(id, FIRST_PAGE);
    expect(rows.map((r) => [r.userName, r.channel?.name ?? null])).toEqual([
      ['A', 'GBR'],
      ['B', 'GBR'],
      ['C', 'GBR'],
      ['D', null],
    ]);
    await expect(repo.channelsByDispatch([])).resolves.toEqual([]);

    await prisma.channel.delete({ where: { id: gbr.id } });
    await expect(repo.channelsByDispatch([id])).resolves.toEqual([
      { dispatchId: id, name: 'GBR', phoneE164: '+5592930001111', count: 2 },
      { dispatchId: id, name: null, phoneE164: null, count: 1 },
    ]);
    const after = await repo.listDispatchRecipients(id, FIRST_PAGE);
    expect(after.rows.map((r) => [r.userName, r.channel])).toEqual([
      ['A', { name: 'GBR', phoneE164: '+5592930001111' }],
      ['B', { name: 'GBR', phoneE164: '+5592930001111' }],
      ['C', { name: null, phoneE164: null }],
      ['D', null],
    ]);
  }, 60_000);
});
