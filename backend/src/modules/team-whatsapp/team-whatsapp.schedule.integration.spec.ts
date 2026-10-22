import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient, type User } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';

// Disparo agendado (T9) contra Postgres real: o claim por `updateMany`
// condicional decide sozinho entre dois disparos e entre disparo e cancelamento.
// Fila e auditoria são dublês; serviço e repositório são os de verdade.
const NOW = new Date('2026-10-21T12:00:00.000Z');
const MINUTE = 60_000;
const DUE = new Date(NOW.getTime() - MINUTE);

type BulkJob = {
  name: string;
  data: TeamWhatsappSendJob;
  opts: { jobId: string };
};
const queue = { addBulk: vi.fn<(jobs: BulkJob[]) => Promise<unknown>>() };
const audit = { log: vi.fn() };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: TeamWhatsappScheduleService;

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
  const repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
  service = new TeamWhatsappScheduleService(
    repo,
    audit as never,
    queue as never,
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

beforeEach(() => {
  queue.addBulk.mockReset().mockResolvedValue([]);
  audit.log.mockReset();
});

type SeedPerson = { name: string; isActive?: boolean };
type SeedInput = {
  prisma: PrismaClient;
  scheduledFor: Date;
  recipients?: SeedPerson[];
  channelActive?: boolean;
};

let seq = 0;

/** Uma pessoa ativa (ou não) por destinatário, no setor do agendado. */
function createPeople(
  db: PrismaClient,
  code: string,
  sectorId: string,
  people: SeedPerson[],
): Promise<User[]> {
  return Promise.all(
    people.map((p, i) =>
      db.user.create({
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

/** Agendado para um setor ativo, por um ADMIN, com um destinatário SCHEDULED por pessoa. */
async function seedScheduled({
  prisma: db,
  scheduledFor,
  recipients = [{ name: 'Ana' }, { name: 'Bia' }, { name: 'Caio' }],
  channelActive = true,
}: SeedInput) {
  const code = `T9-${++seq}`;
  const sector = await db.sector.create({ data: { name: code, code } });
  const admin = await db.user.create({
    data: { email: `${code}-adm@test.local`, password: 'x', role: 'ADMIN' },
  });
  const channel = await db.channel.create({
    data: { name: `Canal ${code}`, provider: 'GOZAP', isActive: channelActive },
  });
  const users = await createPeople(db, code, sector.id, recipients);
  const created = await db.teamWhatsappDispatch.create({
    data: {
      authorId: admin.id,
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: code,
      channelId: channel.id,
      text: 'oi',
      state: 'SCHEDULED',
      scheduledFor,
      recipients: {
        create: users.map((u) => ({
          userId: u.id,
          userName: u.name ?? '',
          status: 'SCHEDULED' as const,
        })),
      },
    },
    select: {
      id: true,
      recipients: { select: { id: true }, orderBy: { userName: 'asc' } },
    },
  });
  return {
    id: created.id,
    adminId: admin.id,
    channelId: channel.id,
    recipientIds: created.recipients.map((r) => r.id),
    userIds: users.map((u) => u.id),
  };
}

const recipientsOf = (dispatchId: string) =>
  prisma.teamWhatsappRecipient.findMany({
    where: { dispatchId },
    orderBy: { userName: 'asc' },
    select: { status: true, skipReason: true, errorCode: true },
  });
const statusesOf = async (dispatchId: string) =>
  (await recipientsOf(dispatchId)).map((r) => r.status);
const dispatchOf = (id: string) =>
  prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id },
    select: { state: true, firedAt: true },
  });
/** Jobs enviados à fila (todas as chamadas), por jobId. */
const jobsSent = () =>
  queue.addBulk.mock.calls
    .flatMap(([jobs]) => jobs)
    .sort((a, b) => a.opts.jobId.localeCompare(b.opts.jobId));
const jobsFor = (ids: readonly string[]) =>
  [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      name: 'send',
      data: { recipientId: id },
      opts: { jobId: id },
    }));

describe('disparo idempotente', () => {
  it('dois disparos concorrentes: um só enfileira', async () => {
    const d = await seedScheduled({ prisma, scheduledFor: DUE });
    const results = await Promise.all([
      service.fireOne(d.id, NOW),
      service.fireOne(d.id, NOW),
    ]);
    expect([...results].sort()).toEqual(['fired', 'skipped']);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(jobsSent()).toEqual(jobsFor(d.recipientIds));
    expect(await dispatchOf(d.id)).toEqual({
      state: 'DISPATCHED',
      firedAt: NOW,
    });
  }, 60_000);

  it('cancelado não dispara', async () => {
    const d = await seedScheduled({ prisma, scheduledFor: DUE });
    await service.cancel(d.adminId, d.id);
    await expect(service.fireOne(d.id, NOW)).resolves.toBe('skipped');
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(await statusesOf(d.id)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
  });

  it('disparado não cancela', async () => {
    const d = await seedScheduled({ prisma, scheduledFor: DUE });
    await expect(service.fireOne(d.id, NOW)).resolves.toBe('fired');
    await expect(service.cancel(d.adminId, d.id)).rejects.toMatchObject({
      code: 'team_whatsapp.not_cancellable',
      status: 409,
    });
    expect(await statusesOf(d.id)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma rodada: disparo e cancelamento ao mesmo tempo; resume quem venceu e o
 * estado final. O cancelamento faz 2 leituras antes do claim, então o disparo
 * sai `fireDelayMs` depois para que as rodadas cubram as duas vitórias.
 */
async function raceFireAndCancel(fireDelayMs: number) {
  queue.addBulk.mockClear();
  const d = await seedScheduled({ prisma, scheduledFor: DUE });
  const [fire, cancel] = await Promise.allSettled([
    sleep(fireDelayMs).then(() => service.fireOne(d.id, NOW)),
    service.cancel(d.adminId, d.id),
  ]);
  return {
    fire: fire.status === 'fulfilled' ? fire.value : 'rejected',
    cancel:
      cancel.status === 'fulfilled'
        ? 'fulfilled'
        : (cancel.reason as { code?: string }).code,
    state: (await dispatchOf(d.id)).state,
    statuses: await statusesOf(d.id),
    jobs: jobsSent().length,
  };
}

const CANCEL_WON = {
  fire: 'skipped',
  cancel: 'fulfilled',
  state: 'CANCELLED',
  statuses: ['CANCELLED', 'CANCELLED', 'CANCELLED'],
  jobs: 0,
};
const FIRE_WON = {
  fire: 'fired',
  cancel: 'team_whatsapp.not_cancellable',
  state: 'DISPATCHED',
  statuses: ['QUEUED', 'QUEUED', 'QUEUED'],
  jobs: 3,
};

describe('disparo idempotente — corrida com o cancelamento', () => {
  it('cancelar e disparar concorrentes: estado final coerente', async () => {
    for (let round = 0; round < 20; round++) {
      const outcome = await raceFireAndCancel(round % 10);
      // Exatamente um vence: o estado final decide qual dos dois quadros vale.
      expect(outcome).toEqual(
        outcome.state === 'CANCELLED' ? CANCEL_WON : FIRE_WON,
      );
    }
  }, 120_000);
});

describe('hora do disparo', () => {
  it('antes da hora não dispara', async () => {
    const d = await seedScheduled({
      prisma,
      scheduledFor: new Date(NOW.getTime() + MINUTE),
    });
    await expect(service.fireOne(d.id, NOW)).resolves.toBe('skipped');
    expect(await dispatchOf(d.id)).toEqual({
      state: 'SCHEDULED',
      firedAt: null,
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it('worker fora: vencido há 3 h dispara no próximo tick com firedAt = now', async () => {
    // Relógio um dia antes dos outros casos: só este agendado está vencido.
    const tick = new Date(NOW.getTime() - 24 * 60 * MINUTE);
    const d = await seedScheduled({
      prisma,
      scheduledFor: new Date(tick.getTime() - 3 * 60 * MINUTE),
    });
    await expect(service.fireDue(tick)).resolves.toEqual({ fired: 1 });
    expect(await dispatchOf(d.id)).toEqual({
      state: 'DISPATCHED',
      firedAt: tick,
    });
    expect(jobsSent()).toEqual(jobsFor(d.recipientIds));
  });
});

describe('condições na hora — canal', () => {
  it.each([
    ['inativo', false],
    ['inexistente', true],
  ])(
    'canal %s → FAILED team_whatsapp.channel_unavailable e nenhum job',
    async (_, remove) => {
      const d = await seedScheduled({
        prisma,
        scheduledFor: DUE,
        channelActive: false,
      });
      if (remove) await prisma.channel.delete({ where: { id: d.channelId } });
      await expect(service.fireOne(d.id, NOW)).resolves.toBe('fired');
      expect(queue.addBulk).not.toHaveBeenCalled();
      expect(await recipientsOf(d.id)).toEqual(
        Array(3).fill({
          status: 'FAILED',
          skipReason: null,
          errorCode: 'team_whatsapp.channel_unavailable',
        }),
      );
    },
  );
});

describe('condições na hora — pessoas', () => {
  it('usuário inativo → SKIPPED INACTIVE; os outros enfileirados', async () => {
    const d = await seedScheduled({
      prisma,
      scheduledFor: DUE,
      recipients: [
        { name: 'Ana' },
        { name: 'Bia', isActive: false },
        { name: 'Caio' },
      ],
    });
    // Caio foi apagado depois do agendamento (userId vira null): também INACTIVE.
    await prisma.user.delete({ where: { id: d.userIds[2] } });
    await expect(service.fireOne(d.id, NOW)).resolves.toBe('fired');
    expect(
      (await recipientsOf(d.id)).map((r) => [r.status, r.skipReason]),
    ).toEqual([
      ['QUEUED', null],
      ['SKIPPED', 'INACTIVE'],
      ['SKIPPED', 'INACTIVE'],
    ]);
    expect(jobsSent()).toEqual(jobsFor([d.recipientIds[0]]));
    expect(audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.scheduled_fire',
        'TeamWhatsappDispatch',
        d.id,
        { dispatchId: d.id, queued: 1, skipped: 2, failed: 0 },
      ],
    ]);
  });
});
