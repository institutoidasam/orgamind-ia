import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import type { Env } from '../../shared/config/env.schema';
import { ConsentService } from '../consent/consent.service';
import { LevelsRepository } from '../levels/levels.repository';
import {
  addDays,
  todayIn,
  toDbDate,
  zonedStart,
  type CivilDate,
} from '../staff-schedule/civil-date';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import { TeamAudienceService } from './team-audience.service';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappService } from './team-whatsapp.service';

// Finalidade ponta a ponta (Lote F, T11): prévia, impressão e envio do alvo
// setor contra Postgres real. Serviços e repositório são os de verdade; só a
// fila, a auditoria e o estado ao vivo do número são dublês (nunca envia nada).
const SECRET = 'segredo-de-teste-do-publico-0123456789-abcdef';
const config = {
  get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
} as unknown as ConfigService<Env>;
const queue = { addBulk: vi.fn() };
const audit = { log: vi.fn() };
const live = {
  checkMany: vi.fn((channels: readonly { id: string }[]) =>
    Promise.resolve(
      new Map(
        channels.map((c) => [
          c.id,
          { channelId: c.id, state: 'open', checkedAt: new Date() },
        ]),
      ),
    ),
  ),
};

// Três dias à frente: o repositório lê o espelho do cadastro (hoje e futuro).
const DATE: CivilDate = addDays(todayIn(new Date()), 3);
const FIRST_SHIFT = 'shift_first';
const PAGE = { page: 1, pageSize: 50 };
const AUDIENCE_CHANGED = {
  code: 'team_whatsapp.audience_changed',
  status: 409,
  message: 'O público mudou depois da prévia. Confira de novo antes de enviar.',
};

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let audience: TeamAudienceService;
let service: TeamWhatsappService;
let results: TeamWhatsappResultsService;

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
  const consent = new ConsentService(prisma as never, config);
  const levels = new LevelsRepository(prisma as never);
  audience = new TeamAudienceService(repo, consent, levels, config);
  service = new TeamWhatsappService(
    repo,
    consent,
    audit as never,
    queue as never,
  );
  // `levels`, `live` e `audience` são injetados por propriedade no Nest; aqui, à mão.
  Object.assign(service, { levels, live, audience });
  results = new TeamWhatsappResultsService(repo);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

beforeEach(() => {
  queue.addBulk.mockReset().mockResolvedValue([]);
  audit.log.mockReset();
});

type World = {
  code: string;
  sectorId: string;
  sectorName: string;
  adminId: string;
};
type PersonOver = Partial<
  Pick<Prisma.UserUncheckedCreateInput, 'phoneE164' | 'contactAuthorization'>
>;

let seq = 0;
let phoneSeq = 0;
const nextPhone = () => `+559299111${String(++phoneSeq).padStart(4, '0')}`;

/** Um setor com número ativo (Evolution) e um ADMIN que envia; códigos únicos por teste. */
async function seedWorld(): Promise<World> {
  const code = `T11-${++seq}`;
  const channel = await prisma.channel.create({
    data: {
      name: `Canal ${code}`,
      provider: 'EVOLUTION',
      isActive: true,
      phoneE164: nextPhone(),
      evolutionInstanceName: code,
    },
  });
  const sectorName = `Setor ${code}`;
  const sector = await prisma.sector.create({
    data: { name: sectorName, code, channelId: channel.id },
  });
  const admin = await prisma.user.create({
    data: { email: `${code}-adm@test.local`, password: 'x', role: 'ADMIN' },
  });
  return { code, sectorId: sector.id, sectorName, adminId: admin.id };
}

/** Pessoa ativa do setor, no 1º turno, com telefone e contato autorizado. */
function seedPerson(world: World, name: string, over: PersonOver = {}) {
  return prisma.user.create({
    data: {
      email: `${world.code}-${name.toLowerCase()}@test.local`,
      password: 'x',
      name,
      sectorId: world.sectorId,
      shiftId: FIRST_SHIFT,
      phoneE164: nextPhone(),
      contactAuthorization: 'AUTORIZADO',
      ...over,
    },
  });
}

const seedPeople = (world: World, names: string[]) =>
  Promise.all(names.map((name) => seedPerson(world, name)));

/** Folga ou férias lançada para a data de referência (escala da pessoa). */
function addException(userId: string, kind: 'DAY_OFF' | 'VACATION') {
  return prisma.staffScheduleException.create({
    data: {
      userId,
      kind,
      startDate: toDbDate(DATE),
      endDate: toDbDate(DATE),
    },
  });
}

const noticeRequest = (
  world: World,
  over: Partial<TeamAudienceRequest> = {},
): TeamAudienceRequest => ({
  purpose: 'shift_notice',
  text: 'Aviso de teste do turno',
  target: {
    type: 'sector',
    sectorIds: [world.sectorId],
    shiftIds: [FIRST_SHIFT],
    date: DATE,
  },
  ...over,
});

