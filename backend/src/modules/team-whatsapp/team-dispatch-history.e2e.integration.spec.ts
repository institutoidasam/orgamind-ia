import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { addDays, todayIn, toDbDate } from '../staff-schedule/civil-date';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import type { DispatchListQuery } from './dto/dispatch-list-query.dto';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappSendProcessor } from './team-whatsapp-send.processor';
import {
  REFERENCE_DATE,
  addException,
  fireAt,
  minutesAfter,
  noticeAt,
  scheduleViaService,
  seedPerson,
  seedWorld,
  startRecheckDeps,
  type RecheckDeps,
  type World,
} from './team-whatsapp.schedule-recheck.test-fixtures';

// O processor só usa o pacing para segurar o canal depois do envio (dorme 10–45 s).
vi.mock('../campaigns/pacing.helper', () => ({
  acquirePacingLock: vi.fn().mockResolvedValue({ acquired: true }),
  releasePacingLock: vi.fn().mockResolvedValue(undefined),
}));

// Lote G, T12: histórico, data de referência passada e telefone congelado
// ponta a ponta, contra Postgres real (aceites 12, 28 e 31). Serviços,
// repositório e o processor de envio são os de verdade; fila, auditoria, estado
// ao vivo e a porta do número (Message e provedor) são dublês: nada é enviado.
// Os testes rodam em série e cada um fecha o seu agendado (o tick pega todo
// SCHEDULED vencido do banco). Período e `createdAt` são gravados explícitos,
// no fuso de Manaus (-04:00); o tick recebe `now` explícito.
const PAGE = { page: 1, pageSize: 50 };
/** Data de referência no passado: o vínculo da data (`UserAssignment`) decide o público. */
const PAST = addDays(todayIn(new Date()), -5);

let deps: RecheckDeps;
let stop: () => Promise<void>;
let results: TeamWhatsappResultsService;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
  results = new TeamWhatsappResultsService(deps.repo);
}, 180_000);

afterAll(async () => {
  await stop?.();
});

beforeEach(() => {
  deps.queue.addBulk.mockReset().mockResolvedValue([]);
  deps.audit.log.mockReset();
});

let phoneSeq = 0;
/** Telefone fictício único (o do usuário e o do contato são @unique). */
const phone = () => `+559299333${String(++phoneSeq).padStart(4, '0')}`;

const seedPeople = (world: World, names: string[]) =>
  Promise.all(names.map((name) => seedPerson(deps, world, name)));

/** Gestor (SUPERVISOR) do setor: envia só para ele e vê só os próprios envios. */
async function seedManager(world: World): Promise<string> {
  const manager = await deps.prisma.user.create({
    data: {
      email: `${world.code}-gestor@test.local`,
      password: 'x',
      role: 'SUPERVISOR',
    },
  });
  await deps.prisma.sector.update({
    where: { id: world.sectorId },
    data: { managerId: manager.id },
  });
  return manager.id;
}

/** Liga um contato à pessoa: o telefone que o envio usa passa a ser o dele, não o do cadastro. */
async function linkContact(userId: string): Promise<string> {
  const contact = await deps.prisma.contact.create({
    data: { phoneE164: phone() },
  });
  await deps.prisma.user.update({
    where: { id: userId },
    data: { contactId: contact.id },
  });
  return contact.phoneE164;
}

/** Aviso de turno para agora (sem "data e hora"), na data de referência do pedido. */
const nowNotice = (world: World, over: Partial<TeamAudienceRequest> = {}) =>
  noticeAt(world, { when: 'now', at: undefined, ...over });

/** Prévia e envio com a impressão que ela devolveu: o caminho feliz da tela. */
async function sendAs(actorId: string, request: TeamAudienceRequest) {
  const preview = await deps.audience.preview(actorId, request);
  return deps.service.dispatch(actorId, {
    ...request,
    audienceKey: preview.audienceKey,
  });
}

/** Destinatários e regra como o banco guarda, na ordem do nome. */
const storedRow = (dispatchId: string) =>
  deps.prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: dispatchId },
    select: {
      audienceRule: true,
      recipients: {
        orderBy: { userName: 'asc' },
        select: {
          userName: true,
          status: true,
          skipReason: true,
          phoneE164: true,
          messageId: true,
          attempts: true,
        },
      },
    },
  });
type Stored = Awaited<ReturnType<typeof storedRow>>;
const outcomes = (row: Stored) =>
  row.recipients.map((r) => [r.userName, r.status, r.skipReason]);

