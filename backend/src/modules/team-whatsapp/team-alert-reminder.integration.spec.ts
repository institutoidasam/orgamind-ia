import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  PrismaClient,
  type Prisma,
  type TeamWhatsappRecipientStatus,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type {
  LiveCheckChannel,
  LiveState,
} from '../whatsapp-providers/channel-live-state.service';
import { TeamAlertReminderService } from './team-alert-reminder.service';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

// Lote I, T9 (I7, DI10; aceites 9, 10, 19, 20) contra o Postgres real: a
// pré-checagem, a transação com a troca condicional e a gravação do lembrete
// são as de verdade; fila, trilha, consentimento e porta ao vivo são dublês.
// Nunca WhatsApp de verdade. Instantes explícitos em Manaus (-04:00).
const T0 = new Date('2026-11-20T09:00:00-04:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ALERT_TEXT =
  'Vazamento no galpão\n\nResponda OK para confirmar que recebeu.';

type BulkJob = {
  name: string;
  data: { recipientId: string };
  opts: { jobId: string };
};
const queue = { addBulk: vi.fn<(jobs: BulkJob[]) => Promise<unknown>>() };
const audit = { log: vi.fn() };
const consent = { isSuppressed: vi.fn() };
const ports = {
  state: 'open' as LiveState,
  beforeCheck: (): Promise<void> => Promise.resolve(),
};
const live = {
  checkMany: vi.fn(async (channels: readonly LiveCheckChannel[]) => {
    await ports.beforeCheck();
    return new Map(
      channels.map((c) => [
        c.id,
        { channelId: c.id, state: ports.state, checkedAt: T0 },
      ]),
    );
  }),
};

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: TeamAlertReminderService;
let retry: TeamWhatsappRetryService;

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
  service = new TeamAlertReminderService(
    repo,
    prisma as never,
    audit as never,
    queue as never,
  );
  Object.assign(service, { live, consent });
  retry = new TeamWhatsappRetryService(repo, audit as never, queue as never);
  await setUrgencyKey(true);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

beforeEach(() => {
  queue.addBulk.mockReset().mockResolvedValue([]);
  audit.log.mockReset();
  consent.isSuppressed.mockReset().mockResolvedValue(false);
  live.checkMany.mockClear();
  ports.state = 'open';
  ports.beforeCheck = () => Promise.resolve();
});

/** Linha da matriz (SUPERVISOR, equipe.urgencia): a chave do lembrete. */
async function setUrgencyKey(granted: boolean) {
  const key = { role: 'SUPERVISOR', key: 'equipe.urgencia' } as const;
  await prisma.rolePermission.upsert({
    where: { role_key: key },
    create: { ...key, granted },
    update: { granted },
  });
}

let seq = 0;
let phoneSeq = 0;
const newPhone = () => `+559299${String(++phoneSeq).padStart(7, '0')}`;

/** Setor com número EVOLUTION ativo, gerido por um SUPERVISOR (autor do alerta). */
async function sectorWithSupervisor() {
  const code = `lem-${++seq}`;
  const sup = await prisma.user.create({
    data: { email: `${code}@test.local`, password: 'x', role: 'SUPERVISOR' },
  });
  const channel = await prisma.channel.create({
    data: {
      name: `Canal ${code}`,
      provider: 'EVOLUTION',
      isActive: true,
      evolutionInstanceName: code,
    },
  });
  const sector = await prisma.sector.create({
    data: {
      name: `Setor ${code}`,
      code,
      managerId: sup.id,
      channelId: channel.id,
    },
  });
  return { code, supId: sup.id, channelId: channel.id, sector };
}

type Seed = { status: TeamWhatsappRecipientStatus } & Partial<
  Pick<Prisma.TeamWhatsappRecipientCreateManyInput, 'ackAt' | 'errorCode'>
>;
type Person = { userId: string; phone: string; recipientId: string };
type World = Awaited<ReturnType<typeof sectorWithSupervisor>> & {
  alertId: string;
  people: Person[];
};

/** Pessoas com telefone autorizado, na ordem das sementes (nome com índice). */
async function members(code: string, sectorId: string, count: number) {
  const users = await prisma.user.createManyAndReturn({
    data: Array.from({ length: count }, (_, i) => ({
      name: `Pessoa ${code}-${String(i).padStart(3, '0')}`,
      hasAccess: false,
      phoneE164: newPhone(),
      contactAuthorization: 'AUTORIZADO' as const,
      sectorId,
    })),
    select: { id: true, name: true, phoneE164: true },
  });
  return users.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

/** Alerta urgente de 15 min do SUPERVISOR (`createdAt` = T0), um destinatário por semente. */
async function seedAlert(seeds: Seed[]): Promise<World> {
  const w = await sectorWithSupervisor();
  const { sector } = w;
  const alert = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId: w.supId,
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: sector.name,
      text: ALERT_TEXT,
      purpose: 'URGENCY',
      audienceBase: 'ON_DUTY',
      urgencyReason: 'Vazamento',
      ackDeadlineMinutes: 15,
      channelId: w.channelId,
      createdAt: T0,
      sectors: { create: [{ sectorId: sector.id, sectorName: sector.name }] },
    },
  });
  const users = await members(w.code, sector.id, seeds.length);
  const rows = await prisma.teamWhatsappRecipient.createManyAndReturn({
    data: users.map((u, i) => ({
      dispatchId: alert.id,
      userId: u.id,
      userName: u.name ?? '',
      sectorId: sector.id,
      sectorName: sector.name,
      channelId: w.channelId,
      channelName: 'Canal',
      phoneE164: u.phoneE164,
      createdAt: T0,
      ...seeds[i],
    })),
    select: { id: true, userId: true },
  });
  const ridOf = new Map(rows.map((r) => [r.userId, r.id]));
  const people = users.map((u) => ({
    userId: u.id,
    phone: u.phoneE164 ?? '',
    recipientId: ridOf.get(u.id) ?? '',
  }));
  return { ...w, alertId: alert.id, people };
}