/** Reunião por vínculo, com a folga incluída, na data de referência. */
const meetingRequest = (world: World): TeamAudienceRequest => ({
  purpose: 'meeting',
  text: 'Reunião de teste',
  activity: { date: DATE, time: '14:00', place: 'Sala 2' },
  target: {
    type: 'sector',
    sectorIds: [world.sectorId],
    shiftIds: [FIRST_SHIFT],
    date: DATE,
    includeOff: true,
  },
});

const sendWith = (
  world: World,
  request: TeamAudienceRequest,
  audienceKey: string,
) => service.dispatch(world.adminId, { ...request, audienceKey });

/** Prévia e envio com a impressão que ela devolveu: o caminho feliz da tela. */
async function sendAfterPreview(world: World, request: TeamAudienceRequest) {
  const preview = await audience.preview(world.adminId, request);
  return sendWith(world, request, preview.audienceKey);
}

/** Linhas de envio e de destinatário no banco inteiro (os testes rodam em série). */
async function rowCounts() {
  return {
    dispatches: await prisma.teamWhatsappDispatch.count(),
    recipients: await prisma.teamWhatsappRecipient.count(),
  };
}

/** Linha gravada do envio, com os destinatários pelo nome. */
const storedDispatch = (id: string) =>
  prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id },
    include: { recipients: { orderBy: { userName: 'asc' } } },
  });

/** Colunas que a reunião por vínculo (folga incluída) grava, na data e no turno do pedido. */
const MEETING_COLUMNS = {
  state: 'DISPATCHED',
  purpose: 'MEETING',
  audienceBase: 'ASSIGNED',
  includeOff: true,
  rosterDate: toDbDate(DATE),
  activityDate: toDbDate(DATE),
  activityTime: '14:00',
  activityPlace: 'Sala 2',
  urgencyReason: null,
  schedulePolicy: null,
  roster: null,
  audienceRule: {
    shifts: [{ id: FIRST_SHIFT, name: '1º turno' }],
    levels: [],
    withoutLevel: false,
    selectedUserIds: null,
  },
};

/** Excluído gravado (F2): setor, turno e nível considerados, nome real e sem telefone. */
const excludedOf = (
  world: World,
  userId: string,
  name: string,
  reason: string,
) => ({
  userId,
  name,
  sectorId: world.sectorId,
  sectorName: world.sectorName,
  shiftName: '1º turno',
  levelName: null,
  reason,
});

/** O que a tela de resultado mostra do envio: detalhe e a página de destinatários. */
async function historyOf(actorId: string, dispatchId: string) {
  return {
    detail: await results.detail(actorId, dispatchId),
    recipients: await results.recipients(actorId, dispatchId, PAGE),
  };
}

describe('impressão do público — o que mudou depois da prévia', () => {
  it('aceite 11: prévia, exceção de folga lançada, envio com a impressão antiga — 409 e nenhuma linha criada', async () => {
    const world = await seedWorld();
    const [, bia] = await seedPeople(world, ['Ana', 'Bia']);
    const request = noticeRequest(world);
    const old = await audience.preview(world.adminId, request);
    expect(old.included.map((p) => p.name)).toEqual(['Ana', 'Bia']);
    await addException(bia.id, 'DAY_OFF');
    const before = await rowCounts();

    await expect(
      sendWith(world, request, old.audienceKey),
    ).rejects.toMatchObject(AUDIENCE_CHANGED);

    expect(await rowCounts()).toEqual(before);
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    // Controle: a prévia nova mostra a folga e, com a impressão nova, o envio passa.
    const fresh = await audience.preview(world.adminId, request);
    expect(fresh.excluded).toMatchObject([{ name: 'Bia', reason: 'day_off' }]);
    expect(fresh.audienceKey).not.toBe(old.audienceKey);
    await expect(
      sendWith(world, request, fresh.audienceKey),
    ).resolves.toMatchObject({ queued: 1 });
  });

  it('aceite 16: telefone do incluído trocado depois da prévia — 409 e nenhuma linha criada', async () => {
    const world = await seedWorld();
    const [ana] = await seedPeople(world, ['Ana', 'Bia']);
    const request = noticeRequest(world);
    const old = await audience.preview(world.adminId, request);
    await prisma.user.update({
      where: { id: ana.id },
      data: { phoneE164: nextPhone() },
    });
    const before = await rowCounts();

    await expect(
      sendWith(world, request, old.audienceKey),
    ).rejects.toMatchObject(AUDIENCE_CHANGED);

    expect(await rowCounts()).toEqual(before);
    expect(queue.addBulk).not.toHaveBeenCalled();
    const fresh = await audience.preview(world.adminId, request);
    expect(fresh.audienceKey).not.toBe(old.audienceKey);
  });
});

