import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PrismaClient,
  type TeamSchedulePolicy,
  type User,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { toDbDate } from '../staff-schedule/civil-date';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import {
  SCHEDULE_GRACE_MS,
  type LateJoinedPerson,
  type RecheckPlan,
  type RecheckSkipReason,
} from './scheduled-recheck';
import {
  RecheckPlanContractError,
  TeamWhatsappRepository,
  type NewTeamDispatchRecipient,
  type RecheckFn,
} from './team-whatsapp.repository';

// Lote G, T5: claim do agendado com reconferência, teto de 2 h e vencimento,
// contra Postgres real (GG4, DG2, DG5, DG6). Concorrência por chamadas reais em
// paralelo (`Promise.all`), nunca por mock do repositório. Um container só.
const NOW = new Date('2026-10-21T12:00:00.000Z');
const DUE = new Date(NOW.getTime() - 60_000);
const ROSTER_DATE = '2026-10-21';
const RULE = {
  shifts: null,
  levels: [],
  withoutLevel: false,
  selectedUserIds: null,
};
// Acima do `timeout` padrão (5 s) da transação interativa do Prisma.
const SLOW_MS = 6_000;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** `noPhone` = linha já SKIPPED NO_PHONE na criação (não é da reconferência). */
type Person = { name: string; isActive?: boolean; noPhone?: boolean };
type SeedInput = {
  scheduledFor?: Date;
  policy?: TeamSchedulePolicy | null;
  people?: Person[];
  channelActive?: boolean;
};
const ABC: Person[] = [{ name: 'Ana' }, { name: 'Bia' }, { name: 'Caio' }];

let seq = 0;

/** Uma pessoa (ativa ou não) por destinatário, no setor do agendado. */
function createPeople(code: string, sectorId: string, people: Person[]) {
  return Promise.all(
    people.map((p, i) =>
      prisma.user.create({
        data: {
          email: `${code}-${i}@test.local`,
          password: 'x',
          name: p.name,
          isActive: p.isActive ?? true,
          sectorId,
        },
      }),
    ),
  );
}

/** Linha do destinatário: SCHEDULED, ou SKIPPED NO_PHONE com `noPhone`. */
const rowOf = (user: User, person: Person) => ({
  userId: user.id,
  userName: user.name ?? '',
  status: person.noPhone ? ('SKIPPED' as const) : ('SCHEDULED' as const),
  skipReason: person.noPhone ? ('NO_PHONE' as const) : null,
});

/** Agendado de um setor, com um destinatário por pessoa (ordem = nome). */
async function seed({
  scheduledFor = DUE,
  policy = 'FROZEN_RECHECK',
  people = ABC,
  channelActive = true,
}: SeedInput = {}) {
  const code = `T5-${++seq}`;
  const sector = await prisma.sector.create({ data: { name: code, code } });
  const admin = await prisma.user.create({
    data: { email: `${code}-adm@test.local`, password: 'x', role: 'ADMIN' },
  });
  const channel = await prisma.channel.create({
    data: { name: code, provider: 'EVOLUTION', isActive: channelActive },
  });
  const users = await createPeople(code, sector.id, people);
  const created = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId: admin.id,
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: code,
      channelId: channel.id,
      text: 'oi',
      state: 'SCHEDULED',
      scheduledFor,
      schedulePolicy: policy,
      audienceBase: 'ON_DUTY',
      rosterDate: toDbDate(ROSTER_DATE),
      audienceRule: RULE,
      sectors: { create: [{ sectorId: sector.id, sectorName: code }] },
      recipients: { create: users.map((u, i) => rowOf(u, people[i])) },
    },
    select: {
      id: true,
      recipients: { select: { id: true }, orderBy: { userName: 'asc' } },
    },
  });
  return {
    id: created.id,
    code,
    sectorId: sector.id,
    adminId: admin.id,
    rows: created.recipients.map((r) => r.id),
    userIds: users.map((u) => u.id),
  };
}

