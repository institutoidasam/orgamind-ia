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
import { PrismaClient, type TeamWhatsappRecipientStatus } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import { isRepeatable } from './team-whatsapp.outcome';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';

// "Repetir" (T12) contra Postgres real: a troca atômica decide sozinha entre
// dois cliques. Fila e auditoria são dublês; serviço e repositório são os de verdade.
type BulkJob = {
  name: string;
  data: TeamWhatsappSendJob;
  opts: { jobId: string };
};
const queue = { addBulk: vi.fn<(jobs: BulkJob[]) => Promise<unknown>>() };
const audit = { log: vi.fn() };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;
let service: TeamWhatsappRetryService;

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
  service = new TeamWhatsappRetryService(repo, audit as never, queue as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

beforeEach(() => {
  queue.addBulk.mockReset().mockResolvedValue([]);
  audit.log.mockReset();
});

type SeedRow = {
  status: TeamWhatsappRecipientStatus;
  errorCode?: string | null;
};

let seq = 0;

/** Envio de um ADMIN a um setor, com um destinatário por linha (na ordem dada). */
async function seedDispatch(rows: SeedRow[]) {
  const code = `T12-${++seq}`;
  const sector = await prisma.sector.create({ data: { name: code, code } });
  const admin = await prisma.user.create({
    data: { email: `${code}-adm@test.local`, password: 'x', role: 'ADMIN' },
  });
  const created = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId: admin.id,
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: code,
      text: 'Reunião às 9h',
      state: 'DISPATCHED',
      sectors: { create: [{ sectorId: sector.id, sectorName: code }] },
      recipients: {
        create: rows.map((r, i) => ({
          userName: `Pessoa ${String(i).padStart(2, '0')}`,
          status: r.status,
          errorCode: r.errorCode ?? null,
          channelName: 'Canal equipe',
          channelPhoneE164: '+559230001111',
          attempts: 3,
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
    ids: created.recipients.map((r) => r.id),
  };
}

const rowOf = (id: string) =>
  prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      errorCode: true,
      manualRetries: true,
      channelName: true,
      attempts: true,
    },
  });

const NOT_REPEATABLE: [string, SeedRow][] = [
  [
    'UNCERTAIN',
    { status: 'UNCERTAIN', errorCode: 'team_whatsapp.indeterminate' },
  ],
  ['SENT', { status: 'SENT' }],
  [
    'FAILED gozap.not_on_whatsapp',
    { status: 'FAILED', errorCode: 'gozap.not_on_whatsapp' },
  ],
  ['FAILED gozap.timeout', { status: 'FAILED', errorCode: 'gozap.timeout' }],
  [
    'FAILED evolution.timeout',
    { status: 'FAILED', errorCode: 'evolution.timeout' },
  ],
  ['FAILED sem código', { status: 'FAILED', errorCode: null }],
];

const SQL_RULE_CODES = [
  'evolution.number_not_on_whatsapp',
  'gozap.not_on_whatsapp',
  'gozap.invalid_recipient',
  'team_whatsapp.message_missing',
  'gozap.timeout',
  'team_whatsapp.queue_unavailable',
  'gozap.disconnected',
  'gozap.provider_error',
];

describe('requeueFailed: a troca atômica (D12)', () => {
  it('duas chamadas simultâneas para o mesmo FAILED: uma recebe a linha, a outra []', async () => {
    const d = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    const results = await Promise.all([
      repo.requeueFailed(d.id, d.ids),
      repo.requeueFailed(d.id, d.ids),
    ]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
    expect(results.flat()).toEqual([{ id: d.ids[0], manualRetries: 1 }]);
    expect(await rowOf(d.ids[0])).toMatchObject({
      status: 'QUEUED',
      errorCode: null,
      manualRetries: 1,
    });
  });

  it.each(NOT_REPEATABLE)('%s → [] e a linha não muda', async (_nome, row) => {
    const d = await seedDispatch([row]);
    const before = await rowOf(d.ids[0]);
    expect(await repo.requeueFailed(d.id, d.ids)).toEqual([]);
    expect(await repo.requeueFailed(d.id, 'all')).toEqual([]);
    expect(await rowOf(d.ids[0])).toEqual(before);
  });

  it('a regra do SQL é a de isRepeatable, para cada código de não repetir e para um código qualquer', async () => {
    const d = await seedDispatch(
      SQL_RULE_CODES.map((errorCode) => ({
        status: 'FAILED' as const,
        errorCode,
      })),
    );
    const requeued = new Set(
      (await repo.requeueFailed(d.id, 'all')).map((r) => r.id),
    );
    SQL_RULE_CODES.forEach((code, i) => {
      expect(requeued.has(d.ids[i]), code).toBe(isRepeatable('FAILED', code));
    });
    expect(requeued.size).toBe(3);
  });
});

// Continuação do grupo acima (dividido só pelo limite de linhas por função).
describe('requeueFailed: a troca atômica (D12)', () => {
  it("'all' troca só os repetíveis daquele envio", async () => {
    const mine = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
      { status: 'FAILED', errorCode: 'team_whatsapp.queue_unavailable' },
      { status: 'FAILED', errorCode: 'gozap.not_on_whatsapp' },
      { status: 'UNCERTAIN', errorCode: 'team_whatsapp.indeterminate' },
      { status: 'SENT' },
    ]);
    const other = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    const swapped = await repo.requeueFailed(mine.id, 'all');
    expect(swapped.map((r) => r.id).sort()).toEqual(
      [mine.ids[0], mine.ids[1]].sort(),
    );
    expect(swapped.every((r) => r.manualRetries === 1)).toBe(true);
    expect((await rowOf(mine.ids[2])).status).toBe('FAILED');
    expect((await rowOf(mine.ids[3])).status).toBe('UNCERTAIN');
    expect((await rowOf(mine.ids[4])).status).toBe('SENT');
    expect(await rowOf(other.ids[0])).toMatchObject({
      status: 'FAILED',
      manualRetries: 0,
    });
  });

  it('com ids: só os pedidos, e id de outro envio é ignorado', async () => {
    const mine = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    const other = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    const swapped = await repo.requeueFailed(mine.id, [
      mine.ids[1],
      other.ids[0],
    ]);
    expect(swapped).toEqual([{ id: mine.ids[1], manualRetries: 1 }]);
    expect((await rowOf(mine.ids[0])).status).toBe('FAILED');
    expect((await rowOf(other.ids[0])).status).toBe('FAILED');
  });
});