/** Porta do número falsa: a fase 1 (Message) e a fase 2 (provedor) só anotam a chamada. */
function fakePort() {
  let seq = 0;
  const prepareTeamMessage =
    vi.fn<
      (args: {
        phoneE164: string;
      }) => Promise<{ messageId: string; contactId: null }>
    >();
  prepareTeamMessage.mockImplementation(() =>
    Promise.resolve({ messageId: `msg-${++seq}`, contactId: null }),
  );
  const sendTeamMessage = vi.fn((args: { messageId: string }) =>
    Promise.resolve({ ...args, sent: true, errorCode: null, retryable: false }),
  );
  return {
    prepareTeamMessage,
    sendTeamMessage,
    isRedispatchableFailure: vi.fn(),
  };
}
type Port = ReturnType<typeof fakePort>;

/** O processor de envio de verdade sobre os jobs que o serviço enfileirou. */
async function processQueued(port: Port): Promise<void> {
  const processor = new TeamWhatsappSendProcessor(
    deps.prisma as never,
    port as never,
    { isSuppressed: vi.fn().mockResolvedValue(false) } as never,
    { del: vi.fn() } as never,
  );
  Object.assign(processor, {
    repo: deps.repo,
    liveState: { check: vi.fn().mockResolvedValue({ state: 'open' }) },
  });
  const jobs = deps.queue.addBulk.mock.calls.flatMap(([queued]) => queued);
  for (const job of jobs) {
    await processor.process({
      ...job,
      attemptsMade: 0,
      opts: { ...job.opts, attempts: 3 },
    } as never);
  }
}

/** Telefones para os quais a porta criou Message, em ordem. */
const phonesPrepared = (port: Port) =>
  port.prepareTeamMessage.mock.calls.map(([args]) => args.phoneE164).sort();

/** Trilha do envio: ids e contagens, nunca telefone (GG8). */
const trailHasNoPhone = () =>
  expect(JSON.stringify(deps.audit.log.mock.calls)).not.toContain('+55');

describe('aceite 28 ponta a ponta — telefone igual', () => {
  it('criado pelo serviço, telefone igual: o processor envia para o gravado, o do contato ligado', async () => {
    const world = await seedWorld(deps);
    const [ana, bia] = await seedPeople(world, ['Ana', 'Bia']);
    const contact = await linkContact(ana.id);
    expect(contact).not.toBe(ana.phoneE164);

    const sent = await sendAs(world.adminId, nowNotice(world));

    expect(sent).toMatchObject({ queued: 2, scheduled: 0 });
    const created = await storedRow(sent.dispatchId);
    expect(created.audienceRule).toMatchObject({ when: 'now' });
    expect(
      created.recipients.map((r) => [r.userName, r.status, r.phoneE164]),
    ).toEqual([
      ['Ana', 'QUEUED', contact],
      ['Bia', 'QUEUED', bia.phoneE164],
    ]);

    const port = fakePort();
    await processQueued(port);

    expect(phonesPrepared(port)).toEqual([contact, bia.phoneE164].sort());
    expect(port.sendTeamMessage.mock.calls).toHaveLength(2);
    const after = await storedRow(sent.dispatchId);
    expect(outcomes(after)).toEqual([
      ['Ana', 'SENT', null],
      ['Bia', 'SENT', null],
    ]);
    expect(after.recipients.map((r) => r.phoneE164)).toEqual([
      contact,
      bia.phoneE164,
    ]);
    expect(after.recipients.every((r) => r.messageId !== null)).toBe(true);
    trailHasNoPhone();
  }, 60_000);
});

/** Agendado para Ana (contato ligado), Bia e Caio; confere o que a criação gravou (regra e telefone). */
async function scheduleWithLinkedContact() {
  const world = await seedWorld(deps);
  const [ana, bia, caio] = await seedPeople(world, ['Ana', 'Bia', 'Caio']);
  const frozen = await linkContact(ana.id);
  const scheduled = await scheduleViaService(deps, {
    actorId: world.adminId,
    request: noticeAt(world),
  });
  const created = await storedRow(scheduled.dispatchId);
  expect(created.audienceRule).toMatchObject({ when: 'at' });
  expect(created.recipients[0]).toMatchObject({
    userName: 'Ana',
    status: 'SCHEDULED',
    phoneE164: frozen,
  });
  const others = [bia.phoneE164, caio.phoneE164].sort();
  return { world, frozen, others, ...scheduled };
}