const idsOf = (w: World) => w.people.map((p) => p.recipientId);
const send = (w: World, min: number, ids = idsOf(w), actorId = w.supId) =>
  service.send(actorId, w.alertId, { recipientIds: ids }, at(min));

async function remindersOf(alertId: string) {
  return prisma.teamWhatsappDispatch.findMany({
    where: { parentDispatchId: alertId },
    include: { sectors: true, recipients: { orderBy: { id: 'asc' } } },
  });
}

async function headerOf(alertId: string) {
  return prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: alertId },
    select: { reminderCount: true, lastReminderAt: true },
  });
}

describe('lembrete — quem entra (aceite 9)', () => {
  it('aceite 9: entram Sem resposta, Respondeu sem ciência e incerto; ciente, Falhou e pulado não', async () => {
    const w = await seedAlert([
      { status: 'SENT' },
      { status: 'REPLIED' },
      { status: 'UNCERTAIN' },
      { status: 'READ', ackAt: at(3) },
      { status: 'FAILED', errorCode: 'team_whatsapp.queue_unavailable' },
      { status: 'SKIPPED' },
    ]);
    await expect(send(w, 6)).resolves.toMatchObject({ queued: 3 });
    const [reminder] = await remindersOf(w.alertId);
    const parents = reminder.recipients.map((r) => r.parentRecipientId);
    expect(parents.sort()).toEqual(idsOf(w).slice(0, 3).sort());
  });

  it('aceite 9: ciência gravada entre a pré-checagem e a transação — a pessoa sai', async () => {
    const w = await seedAlert([{ status: 'SENT' }, { status: 'SENT' }]);
    const [first, second] = idsOf(w);
    ports.beforeCheck = async () => {
      await prisma.teamWhatsappRecipient.update({
        where: { id: first },
        data: { ackAt: at(5), ackKind: 'KEYWORD' },
      });
    };
    await expect(send(w, 6)).resolves.toMatchObject({ queued: 1 });
    const [reminder] = await remindersOf(w.alertId);
    expect(reminder.recipients.map((r) => r.parentRecipientId)).toEqual([
      second,
    ]);
  });
});

describe('lembrete — pedido vazio (aceite 19)', () => {
  it('aceite 19: só ids fora dos elegíveis — 422 reminder_empty e reminderCount não muda', async () => {
    const w = await seedAlert([{ status: 'SENT' }, { status: 'FAILED' }]);
    const other = await seedAlert([{ status: 'SENT' }]);
    const outside = [idsOf(w)[1], idsOf(other)[0], 'nao-existe'];
    await expect(send(w, 6, outside)).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.reminder_empty',
    });
    expect(await headerOf(w.alertId)).toEqual({
      reminderCount: 0,
      lastReminderAt: null,
    });
    expect(await remindersOf(w.alertId)).toEqual([]);
    expect(queue.addBulk).not.toHaveBeenCalled();
  });
});