const rowsOf = (dispatchId: string) =>
  prisma.teamWhatsappRecipient.findMany({
    where: { dispatchId },
    orderBy: { userName: 'asc' },
    select: { id: true, status: true, skipReason: true, errorCode: true },
  });
const statusesOf = async (dispatchId: string) =>
  (await rowsOf(dispatchId)).map((r) => r.status);
const dispatchOf = (id: string) =>
  prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id },
    select: {
      state: true,
      firedAt: true,
      recheckedAt: true,
      audienceLateJoined: true,
    },
  });

const NO_SKIPS: RecheckPlan = { skips: [], lateJoined: [] };
const planOf = (
  skips: [string, RecheckSkipReason][],
  lateJoined: LateJoinedPerson[] = [],
): RecheckPlan => ({
  skips: skips.map(([recipientId, reason]) => ({ recipientId, reason })),
  lateJoined,
});
/** Reconferência que demora `ms` e devolve `plan` (espião). */
const slowRecheck = (ms: number, plan: RecheckPlan = NO_SKIPS) =>
  vi.fn<RecheckFn>(async () => {
    await sleep(ms);
    return plan;
  });
const failingRecheck = (ms: number) =>
  vi.fn<RecheckFn>(async () => {
    await sleep(ms);
    throw new Error('reconferência falhou');
  });
const sorted = (ids: readonly string[]) =>
  [...ids].sort((a, b) => a.localeCompare(b));

const LATE: LateJoinedPerson = {
  userId: 'u-late',
  name: 'Pessoa Nova',
  sectorId: 's-late',
  sectorName: 'Setor Novo',
  shiftName: '1º turno',
  levelName: null,
};