describe('aceite 28 ponta a ponta — troca depois da criação', () => {
  it('troca do telefone do contato depois do agendamento: PHONE_CHANGED, sem Message; os outros recebem', async () => {
    const { world, frozen, others, dispatchId, scheduledFor } =
      await scheduleWithLinkedContact();
    await deps.prisma.contact.updateMany({
      where: { phoneE164: frozen },
      data: { phoneE164: phone() },
    });

    await expect(fireAt(deps, minutesAfter(scheduledFor, 1))).resolves.toEqual({
      fired: 1,
    });
    const port = fakePort();
    await processQueued(port);

    const after = await storedRow(dispatchId);
    expect(outcomes(after)).toEqual([
      ['Ana', 'SKIPPED', 'PHONE_CHANGED'],
      ['Bia', 'SENT', null],
      ['Caio', 'SENT', null],
    ]);
    expect(after.recipients[0]).toMatchObject({
      messageId: null,
      attempts: 0,
      phoneE164: frozen,
    });
    expect(phonesPrepared(port)).toEqual(others);
    expect(port.sendTeamMessage.mock.calls).toHaveLength(2);
    const shown = await results.recipients(world.adminId, dispatchId, PAGE);
    expect(shown.items[0]).toMatchObject({
      userName: 'Ana',
      status: 'SKIPPED',
      reason: 'PHONE_CHANGED',
      repeatable: false,
    });
    trailHasNoPhone();
  }, 60_000);
});

/** Setor com envio de data passada: vínculo da data (Ana), espelho (Bia) e folga (Caio). */
async function seedPastSector() {
  const world = await seedWorld(deps);
  const moved = await deps.prisma.sector.create({
    data: { name: `Outro ${world.code}`, code: `${world.code}-B` },
  });
  const shift = await deps.prisma.shift.create({
    data: {
      name: `Turno ${world.code}`,
      startTime: '06:00',
      endTime: '14:00',
      sortOrder: 90,
    },
  });
  const [ana, , caio] = await Promise.all(
    ['Ana', 'Bia', 'Caio'].map((name) =>
      seedPerson(deps, world, name, { shiftId: shift.id }),
    ),
  );
  // Hoje o cadastro da Ana a põe em outro setor e turno; o vínculo da data, neste.
  await deps.prisma.user.update({
    where: { id: ana.id },
    data: { sectorId: moved.id, shiftId: 'shift_second' },
  });
  await deps.prisma.userAssignment.createMany({
    data: [
      {
        userId: ana.id,
        sectorId: world.sectorId,
        shiftId: shift.id,
        validFrom: toDbDate(addDays(PAST, -30)),
        validTo: toDbDate(addDays(PAST, 2)),
      },
      {
        userId: ana.id,
        sectorId: moved.id,
        shiftId: 'shift_second',
        validFrom: toDbDate(addDays(PAST, 3)),
      },
    ],
  });
  await addException(deps, caio.id, 'DAY_OFF', PAST);
  return { world, moved, shift, ana };
}
type PastSeed = Awaited<ReturnType<typeof seedPastSector>>;

/** O que muda depois do envio: o vínculo da data da Ana e o nome do turno. */
async function changeAfterSend({ world, moved, shift, ana }: PastSeed) {
  await deps.prisma.userAssignment.updateMany({
    where: { userId: ana.id, validTo: { not: null } },
    data: { sectorId: moved.id, shiftId: 'shift_second' },
  });
  return deps.prisma.shift.update({
    where: { id: shift.id },
    data: { name: `Renomeado ${world.code}` },
  });
}

/** O que a tela de resultado mostra: detalhe, destinatários e a linha da lista. */
async function historyOf(actorId: string, dispatchId: string) {
  const list = await deps.service.listDispatches(actorId, PAGE);
  return {
    detail: await results.detail(actorId, dispatchId),
    recipients: await results.recipients(actorId, dispatchId, PAGE),
    item: list.items.find((i) => i.id === dispatchId),
  };
}

