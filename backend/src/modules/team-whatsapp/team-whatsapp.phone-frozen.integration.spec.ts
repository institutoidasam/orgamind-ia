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
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';

// O processor só usa o pacing para segurar o canal depois do envio (dorme 10–45 s).
vi.mock('../campaigns/pacing.helper', () => ({
  acquirePacingLock: vi.fn().mockResolvedValue({ acquired: true }),
  releasePacingLock: vi.fn().mockResolvedValue(undefined),
}));

// Telefone congelado (T9, DG7) contra Postgres real: o envio e os destinatários
// são gravados direto no banco (sem depender do serviço da T8) e o disparo é o
// do agendado ou o do "Repetir". Fila, provedor e supressão são dublês; o
// serviço de disparo, o repositório e o processor são os de verdade.
const NOW = new Date('2026-10-21T12:00:00.000Z');
const DUE = new Date(NOW.getTime() - 60_000);

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
  repo = new TeamWhatsappRepository(
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

let seq = 0;
let phoneSeq = 0;
/** Telefone fictício único (o do usuário é @unique). */
const phone = () => `+55929911${String(++phoneSeq).padStart(5, '0')}`;
const sorted = (xs: readonly string[]) =>
  [...xs].sort((a, b) => a.localeCompare(b));

type Person = {
  name: string;
  /** Telefone gravado no destinatário na criação do envio; null = envio antigo. */
  frozen: string | null;
  /** Telefone do usuário na hora do seed (a troca vem depois, por `changePhone`). */
  current: string;
  /** Só no envio já disparado: a linha nasce FAILED (repetível) ou SKIPPED PHONE_CHANGED. */
  state?: 'FAILED' | 'SKIPPED';
};

function recipientState(p: Person, scheduled: boolean) {
  if (scheduled) return { status: 'SCHEDULED' as const };
  if (p.state === 'SKIPPED')
    return { status: 'SKIPPED' as const, skipReason: 'PHONE_CHANGED' as const };
  return {
    status: 'FAILED' as const,
    errorCode: 'gozap.disconnected',
    attempts: 1,
  };
}

/** Uma pessoa autorizada por destinatário, com o telefone `current`. */
const createUsers = (code: string, sectorId: string, people: Person[]) =>
  Promise.all(
    people.map((p, i) =>
      prisma.user.create({
        data: {
          email: `${code}-${i}@test.local`,
          password: 'x',
          name: p.name,
          sectorId,
          phoneE164: p.current,
          contactAuthorization: 'AUTORIZADO',
        },
      }),
    ),
  );

/** Envio de um ADMIN a um setor, com política nula; destinatários na ordem do nome. */
async function seedDispatch(people: Person[], scheduled: boolean) {
  const code = `T9P-${++seq}`;
  const sector = await prisma.sector.create({ data: { name: code, code } });
  const admin = await prisma.user.create({
    data: { email: `${code}-adm@test.local`, password: 'x', role: 'ADMIN' },
  });
  const channel = await prisma.channel.create({
    data: { name: `Canal ${code}`, provider: 'EVOLUTION', isActive: true },
  });
  const users = await createUsers(code, sector.id, people);
  const created = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId: admin.id,
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: code,
      channelId: channel.id,
      text: 'oi',
      state: scheduled ? 'SCHEDULED' : 'DISPATCHED',
      ...(scheduled ? { scheduledFor: DUE } : { firedAt: DUE }),
      recipients: {
        create: people.map((p, i) => ({
          userId: users[i].id,
          userName: p.name,
          phoneE164: p.frozen,
          ...recipientState(p, scheduled),
        })),
      },
    },
    select: {
      id: true,
      recipients: {
        select: { id: true, userId: true },
        orderBy: { userName: 'asc' },
      },
    },
  });
  return { id: created.id, rows: created.recipients };
}

const changePhone = (userId: string | null, phoneE164: string) =>
  prisma.user.update({
    where: { id: userId as string },
    data: { phoneE164 },
  });

/** Processor real sobre o banco; o `chat` (provedor) é um dublê que aceita tudo. */
async function runProcessor(recipientIds: readonly string[]) {
  let messageSeq = 0;
  const chat = {
    prepareTeamMessage: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ messageId: `msg-${++messageSeq}`, contactId: null }),
      ),
    sendTeamMessage: vi
      .fn()
      .mockImplementation(({ messageId }: { messageId: string }) =>
        Promise.resolve({
          messageId,
          sent: true,
          errorCode: null,
          retryable: false,
        }),
      ),
    isRedispatchableFailure: vi.fn().mockReturnValue(true),
  };
  const proc = new TeamWhatsappSendProcessor(
    prisma as never,
    chat as never,
    { isSuppressed: vi.fn().mockResolvedValue(false) } as never,
    { del: vi.fn() } as never,
  );
  Object.assign(proc, {
    repo,
    liveState: { check: vi.fn().mockResolvedValue({ state: 'open' }) },
  });
  for (const recipientId of recipientIds) {
    await proc.process({
      data: { recipientId },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);
  }
  return chat;
}