// Continuação do grupo acima (dividido só pelo limite de linhas por função).
describe('requeueFailed: a troca atômica (D12)', () => {
  it('mesmo destinatário, número e tentativas: só status, código e repetições mudam', async () => {
    const d = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    await repo.requeueFailed(d.id, 'all');
    expect(await rowOf(d.ids[0])).toEqual({
      status: 'QUEUED',
      errorCode: null,
      manualRetries: 1,
      channelName: 'Canal equipe',
      attempts: 3,
    });
  });

  it('segunda repetição depois de nova falha → manualRetries 2', async () => {
    const d = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    expect(await repo.requeueFailed(d.id, 'all')).toEqual([
      { id: d.ids[0], manualRetries: 1 },
    ]);
    // Ainda QUEUED: um segundo clique não troca nada.
    expect(await repo.requeueFailed(d.id, 'all')).toEqual([]);
    await prisma.teamWhatsappRecipient.update({
      where: { id: d.ids[0] },
      data: { status: 'FAILED', errorCode: 'gozap.disconnected' },
    });
    expect(await repo.requeueFailed(d.id, 'all')).toEqual([
      { id: d.ids[0], manualRetries: 2 },
    ]);
  });
});

describe('retry: dois cliques são uma tentativa', () => {
  it('duas chamadas simultâneas do serviço: uma fila, uma auditoria, jobId novo', async () => {
    const d = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    const results = await Promise.all([
      service.retry(d.adminId, d.id, { all: true }),
      service.retry(d.adminId, d.id, { all: true }),
    ]);
    expect(results.map((r) => r.requeued).sort()).toEqual([0, 1]);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk).toHaveBeenCalledWith([
      {
        name: 'send',
        data: { recipientId: d.ids[0] },
        opts: { jobId: `${d.ids[0]}-r1` },
      },
    ]);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('fila fora: a linha volta a FAILED (queue_unavailable) e continua repetível', async () => {
    const d = await seedDispatch([
      { status: 'FAILED', errorCode: 'gozap.disconnected' },
    ]);
    queue.addBulk.mockRejectedValueOnce(new Error('redis fora'));
    await expect(service.retry(d.adminId, d.id, { all: true })).rejects.toThrow(
      'redis fora',
    );
    expect(await rowOf(d.ids[0])).toMatchObject({
      status: 'FAILED',
      errorCode: 'team_whatsapp.queue_unavailable',
      manualRetries: 1,
    });
    await expect(
      service.retry(d.adminId, d.id, { all: true }),
    ).resolves.toEqual({ requeued: 1 });
    expect(queue.addBulk).toHaveBeenLastCalledWith([
      {
        name: 'send',
        data: { recipientId: d.ids[0] },
        opts: { jobId: `${d.ids[0]}-r2` },
      },
    ]);
  });
});