describe('lembrete — limite e intervalo (aceite 10)', () => {
  it('aceite 10: 4º lembrete — 409 reminder_limit', async () => {
    const w = await seedAlert([{ status: 'SENT' }]);
    for (const min of [6, 12, 18]) await send(w, min);
    await expect(send(w, 24)).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.reminder_limit',
    });
    expect(await headerOf(w.alertId)).toEqual({
      reminderCount: 3,
      lastReminderAt: at(18),
    });
    expect(await remindersOf(w.alertId)).toHaveLength(3);
  });

  it('aceite 10: antes de 5 min do alerta ou do anterior — 409 reminder_too_soon', async () => {
    const w = await seedAlert([{ status: 'SENT' }]);
    const tooSoon = { status: 409, code: 'team_whatsapp.reminder_too_soon' };
    await expect(send(w, 4)).rejects.toMatchObject(tooSoon);
    await expect(send(w, 5)).resolves.toMatchObject({ queued: 1 });
    await expect(send(w, 9)).rejects.toMatchObject(tooSoon);
    expect(await headerOf(w.alertId)).toEqual({
      reminderCount: 1,
      lastReminderAt: at(5),
    });
  });
});

/** Segura cada conferência ao vivo até `n` pedidos chegarem a ela (todos passaram da pré-checagem). */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const all = new Promise<void>((resolve) => (open = resolve));
  return () => {
    if (++arrived === n) open();
    return all;
  };
}

describe('lembrete — pedido único (aceite 10)', () => {
  it('aceite 10: dois pedidos ao mesmo tempo — um lembrete; o outro 409 reminder_too_soon', async () => {
    const w = await seedAlert([{ status: 'SENT' }, { status: 'REPLIED' }]);
    ports.beforeCheck = barrier(2);
    const results = await Promise.allSettled([send(w, 6), send(w, 6)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason as { code: string }] : [],
    );
    expect(ok).toHaveLength(1);
    expect(refused.map((e) => e.code)).toEqual([
      'team_whatsapp.reminder_too_soon',
    ]);
    expect(live.checkMany).toHaveBeenCalledTimes(2);
    expect(await remindersOf(w.alertId)).toHaveLength(1);
    expect((await headerOf(w.alertId)).reminderCount).toBe(1);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
  });

  it('aceite 10: número desconectado — 409, nenhum envio criado, reminderCount igual', async () => {
    const w = await seedAlert([{ status: 'SENT' }]);
    ports.state = 'close';
    await expect(send(w, 6)).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.channel_disconnected',
    });
    expect(await remindersOf(w.alertId)).toEqual([]);
    expect(await headerOf(w.alertId)).toEqual({
      reminderCount: 0,
      lastReminderAt: null,
    });
  });
});

describe('lembrete — o envio gravado (I7, DI10)', () => {
  it('lembrete: Urgência, mesmo motivo, alvo e setores, parentDispatchId, ackDeadlineMinutes null, texto Lembrete: + texto do alerta, destinatários com parentRecipientId e o telefone atual da pessoa', async () => {
    const w = await seedAlert([{ status: 'SENT' }]);
    const { reminderId } = await send(w, 6);
    const [r] = await remindersOf(w.alertId);
    expect(r).toMatchObject({
      id: reminderId,
      authorId: w.supId,
      purpose: 'URGENCY',
      urgencyReason: 'Vazamento',
      audienceBase: 'ON_DUTY',
      targetType: 'SECTOR',
      targetId: w.sector.id,
      targetLabel: w.sector.name,
      parentDispatchId: w.alertId,
      ackDeadlineMinutes: null,
      reminderCount: 0,
      channelId: w.channelId,
      text: `Lembrete: ${ALERT_TEXT}`,
      createdAt: at(6),
      audienceRule: null,
      roster: null,
    });
    expect(r.sectors.map((s) => s.sectorId)).toEqual([w.sector.id]);
    expect(r.recipients).toMatchObject([
      {
        parentRecipientId: w.people[0].recipientId,
        userId: w.people[0].userId,
        phoneE164: w.people[0].phone,
        channelId: w.channelId,
        sectorId: w.sector.id,
        status: 'QUEUED',
        skipReason: null,
      },
    ]);
  });
});