describe('aceite 12 — histórico de envio com data passada', () => {
  it('aceite 12: envio com data passada; muda o vínculo (UserAssignment) e o nome do turno — detalhe, regra e excluídos iguais', async () => {
    const seed = await seedPastSector();
    const { world, shift } = seed;
    const request = nowNotice(world, {
      target: {
        type: 'sector',
        sectorIds: [world.sectorId],
        shiftIds: [shift.id],
        date: PAST,
      },
    });
    const sent = await sendAs(world.adminId, request);
    expect(sent).toMatchObject({ queued: 2, scheduled: 0 });
    const created = await historyOf(world.adminId, sent.dispatchId);
    expect(created.detail).toMatchObject({
      purpose: 'shift_notice',
      base: 'on_duty',
      sectors: [{ id: world.sectorId, name: world.sectorName }],
      excluded: [{ name: 'Caio', shiftName: shift.name, reason: 'day_off' }],
      rule: {
        when: 'now',
        rosterDate: PAST,
        includeOff: false,
        shifts: [{ id: shift.id, name: shift.name }],
      },
    });
    expect(
      created.recipients.items.map((r) => [r.userName, r.shiftName]),
    ).toEqual([
      ['Ana', shift.name],
      ['Bia', shift.name],
    ]);
    expect(created.item).toMatchObject({
      rosterDate: PAST,
      purpose: 'shift_notice',
    });

    const renamed = await changeAfterSend(seed);
    // Controle: a mudança vale. A mesma prévia, feita agora, já não traz a Ana.
    expect(renamed.name).not.toBe(shift.name);
    const fresh = await deps.audience.preview(world.adminId, request);
    expect(fresh.included.map((p) => p.name)).toEqual(['Bia']);

    expect(await historyOf(world.adminId, sent.dispatchId)).toEqual(created);
  }, 60_000);
});

/** Grava o `createdAt` do envio (o serviço usa o relógio; o período do teste é fixo). */
const stamp = (dispatchId: string, iso: string) =>
  deps.prisma.teamWhatsappDispatch.update({
    where: { id: dispatchId },
    data: { createdAt: new Date(iso) },
  });

/** Reunião para agora: base vinculada, folga incluída, no dia de referência. */
const meetingNow = (world: World) =>
  nowNotice(world, {
    purpose: 'meeting',
    text: 'Reunião de teste',
    activity: { date: REFERENCE_DATE, time: '14:00', place: 'Sala 2' },
    target: { ...noticeAt(world).target, includeOff: true },
  });

const listIds = async (actorId: string, filter: Partial<DispatchListQuery>) =>
  (
    await deps.service.listDispatches(actorId, { ...PAGE, ...filter })
  ).items.map((item) => item.id);

/** Três envios do gestor: reunião (10/03), aviso agendado e aviso agora (os dois em 11/03). */
async function seedHistory() {
  const world = await seedWorld(deps);
  const managerId = await seedManager(world);
  await seedPeople(world, ['Álvaro', 'Bia', 'Caio']);
  const meeting = await sendAs(managerId, meetingNow(world));
  const scheduled = await scheduleViaService(deps, {
    actorId: managerId,
    request: noticeAt(world),
  });
  const notice = await sendAs(managerId, nowNotice(world));
  await stamp(meeting.dispatchId, '2026-03-10T15:00:00.000-04:00');
  await stamp(scheduled.dispatchId, '2026-03-11T00:00:00.000-04:00');
  await stamp(notice.dispatchId, '2026-03-11T23:59:59.999-04:00');
  return {
    managerId,
    scheduled,
    meeting: meeting.dispatchId,
    notice: notice.dispatchId,
  };
}

describe('aceite 31 — filtros do histórico e busca no detalhe', () => {
  it('aceite 31: filtra por finalidade, período e situação e busca uma pessoa no detalhe', async () => {
    const { managerId, scheduled, meeting, notice } = await seedHistory();
    const agendado = scheduled.dispatchId;
    const ids = (filter: Partial<DispatchListQuery>) =>
      listIds(managerId, filter);

    expect(await ids({})).toEqual([notice, agendado, meeting]);
    expect(await ids({ purpose: 'meeting' })).toEqual([meeting]);
    expect(await ids({ from: '2026-03-11', to: '2026-03-11' })).toEqual([
      notice,
      agendado,
    ]);
    expect(await ids({ state: 'SCHEDULED' })).toEqual([agendado]);
    expect(
      await ids({
        purpose: 'shift_notice',
        state: 'DISPATCHED',
        from: '2026-03-11',
      }),
    ).toEqual([notice]);
    // Passou de 2 h do horário marcado: o agendado vence e muda de situação.
    const late = minutesAfter(scheduled.scheduledFor, 180);
    await expect(fireAt(deps, late)).resolves.toEqual({ fired: 0 });
    expect(await ids({ state: 'EXPIRED' })).toEqual([agendado]);
    expect(await ids({ state: 'SCHEDULED' })).toEqual([]);

    const all = await results.recipients(managerId, notice, PAGE);
    expect(all.total).toBe(3);
    const found = await results.recipients(managerId, notice, {
      ...PAGE,
      q: 'ALVARO',
    });
    expect(found.items.map((i) => i.userName)).toEqual(['Álvaro']);
    expect(found.total).toBe(1);
  }, 60_000);
});

