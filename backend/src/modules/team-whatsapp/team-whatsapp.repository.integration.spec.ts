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
import {
  NO_SECTOR,
  NO_SHIFT,
  NO_SNAPSHOT,
  PHONE,
} from './team-whatsapp.test-fixtures';

// Um container + `migrate deploy` para o arquivo inteiro (inclui a migração
// 20261016100000_team_whatsapp: FKs SetNull/Cascade de verdade).
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
      },
      {
        userId: author.id,
        userName: 'Autor',
        ...NO_SHIFT,
        status: 'SKIPPED',
        skipReason: 'NO_PHONE',
        ...NO_SECTOR,
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
    const [row] = await repo.listDispatches(author.id);
    expect(row).toMatchObject({
      id: created.id,
      channel: null,
      author: { id: author.id },
    });
    await expect(repo.listDispatches('someone-else')).resolves.toEqual([]);
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
  },
  {
    userId: zeId,
    userName: 'Zé',
    ...NO_SHIFT,
    status: 'SKIPPED',
    skipReason: 'NO_PHONE',
    ...NO_SECTOR,
  },
];

const SECOND = {
  shiftId: 'shift_second',
  shiftName: '2º turno',
  shiftStartTime: '14:00',
  shiftEndTime: '22:00',
};

function linhasEsperadas(
  dispatchId: string,
  recipients: NewTeamDispatchRecipient[],
) {
  return recipients.map((r) => ({
    dispatchId,
    userId: r.userId,
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
  it('createDispatch grava snapshot do turno e listRecipients devolve shiftName', async () => {
    const { prod, joao, ze, channel } = await criarSetorComTurnos();
    const found = await repo.findMembersForDay(prod.id, []);
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
    const [row] = await repo.listDispatches(joao.id);
    expect(row).toMatchObject({ id: created.id, ...SECOND });
    await expect(repo.listRecipients([])).resolves.toEqual([]);
    const rows = await repo.listRecipients([created.id]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(linhasEsperadas(created.id, recipients)),
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
    const found = await repo.findMembersForDay(mnt.id, [caio.id, ivo.id]);
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
  const [row] = await repo.listDispatches(author.id);
  return { created, row };
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
  it('createDispatch grava rosterDate, includeOff e roster; listDispatches devolve', async () => {
    const { created, row } = await criarEnvioDaEscala('com-foto', {
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

    const all = await repo.listScheduled(null);
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
      (await repo.listScheduled([late.sectorId])).map((r) => r.id),
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
    expect((await repo.listScheduled(null)).map((r) => r.id)).not.toContain(
      d.id,
    );
  });
});