describe('claim concorrente (GG4)', () => {
  it('dois claims concorrentes: um vence e a reconferência roda uma vez', async () => {
    const d = await seed();
    const recheck = slowRecheck(200);
    const results = await Promise.all([
      repo.claimScheduled(d.id, NOW, recheck),
      repo.claimScheduled(d.id, NOW, recheck),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    const won = results.find((r) => r !== null);
    expect(sorted(won?.queuedIds ?? [])).toEqual(sorted(d.rows));
    expect(won?.rechecked).toEqual({ skipped: 0, lateJoined: 0 });
    expect(await dispatchOf(d.id)).toEqual({
      state: 'DISPATCHED',
      firedAt: NOW,
      recheckedAt: NOW,
      audienceLateJoined: [],
    });
    expect(await statusesOf(d.id)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  }, 60_000);
});

describe('erro na reconferência desfaz tudo (GG4, DG2)', () => {
  it('reconferência que lança: envio SCHEDULED sem firedAt, destinatários iguais, recheckedAt nulo; o claim seguinte vence', async () => {
    const d = await seed();
    const before = await rowsOf(d.id);
    await expect(
      repo.claimScheduled(d.id, NOW, failingRecheck(0)),
    ).rejects.toThrow('reconferência falhou');
    const untouched = {
      state: 'SCHEDULED',
      firedAt: null,
      recheckedAt: null,
      audienceLateJoined: null,
    };
    expect(await dispatchOf(d.id)).toEqual(untouched);
    expect(await rowsOf(d.id)).toEqual(before);
    // Falha depois dos pulos gravados (lista "entraram depois" fora do contrato).
    const invalid = planOf(
      [[d.rows[0], 'VACATION']],
      [{ userId: 'x' } as never],
    );
    await expect(
      repo.claimScheduled(d.id, NOW, slowRecheck(0, invalid)),
    ).rejects.toThrow();
    expect(await dispatchOf(d.id)).toEqual(untouched);
    expect(await rowsOf(d.id)).toEqual(before);
    const next = await repo.claimScheduled(d.id, NOW, slowRecheck(0));
    expect(sorted(next?.queuedIds ?? [])).toEqual(sorted(d.rows));
  }, 60_000);
});

describe('lista "entraram depois" fora do contrato (GG4, GG8)', () => {
  it('o erro leva o id do envio e caminho/código dos issues, nunca o valor recebido nem o ZodError', async () => {
    const d = await seed();
    const received = 987_654_321;
    const invalid = planOf(
      [],
      [{ ...LATE, name: received, sectorName: 'Setor Secreto' } as never],
    );

    const err = (await repo
      .claimScheduled(d.id, NOW, slowRecheck(0, invalid))
      .catch((e: unknown) => e)) as RecheckPlanContractError;

    expect(err).toBeInstanceOf(RecheckPlanContractError);
    expect(err.dispatchId).toBe(d.id);
    expect(err.issues).toEqual([{ path: '0.name', code: 'invalid_type' }]);
    expect(err.message).toBe(
      `Reconferência do agendado ${d.id} fora do contrato: 0.name:invalid_type`,
    );
    expect(err).not.toHaveProperty('cause');
    const seen = JSON.stringify([err.message, err.stack, { ...err }]);
    expect(seen).not.toContain(String(received));
    expect(seen).not.toContain('Setor Secreto');
    expect(seen).not.toContain('received');
  }, 60_000);
});

describe('só linhas SCHEDULED (GG4)', () => {
  it('só linhas SCHEDULED mudam; nenhuma é inserida', async () => {
    const d = await seed({ people: [...ABC, { name: 'Davi', noPhone: true }] });
    const other = await seed();
    const [, bia, , davi] = d.rows;
    const recheck = slowRecheck(
      0,
      planOf(
        [
          [davi, 'VACATION'],
          [bia, 'DAY_OFF'],
          [other.rows[0], 'LEFT_SECTOR'],
        ],
        [LATE],
      ),
    );
    const result = await repo.claimScheduled(d.id, NOW, recheck);
    expect(result?.rechecked).toEqual({ skipped: 1, lateJoined: 1 });
    expect(await rowsOf(d.id)).toEqual([
      { id: d.rows[0], status: 'QUEUED', skipReason: null, errorCode: null },
      { id: bia, status: 'SKIPPED', skipReason: 'DAY_OFF', errorCode: null },
      { id: d.rows[2], status: 'QUEUED', skipReason: null, errorCode: null },
      { id: davi, status: 'SKIPPED', skipReason: 'NO_PHONE', errorCode: null },
    ]);
    expect(await statusesOf(other.id)).toEqual([
      'SCHEDULED',
      'SCHEDULED',
      'SCHEDULED',
    ]);
    // A reconferência recebe a lista congelada só com as SCHEDULED e os
    // usuários de todas as linhas.
    const [claimed] = recheck.mock.calls[0];
    expect(claimed).toMatchObject({
      id: d.id,
      schedulePolicy: 'FROZEN_RECHECK',
      audienceBase: 'ON_DUTY',
      includeOff: false,
      rosterDate: ROSTER_DATE,
      sectors: [{ id: d.sectorId, name: d.code }],
      audienceRule: RULE,
    });
    expect(sorted(claimed.frozen.map((f) => f.id))).toEqual(
      sorted(d.rows.slice(0, 3)),
    );
    expect(claimed.frozen.every((f) => f.userActive)).toBe(true);
    expect(sorted(claimed.recipientUserIds)).toEqual(sorted(d.userIds));
  }, 60_000);
});

describe('ordem dos passos e gravação da reconferência (DG2)', () => {
  it('aplica os pulos antes de failUnavailable: canal inativo e férias — SKIPPED VACATION, não FAILED', async () => {
    const d = await seed({ channelActive: false });
    const plan = planOf([[d.rows[0], 'VACATION']]);
    const result = await repo.claimScheduled(d.id, NOW, slowRecheck(0, plan));
    expect(result).toEqual({
      queuedIds: [],
      skipped: 0,
      failed: 2,
      rechecked: { skipped: 1, lateJoined: 0 },
    });
    const unavailable = 'team_whatsapp.channel_unavailable';
    expect(await rowsOf(d.id)).toEqual([
      {
        id: d.rows[0],
        status: 'SKIPPED',
        skipReason: 'VACATION',
        errorCode: null,
      },
      {
        id: d.rows[1],
        status: 'FAILED',
        skipReason: null,
        errorCode: unavailable,
      },
      {
        id: d.rows[2],
        status: 'FAILED',
        skipReason: null,
        errorCode: unavailable,
      },
    ]);
  }, 60_000);

  it('grava recheckedAt e audienceLateJoined sem telefone', async () => {
    const d = await seed();
    const phone = '+5592991110009';
    const withPhone = { ...LATE, phone } as LateJoinedPerson;
    const result = await repo.claimScheduled(
      d.id,
      NOW,
      slowRecheck(0, planOf([], [withPhone])),
    );
    expect(result?.rechecked).toEqual({ skipped: 0, lateJoined: 1 });
    const saved = await dispatchOf(d.id);
    expect(saved.recheckedAt).toEqual(NOW);
    expect(saved.audienceLateJoined).toEqual([LATE]);
    expect(JSON.stringify(saved.audienceLateJoined)).not.toContain(phone);
  }, 60_000);
});

describe('política do agendado (DG6)', () => {
  it('FROZEN_RECHECK sem função: lança e nada muda', async () => {
    const d = await seed();
    await expect(repo.claimScheduled(d.id, NOW)).rejects.toThrow(d.id);
    expect(await dispatchOf(d.id)).toEqual({
      state: 'SCHEDULED',
      firedAt: null,
      recheckedAt: null,
      audienceLateJoined: null,
    });
    expect(await statusesOf(d.id)).toEqual([
      'SCHEDULED',
      'SCHEDULED',
      'SCHEDULED',
    ]);
  }, 60_000);

  it('aceite 27: política nula dispara pela regra antiga sem chamar a função', async () => {
    const people = [{ name: 'Ana' }, { name: 'Bia', isActive: false }];
    const d = await seed({ policy: null, people });
    const recheck = slowRecheck(0);
    const result = await repo.claimScheduled(d.id, NOW, recheck);
    expect(recheck).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedIds: [d.rows[0]],
      skipped: 1,
      failed: 0,
      rechecked: null,
    });
    expect(await dispatchOf(d.id)).toMatchObject({
      state: 'DISPATCHED',
      recheckedAt: null,
      audienceLateJoined: null,
    });
  }, 60_000);
});

describe('teto de 2 h na condição do claim (DG5)', () => {
  it('exatamente 2 h de atraso: claim vence; 2 h e 1 ms: claim null', async () => {
    const exact = await seed({
      scheduledFor: new Date(NOW.getTime() - SCHEDULE_GRACE_MS),
    });
    const late = await seed({
      scheduledFor: new Date(NOW.getTime() - SCHEDULE_GRACE_MS - 1),
    });
    const recheck = slowRecheck(0);
    expect(await repo.claimScheduled(exact.id, NOW, recheck)).not.toBeNull();
    expect(await repo.claimScheduled(late.id, NOW, recheck)).toBeNull();
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(await dispatchOf(late.id)).toMatchObject({
      state: 'SCHEDULED',
      firedAt: null,
    });
  }, 60_000);
});

describe('vencimento (DG5)', () => {
  it('expireScheduled: EXPIRED e destinatários SKIPPED EXPIRED', async () => {
    const people = [
      { name: 'Ana' },
      { name: 'Bia' },
      { name: 'Davi', noPhone: true },
    ];
    const d = await seed({ scheduledFor: hoursBefore(3), people });
    const edge = await seed({
      scheduledFor: new Date(NOW.getTime() - SCHEDULE_GRACE_MS),
    });
    expect(await repo.expireScheduled(edge.id, NOW)).toBeNull();
    expect(await repo.expireScheduled(d.id, NOW)).toEqual({ skipped: 2 });
    expect((await dispatchOf(d.id)).state).toBe('EXPIRED');
    const expired = { status: 'SKIPPED', skipReason: 'EXPIRED' };
    expect(await rowsOf(d.id)).toMatchObject([
      expired,
      expired,
      { status: 'SKIPPED', skipReason: 'NO_PHONE' },
    ]);
    expect(await repo.expireScheduled(d.id, NOW)).toBeNull();
    expect((await dispatchOf(edge.id)).state).toBe('SCHEDULED');
  }, 60_000);

  it('envio já disparado ou cancelado não muda', async () => {
    const fired = await seed({ scheduledFor: hoursBefore(3) });
    const cancelled = await seed({ scheduledFor: hoursBefore(3) });
    const fireAt = hoursBefore(3);
    expect(
      await repo.claimScheduled(fired.id, fireAt, slowRecheck(0)),
    ).not.toBeNull();
    expect(
      await repo.cancelScheduled(cancelled.id, cancelled.adminId, fireAt),
    ).toBe(true);
    expect(await repo.expireScheduled(fired.id, NOW)).toBeNull();
    expect(await repo.expireScheduled(cancelled.id, NOW)).toBeNull();
    expect((await dispatchOf(fired.id)).state).toBe('DISPATCHED');
    expect(await statusesOf(fired.id)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    expect((await dispatchOf(cancelled.id)).state).toBe('CANCELLED');
    expect(await statusesOf(cancelled.id)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
  }, 60_000);
});

/**
 * Uma rodada: claim (no limite exato do teto, reconferência de 100 ms) e
 * vencimento (1 ms depois do teto) do mesmo agendado ao mesmo tempo.
 */
async function raceClaimAndExpire(claimDelayMs: number, expireDelayMs: number) {
  const d = await seed({
    scheduledFor: new Date(NOW.getTime() - SCHEDULE_GRACE_MS),
  });
  const recheck = slowRecheck(100);
  const [claim, expired] = await Promise.all([
    sleep(claimDelayMs).then(() => repo.claimScheduled(d.id, NOW, recheck)),
    sleep(expireDelayMs).then(() =>
      repo.expireScheduled(d.id, new Date(NOW.getTime() + 1)),
    ),
  ]);
  return {
    winner: [claim && 'claim', expired && 'expire'].filter(Boolean),
    rechecks: recheck.mock.calls.length,
    state: (await dispatchOf(d.id)).state,
    rows: (await rowsOf(d.id)).map((r) => `${r.status}:${r.skipReason}`),
  };
}

const CLAIM_WON = {
  winner: ['claim'],
  rechecks: 1,
  state: 'DISPATCHED',
  rows: ['QUEUED:null', 'QUEUED:null', 'QUEUED:null'],
};
const EXPIRE_WON = {
  winner: ['expire'],
  rechecks: 0,
  state: 'EXPIRED',
  rows: ['SKIPPED:EXPIRED', 'SKIPPED:EXPIRED', 'SKIPPED:EXPIRED'],
};

describe('claim e vencimento concorrentes (DG5)', () => {
  it('claim e vencimento concorrentes em torno do teto: no máximo um vence', async () => {
    // [claim, vencimento] em ms: só variam a ordem de chegada. Quem vence
    // depende do relógio da máquina (com carga, 50 ms de folga não garantem a
    // ordem), então cada rodada é conferida por coerência, nunca pelo vencedor.
    const delays = [
      [0, 50],
      [50, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    const outcomes: Awaited<ReturnType<typeof raceClaimAndExpire>>[] = [];
    for (const [claimDelay, expireDelay] of delays) {
      outcomes.push(await raceClaimAndExpire(claimDelay, expireDelay));
    }
    // Por rodada: exatamente um vence, o estado final é o de quem venceu e as
    // três linhas continuam as mesmas (nenhuma duplicada nem fora do estado).
    for (const outcome of outcomes) {
      expect(['DISPATCHED', 'EXPIRED']).toContain(outcome.state);
      expect(outcome).toEqual(
        outcome.state === 'EXPIRED' ? EXPIRE_WON : CLAIM_WON,
      );
    }
  }, 120_000);
});

/** Destinatário do envio gravado pelo repositório; sem `phone` = campo ausente. */
const newRecipient = (
  userId: string,
  userName: string,
  phone?: string,
): NewTeamDispatchRecipient => ({
  userId,
  userName,
  shiftId: null,
  shiftName: null,
  status: 'SCHEDULED',
  skipReason: null,
  channelId: null,
  channelName: null,
  channelPhoneE164: null,
  sectorId: null,
  sectorName: null,
  levelName: null,
  ...(phone === undefined ? {} : { phoneE164: phone }),
});

describe('gravação do envio (DG6, DG7)', () => {
  it('grava schedulePolicy e phoneE164 quando passados', async () => {
    const sector = await prisma.sector.create({
      data: { name: 'T5 gravação', code: 'T5-GRAVA' },
    });
    const author = await prisma.user.create({
      data: { email: 't5-grava@test.local', password: 'x' },
    });
    const recipients = [
      newRecipient(author.id, 'Ana', '+5592991110001'),
      newRecipient(author.id, 'Bia'),
    ];
    const { id } = await repo.createDispatch({
      authorId: author.id,
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: sector.name,
      shiftId: null,
      shiftName: null,
      shiftStartTime: null,
      shiftEndTime: null,
      channelId: null,
      text: 'oi',
      sectors: [{ sectorId: sector.id, sectorName: sector.name }],
      recipients,
      state: 'SCHEDULED',
      scheduledFor: DUE,
      schedulePolicy: 'FROZEN_RECHECK',
    });
    const saved = await prisma.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id },
      select: {
        schedulePolicy: true,
        recipients: {
          select: { phoneE164: true },
          orderBy: { userName: 'asc' },
        },
      },
    });
    expect(saved).toEqual({
      schedulePolicy: 'FROZEN_RECHECK',
      recipients: [{ phoneE164: '+5592991110001' }, { phoneE164: null }],
    });
  }, 60_000);
});

describe('cancelamento durante a reconferência (DG2)', () => {
  it('cancelar durante uma reconferência lenta (6 s) devolve false e o envio fica DISPATCHED, sem P2028', async () => {
    const d = await seed();
    const [claim, cancelled] = await Promise.all([
      repo.claimScheduled(d.id, NOW, slowRecheck(SLOW_MS)),
      sleep(200).then(() => repo.cancelScheduled(d.id, d.adminId, NOW)),
    ]);
    expect(sorted(claim?.queuedIds ?? [])).toEqual(sorted(d.rows));
    expect(cancelled).toBe(false);
    expect((await dispatchOf(d.id)).state).toBe('DISPATCHED');
    // Reconferência que lança depois de 6 s: o claim se desfaz e o
    // cancelamento, que esperava o lock, vence.
    const e = await seed();
    const [failed, cancelledAfter] = await Promise.allSettled([
      repo.claimScheduled(e.id, NOW, failingRecheck(SLOW_MS)),
      sleep(200).then(() => repo.cancelScheduled(e.id, e.adminId, NOW)),
    ]);
    expect(failed.status).toBe('rejected');
    expect(cancelledAfter).toEqual({ status: 'fulfilled', value: true });
    expect(await dispatchOf(e.id)).toMatchObject({
      state: 'CANCELLED',
      firedAt: null,
      recheckedAt: null,
    });
    expect(await statusesOf(e.id)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
  }, 60_000);
});