describe('lembrete — telefone atual (I7, DG7)', () => {
  it('I7: pessoa que trocou de telefone depois do alerta — o lembrete grava o número novo e sai, sem Pulado: telefone mudou', async () => {
    const w = await seedAlert([{ status: 'SENT' }]);
    const [p] = w.people;
    const phone = newPhone();
    await prisma.user.update({
      where: { id: p.userId },
      data: { phoneE164: phone },
    });
    await expect(send(w, 6)).resolves.toMatchObject({ queued: 1 });
    const [r] = (await remindersOf(w.alertId))[0].recipients;
    // O processor só pula com PHONE_CHANGED quando gravado ≠ atual (DG7).
    expect(r).toMatchObject({ phoneE164: phone, status: 'QUEUED' });
    expect(r.skipReason).toBeNull();
    const original = await prisma.teamWhatsappRecipient.findUniqueOrThrow({
      where: { id: p.recipientId },
    });
    expect(original.phoneE164).toBe(p.phone);
  });
});

describe('lembrete — volume e fila (DI10)', () => {
  it('500 pessoas elegíveis — lembrete criado por createMany dentro do timeout da transação', async () => {
    const w = await seedAlert(
      Array.from({ length: 500 }, () => ({ status: 'SENT' as const })),
    );
    await expect(send(w, 6)).resolves.toMatchObject({ queued: 500 });
    const [r] = await remindersOf(w.alertId);
    expect(r.recipients).toHaveLength(500);
    expect(new Set(r.recipients.map((x) => x.parentRecipientId))).toEqual(
      new Set(idsOf(w)),
    );
  }, 60_000);

  it('um job por destinatário do lembrete', async () => {
    const w = await seedAlert([
      { status: 'SENT' },
      { status: 'SENT' },
      { status: 'SENT' },
    ]);
    await prisma.user.update({
      where: { id: w.people[2].userId },
      data: { phoneE164: null },
    });
    await expect(send(w, 6)).resolves.toMatchObject({ queued: 2 });
    const [r] = await remindersOf(w.alertId);
    const queued = r.recipients.filter((x) => x.status === 'QUEUED');
    const skipped = r.recipients.filter((x) => x.status === 'SKIPPED');
    expect(skipped.map((x) => x.skipReason)).toEqual(['NO_PHONE']);
    const jobs = queue.addBulk.mock.calls.flatMap(([batch]) => batch);
    expect(jobs.map((j) => j.opts.jobId).sort()).toEqual(
      queued.map((x) => x.id).sort(),
    );
    expect(jobs.every((j) => j.data.recipientId === j.opts.jobId)).toBe(true);
  });
});

describe('lembrete — Repetir e autoria (aceites 19, 20)', () => {
  it('aceite 19: Repetir das falhas do alerta por SUPERVISOR sem equipe.urgencia — funciona', async () => {
    const w = await seedAlert([
      { status: 'FAILED', errorCode: 'team_whatsapp.queue_unavailable' },
    ]);
    await setUrgencyKey(false);
    try {
      await expect(
        retry.retry(w.supId, w.alertId, { all: true }),
      ).resolves.toEqual({ requeued: 1 });
      await expect(send(w, 6)).rejects.toMatchObject({
        status: 403,
        code: 'auth.permission_denied',
      });
    } finally {
      await setUrgencyKey(true);
    }
  });

  it('aceite 20: lembrete do ADMIN em alerta do SUPERVISOR — autor ADMIN', async () => {
    const w = await seedAlert([{ status: 'SENT' }]);
    const admin = await prisma.user.create({
      data: { email: `adm-${++seq}@test.local`, password: 'x', role: 'ADMIN' },
    });
    const { reminderId } = await send(w, 6, idsOf(w), admin.id);
    const [r] = await remindersOf(w.alertId);
    expect(r).toMatchObject({ id: reminderId, authorId: admin.id });
    expect(audit.log).toHaveBeenCalledWith(
      'team_whatsapp.reminder',
      'TeamWhatsappDispatch',
      reminderId,
      expect.objectContaining({ actorId: admin.id, alertId: w.alertId }),
    );
  });
});