describe('histórico — autoria com filtros', () => {
  it('gestor filtrando não vê envio de outro autor', async () => {
    const world = await seedWorld(deps);
    const managerId = await seedManager(world);
    await seedPeople(world, ['Ana', 'Bia']);
    const own = await sendAs(managerId, nowNotice(world));
    const other = await sendAs(world.adminId, nowNotice(world));
    await stamp(own.dispatchId, '2026-04-20T10:00:00.000-04:00');
    await stamp(other.dispatchId, '2026-04-20T11:00:00.000-04:00');
    const filter = {
      from: '2026-04-20',
      to: '2026-04-20',
      purpose: 'shift_notice',
      state: 'DISPATCHED',
    } as const;

    const mine = await deps.service.listDispatches(managerId, {
      ...PAGE,
      ...filter,
    });
    expect(mine.items.map((i) => i.id)).toEqual([own.dispatchId]);
    expect(mine.total).toBe(1);
    const admin = await deps.service.listDispatches(world.adminId, {
      ...PAGE,
      ...filter,
    });
    expect(admin.items.map((i) => i.id)).toEqual([
      other.dispatchId,
      own.dispatchId,
    ]);
    expect(admin.total).toBe(2);
  }, 60_000);
});

/** Roda `run` com o gestor sem `telefone.ver_completo` e devolve a chave no fim. */
async function withoutFullPhone<T>(run: () => Promise<T>): Promise<T> {
  const where = {
    role_key: { role: 'SUPERVISOR', key: 'telefone.ver_completo' },
  } as const;
  const permission = (granted: boolean) =>
    deps.prisma.rolePermission.upsert({
      where,
      create: { role: 'SUPERVISOR', key: 'telefone.ver_completo', granted },
      update: { granted },
    });
  await permission(false);
  try {
    return await run();
  } finally {
    await permission(true);
  }
}

describe('detalhe de envio reconferido — telefone conforme a permissão', () => {
  it('detalhe de envio reconferido mostra recheck e telefone usado conforme a permissão', async () => {
    const world = await seedWorld(deps);
    const managerId = await seedManager(world);
    const [ana, bia, caio] = await seedPeople(world, ['Ana', 'Bia', 'Caio']);
    const used = await linkContact(ana.id);
    const { dispatchId, scheduledFor } = await scheduleViaService(deps, {
      actorId: managerId,
      request: noticeAt(world),
    });
    await addException(deps, caio.id, 'DAY_OFF');
    const dani = await seedPerson(deps, world, 'Dani');
    const tick = minutesAfter(scheduledFor, 1);
    await expect(fireAt(deps, tick)).resolves.toEqual({ fired: 1 });

    const detail = await results.detail(managerId, dispatchId);
    expect(detail.recheck).toEqual({
      at: tick.toISOString(),
      skipped: 1,
      lateJoined: [expect.objectContaining({ userId: dani.id, name: 'Dani' })],
    });
    const phonesOf = async () =>
      (await results.recipients(managerId, dispatchId, PAGE)).items.map((i) => [
        i.userName,
        i.status,
        i.reason,
        i.phone,
      ]);
    expect(await phonesOf()).toEqual([
      ['Ana', 'QUEUED', null, used],
      ['Bia', 'QUEUED', null, bia.phoneE164],
      ['Caio', 'SKIPPED', 'DAY_OFF', caio.phoneE164],
    ]);
    const masked = await withoutFullPhone(phonesOf);
    expect(masked).toEqual([
      ['Ana', 'QUEUED', null, `•••• ${used.slice(-4)}`],
      ['Bia', 'QUEUED', null, `•••• ${bia.phoneE164?.slice(-4)}`],
      ['Caio', 'SKIPPED', 'DAY_OFF', `•••• ${caio.phoneE164?.slice(-4)}`],
    ]);
    // O detalhe leva o número do canal (a linha da área), nunca o de uma pessoa.
    const json = JSON.stringify(detail);
    const people = [used, bia.phoneE164, caio.phoneE164];
    expect(people.filter((p) => p && json.includes(p))).toEqual([]);
    expect(detail.channels).toHaveLength(1);
    trailHasNoPhone();
  }, 60_000);
});