/** Telefones para os quais o processor criou Message (a fase 1 de cada envio). */
const sentTo = (chat: Awaited<ReturnType<typeof runProcessor>>) =>
  chat.prepareTeamMessage.mock.calls.map(
    ([a]) => (a as { phoneE164: string }).phoneE164,
  );
const outcomesOf = async (dispatchId: string) =>
  (
    await prisma.teamWhatsappRecipient.findMany({
      where: { dispatchId },
      orderBy: { userName: 'asc' },
      select: { status: true, skipReason: true },
    })
  ).map((r) => [r.status, r.skipReason]);
const jobIds = () =>
  queue.addBulk.mock.calls.flatMap(([jobs]) =>
    jobs.map((j) => j.data.recipientId),
  );

describe('telefone congelado — disparo do agendado (aceite 28)', () => {
  it('agendado, pessoa troca de telefone, disparo: PHONE_CHANGED e os outros recebem', async () => {
    const [ana, bia, caio, biaNow] = [phone(), phone(), phone(), phone()];
    const d = await seedDispatch(
      [
        { name: 'Ana', frozen: ana, current: ana },
        { name: 'Bia', frozen: bia, current: bia },
        { name: 'Caio', frozen: caio, current: caio },
      ],
      true,
    );
    await changePhone(d.rows[1].userId, biaNow);
    await expect(service.fireOne(d.id, NOW)).resolves.toBe('fired');
    expect(jobIds()).toHaveLength(3);
    const chat = await runProcessor(jobIds());
    expect(await outcomesOf(d.id)).toEqual([
      ['SENT', null],
      ['SKIPPED', 'PHONE_CHANGED'],
      ['SENT', null],
    ]);
    expect(sorted(sentTo(chat))).toEqual(sorted([ana, caio]));
    expect(chat.sendTeamMessage).toHaveBeenCalledTimes(2);
    expect(
      await prisma.teamWhatsappRecipient.findUniqueOrThrow({
        where: { id: d.rows[1].id },
        select: { messageId: true, attempts: true, phoneE164: true },
      }),
    ).toEqual({ messageId: null, attempts: 0, phoneE164: bia });
  }, 60_000);
});

describe('telefone congelado — Repetir (aceite 28)', () => {
  it('Repetir não pega o PHONE_CHANGED; FAILED repetido depois da troca vira PHONE_CHANGED', async () => {
    const [ana, anaNow, bia, biaNow, caio] = [
      phone(),
      phone(),
      phone(),
      phone(),
      phone(),
    ];
    const d = await seedDispatch(
      [
        { name: 'Ana', frozen: ana, current: ana, state: 'FAILED' },
        { name: 'Bia', frozen: bia, current: biaNow, state: 'SKIPPED' },
        { name: 'Caio', frozen: caio, current: caio, state: 'FAILED' },
      ],
      false,
    );
    await changePhone(d.rows[0].userId, anaNow);
    const refs = await repo.requeueFailed(d.id, 'all');
    expect(sorted(refs.map((r) => r.id))).toEqual(
      sorted([d.rows[0].id, d.rows[2].id]),
    );
    const chat = await runProcessor(refs.map((r) => r.id));
    expect(await outcomesOf(d.id)).toEqual([
      ['SKIPPED', 'PHONE_CHANGED'],
      ['SKIPPED', 'PHONE_CHANGED'],
      ['SENT', null],
    ]);
    expect(sentTo(chat)).toEqual([caio]);
    expect(
      await prisma.teamWhatsappRecipient.findUniqueOrThrow({
        where: { id: d.rows[1].id },
        select: { manualRetries: true },
      }),
    ).toEqual({ manualRetries: 0 });
  }, 60_000);
});

describe('telefone congelado — envio antigo (aceite 38)', () => {
  it('sem telefone gravado: o Repetir usa o telefone atual', async () => {
    const [before, now] = [phone(), phone()];
    const d = await seedDispatch(
      [{ name: 'Ana', frozen: null, current: before, state: 'FAILED' }],
      false,
    );
    await changePhone(d.rows[0].userId, now);
    const refs = await repo.requeueFailed(d.id, 'all');
    expect(refs).toHaveLength(1);
    const chat = await runProcessor(refs.map((r) => r.id));
    expect(sentTo(chat)).toEqual([now]);
    expect(await outcomesOf(d.id)).toEqual([['SENT', null]]);
  }, 60_000);
});