describe('histórico — o envio gravado não muda com o cadastro', () => {
  it('aceite 12: envia, depois muda nome, setor e escala da pessoa — detalhe igual ao da criação', async () => {
    const world = await seedWorld();
    const [ana, bia] = await seedPeople(world, ['Ana', 'Bia', 'Caio']);
    await addException(bia.id, 'DAY_OFF');
    const sent = await sendAfterPreview(world, noticeRequest(world));
    const created = await historyOf(world.adminId, sent.dispatchId);
    expect(created.detail).toMatchObject({
      purpose: 'shift_notice',
      base: 'on_duty',
      sectors: [{ id: world.sectorId, name: world.sectorName }],
      excluded: [
        { name: 'Bia', sectorName: world.sectorName, reason: 'day_off' },
      ],
      rule: { includeOff: false, rosterDate: DATE, selectedCount: null },
    });
    expect(created.recipients.items.map((r) => r.userName)).toEqual([
      'Ana',
      'Caio',
    ]);

    const other = await prisma.sector.create({
      data: { name: `Outro ${world.code}`, code: `${world.code}-B` },
    });
    await prisma.user.update({
      where: { id: ana.id },
      data: {
        name: 'Ana Renomeada',
        sectorId: other.id,
        shiftId: 'shift_second',
      },
    });
    await prisma.user.update({
      where: { id: bia.id },
      data: { name: 'Bia Nova' },
    });
    await prisma.staffScheduleException.deleteMany({
      where: { userId: bia.id },
    });
    await addException(ana.id, 'VACATION');
    await prisma.sector.update({
      where: { id: world.sectorId },
      data: { name: `Renomeado ${world.code}` },
    });

    expect(await historyOf(world.adminId, sent.dispatchId)).toEqual(created);
  });
});

describe('gravação — reunião por vínculo', () => {
  it('reunião por vínculo grava finalidade, base, regra e excluídos, sem telefone', async () => {
    const world = await seedWorld();
    const [, bia, caio] = await seedPeople(world, ['Ana', 'Bia', 'Caio']);
    const dani = await seedPerson(world, 'Dani', { phoneE164: null });
    await addException(bia.id, 'DAY_OFF');
    await addException(caio.id, 'VACATION');

    const sent = await sendAfterPreview(world, meetingRequest(world));

    expect(sent).toMatchObject({ queued: 2, scheduled: 0, scheduledFor: null });
    const row = await storedDispatch(sent.dispatchId);
    expect(row).toMatchObject(MEETING_COLUMNS);
    expect(row.recipients.map((r) => [r.userName, r.status])).toEqual([
      ['Ana', 'QUEUED'],
      ['Bia', 'QUEUED'],
      ['Dani', 'SKIPPED'],
    ]);
    expect(row.audienceExcluded).toHaveLength(2);
    expect(row.audienceExcluded).toEqual(
      expect.arrayContaining([
        excludedOf(world, caio.id, 'Caio', 'vacation'),
        excludedOf(world, dani.id, 'Dani', 'no_phone'),
      ]),
    );
    expect(JSON.stringify(row.audienceExcluded)).not.toContain('+55');
  });
});

describe('gravação — agendado de aviso de turno', () => {
  it('agendado de aviso de turno grava SCHEDULED, finalidade e base, com schedulePolicy nulo', async () => {
    const world = await seedWorld();
    await seedPeople(world, ['Ana', 'Bia']);
    const startsAt = zonedStart(DATE, '06:00');

    const sent = await sendAfterPreview(
      world,
      noticeRequest(world, { when: 'shift_start' }),
    );

    expect(sent).toMatchObject({
      queued: 0,
      scheduled: 2,
      scheduledFor: startsAt.toISOString(),
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
    const row = await storedDispatch(sent.dispatchId);
    expect(row).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: startsAt,
      schedulePolicy: null,
      purpose: 'SHIFT_NOTICE',
      audienceBase: 'ON_DUTY',
      shiftId: FIRST_SHIFT,
      roster: null,
    });
    expect(row.recipients.map((r) => r.status)).toEqual([
      'SCHEDULED',
      'SCHEDULED',
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      'team_whatsapp.schedule',
      'TeamWhatsappDispatch',
      sent.dispatchId,
      expect.objectContaining({ purpose: 'shift_notice', base: 'on_duty' }),
    );
    const { detail } = await historyOf(world.adminId, sent.dispatchId);
    expect(detail.rule).toMatchObject({
      when: 'shift_start',
      scheduledFor: startsAt.toISOString(),
      schedulePolicy: null,
    });
  });
});
