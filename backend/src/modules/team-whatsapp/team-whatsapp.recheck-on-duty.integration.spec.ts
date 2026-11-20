import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  addDays,
  todayIn,
  toDbDate,
  type CivilDate,
} from '../staff-schedule/civil-date';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import {
  FIRST_SHIFT,
  REFERENCE_DATE,
  addException,
  fireAt,
  minutesAfter,
  noticeAt,
  queuedIds,
  scheduleViaService,
  seedPerson,
  seedWorld,
  startRecheckDeps,
  storedOf,
  type RecheckDeps,
  type World,
} from './team-whatsapp.schedule-recheck.test-fixtures';

// Lote G, T10a: cenários T07 da reconferência do aviso de turno (base em
// serviço) ponta a ponta contra Postgres real: criado pela prévia e pelo envio,
// cadastro ou escala mudados depois, tick com `now` explícito. Fila e número
// são dublês (nada é enviado). Os testes rodam em série e cada um dispara só o
// seu agendado (o tick pega todo SCHEDULED vencido do banco).
const SECOND_SHIFT = 'shift_second';
const FIRST_SHIFT_NAME = '1º turno';

let deps: RecheckDeps;
let stop: () => Promise<void>;
let night: { id: string };

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
  night = await deps.prisma.shift.create({
    data: {
      name: 'Noturno T10a',
      startTime: '23:00',
      endTime: '07:00',
      sortOrder: 99,
    },
    select: { id: true },
  });
}, 180_000);

afterAll(async () => {
  await stop?.();
});

beforeEach(() => {
  deps.queue.addBulk.mockReset().mockResolvedValue([]);
  deps.audit.log.mockReset();
});

// Falha antes do `fire` deixaria um envio SCHEDULED vencido no banco, e o tick
// do teste seguinte o dispararia junto (`{ fired: 2 }`). Cancela o que sobrou,
// sem afrouxar o `{ fired: 1 }` de `fire`.
afterEach(async () => {
  await deps.prisma.teamWhatsappDispatch.updateMany({
    where: { state: 'SCHEDULED' },
    data: { state: 'CANCELLED' },
  });
});

type Person = Awaited<ReturnType<typeof seedPerson>>;
type Notice = {
  world: World;
  people: Person[];
  dispatchId: string;
  scheduledFor: Date;
};

/** Cria as pessoas no turno e agenda pelo caminho da tela; confere o congelado. */
async function scheduleFrozen(
  names: string[],
  shiftId: string,
  requestOf: (world: World) => TeamAudienceRequest,
): Promise<Notice> {
  const world = await seedWorld(deps);
  const people: Person[] = [];
  for (const name of names) {
    people.push(await seedPerson(deps, world, name, { shiftId }));
  }
  const scheduled = await scheduleViaService(deps, {
    actorId: world.adminId,
    request: requestOf(world),
  });
  const notice = { world, people, ...scheduled };
  // Não pode passar vazio: todos foram congelados, um a um, antes do disparo.
  expect((await snapshot(notice)).outcomes).toEqual(
    Object.fromEntries(names.map((n) => [n, ['SCHEDULED', null]])),
  );
  return notice;
}

/** Aviso do 1º turno, em "data e hora" (08:00 da data de referência). */
const scheduleNotice = (names: string[]) =>
  scheduleFrozen(names, FIRST_SHIFT, (world) => noticeAt(world));

/** Aviso do turno noturno (23:00 da data de referência), no início do turno. */
const scheduleNightNotice = (names: string[]) =>
  scheduleFrozen(names, night.id, (world) =>
    noticeAt(world, {
      when: 'shift_start',
      at: undefined,
      target: {
        type: 'sector',
        sectorIds: [world.sectorId],
        shiftIds: [night.id],
        date: REFERENCE_DATE,
      },
    }),
  );

type Outcomes = Record<string, [string, string | null]>;

/** Situação e motivo de cada destinatário e quem foi para a fila, pelo nome. */
async function snapshot({ dispatchId, people }: Notice) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const { recipients } = await storedOf(deps, dispatchId);
  const labelOf = new Map(
    recipients.map((r) => [
      r.id,
      nameOf.get(r.userId ?? '') ?? `fora do envio ${r.id}`,
    ]),
  );
  const outcomes: Outcomes = {};
  for (const r of recipients) {
    outcomes[labelOf.get(r.id) ?? r.id] = [r.status, r.skipReason];
  }
  const queued = queuedIds(deps)
    .map((id) => labelOf.get(id) ?? `fora do envio ${id}`)
    .sort();
  return { outcomes, queued };
}

/** Um tick do worker no instante dado: tem de disparar exatamente este envio. */
async function fire(tick: Date): Promise<Date> {
  await expect(fireAt(deps, tick)).resolves.toEqual({ fired: 1 });
  return tick;
}

/** Tick um minuto depois da hora marcada (mesmo dia da data de referência). */
const fireOnTime = ({ scheduledFor }: Notice) =>
  fire(minutesAfter(scheduledFor, 1));

/**
 * 00:30 do dia seguinte ao turno das 23h (dentro do teto de 2 h), calculado a
 * partir de `scheduledFor`; confere que o tick já cai no dia seguinte.
 */
function overnightTick({ scheduledFor }: Notice): Date {
  const fireDay = addDays(REFERENCE_DATE, 1);
  expect(scheduledFor.toISOString()).toBe(`${fireDay}T03:00:00.000Z`);
  const tick = minutesAfter(scheduledFor, 90);
  expect(todayIn(tick)).toBe(fireDay);
  return tick;
}

/** Envio disparado e reconferido no tick, com "entraram depois" no gravado. */
async function expectFired(
  { dispatchId }: Notice,
  tick: Date,
  lateJoined: unknown[] = [],
) {
  const stored = await storedOf(deps, dispatchId);
  expect(stored).toMatchObject({
    state: 'DISPATCHED',
    firedAt: tick,
    recheckedAt: tick,
    schedulePolicy: 'FROZEN_RECHECK',
  });
  expect(stored.audienceLateJoined).toEqual(lateJoined);
}

/** Trilha do disparo (só ids e contagens, GG8) em todas as chamadas do dublê. */
const firedTrails = () =>
  deps.audit.log.mock.calls.filter(
    ([n]) => n === 'team_whatsapp.scheduled_fire',
  );

const trailOf = (
  dispatchId: string,
  counts: { queued: number; recheckSkipped: number; lateJoined?: number },
) => [
  [
    'team_whatsapp.scheduled_fire',
    'TeamWhatsappDispatch',
    dispatchId,
    {
      dispatchId,
      skipped: 0,
      failed: 0,
      policy: 'frozen_recheck',
      lateJoined: 0,
      ...counts,
    },
  ],
];

describe('aceites 21 e 39 — férias e folga lançadas depois', () => {
  it('aceite 21: aviso de turno, férias lançadas depois — pulada com Férias; os outros enfileirados; recheckedAt gravado', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia', 'Caio']);
    await addException(deps, notice.people[0].id, 'VACATION');

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: {
        Ana: ['SKIPPED', 'VACATION'],
        Bia: ['QUEUED', null],
        Caio: ['QUEUED', null],
      },
      queued: ['Bia', 'Caio'],
    });
    await expectFired(notice, tick);
    expect(firedTrails()).toEqual(
      trailOf(notice.dispatchId, { queued: 2, recheckSkipped: 1 }),
    );
  });

  it('aceite 39: folga lançada depois — Folga', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia']);
    await addException(deps, notice.people[1].id, 'DAY_OFF');

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: { Ana: ['QUEUED', null], Bia: ['SKIPPED', 'DAY_OFF'] },
      queued: ['Ana'],
    });
    await expectFired(notice, tick);
  });
});

describe('aceite 32 e inativa — troca de turno e desativação depois', () => {
  it('aceite 32: troca de turno lançada depois — Saiu do setor ou turno', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia']);
    await deps.prisma.user.update({
      where: { id: notice.people[0].id },
      data: { shiftId: SECOND_SHIFT },
    });

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: { Ana: ['SKIPPED', 'LEFT_SECTOR'], Bia: ['QUEUED', null] },
      queued: ['Bia'],
    });
    await expectFired(notice, tick);
  });

  it('pessoa desativada depois — Inativa', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia']);
    await deps.prisma.user.update({
      where: { id: notice.people[0].id },
      data: { isActive: false },
    });

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: { Ana: ['SKIPPED', 'INACTIVE'], Bia: ['QUEUED', null] },
      queued: ['Bia'],
    });
    await expectFired(notice, tick);
    expect(firedTrails()).toEqual(
      trailOf(notice.dispatchId, { queued: 1, recheckSkipped: 1 }),
    );
  });
});

describe('aceite 32 — troca de turno lançada na escala (SHIFT_SWAP)', () => {
  it('aceite 32: exceção SHIFT_SWAP para o 2º turno lançada depois — Saiu do setor ou turno', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia']);
    await deps.prisma.staffScheduleException.create({
      data: {
        userId: notice.people[0].id,
        kind: 'SHIFT_SWAP',
        startDate: toDbDate(REFERENCE_DATE),
        endDate: toDbDate(REFERENCE_DATE),
        shiftId: SECOND_SHIFT,
      },
    });

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: { Ana: ['SKIPPED', 'LEFT_SECTOR'], Bia: ['QUEUED', null] },
      queued: ['Bia'],
    });
    await expectFired(notice, tick);
  });
});

describe('aceite 24 — todos pulados', () => {
  it('aceite 24: todos pulados — nada enfileirado, envio DISPATCHED só com SKIPPED', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia', 'Caio']);
    const [ana, bia, caio] = notice.people;
    await addException(deps, ana.id, 'VACATION');
    await addException(deps, bia.id, 'DAY_OFF');
    await deps.prisma.user.update({
      where: { id: caio.id },
      data: { shiftId: SECOND_SHIFT },
    });

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: {
        Ana: ['SKIPPED', 'VACATION'],
        Bia: ['SKIPPED', 'DAY_OFF'],
        Caio: ['SKIPPED', 'LEFT_SECTOR'],
      },
      queued: [],
    });
    expect(deps.queue.addBulk).not.toHaveBeenCalled();
    await expectFired(notice, tick);
    expect(firedTrails()).toEqual(
      trailOf(notice.dispatchId, { queued: 0, recheckSkipped: 3 }),
    );
  });
});

describe('aceite 22 — entrou depois (todos os aptos)', () => {
  it('aceite 22: todos os aptos, pessoa acrescentada ao setor depois — não recebe e fica em audienceLateJoined', async () => {
    const notice = await scheduleNotice(['Ana', 'Bia']);
    const { world } = notice;
    // Fora de ordem: a lista de "entraram depois" sai pelo nome, sem telefone.
    const zeca = await seedPerson(deps, world, 'Zeca');
    const abel = await seedPerson(deps, world, 'Abel');
    const joined = (p: Person) => ({
      userId: p.id,
      name: p.name,
      sectorId: world.sectorId,
      sectorName: world.sectorName,
      shiftName: FIRST_SHIFT_NAME,
      levelName: null,
    });

    const tick = await fireOnTime(notice);

    expect(await snapshot(notice)).toEqual({
      outcomes: { Ana: ['QUEUED', null], Bia: ['QUEUED', null] },
      queued: ['Ana', 'Bia'],
    });
    await expectFired(notice, tick, [joined(abel), joined(zeca)]);
    expect(firedTrails()).toEqual(
      trailOf(notice.dispatchId, {
        queued: 2,
        recheckSkipped: 0,
        lateJoined: 2,
      }),
    );
  });
});

/** Transferência depois do agendamento: a linha do setor fecha na véspera do disparo. */
async function transferOnFireDay(
  { people, world }: Notice,
  toSectorId: string,
  fireDay: CivilDate,
) {
  const [ana] = people;
  await deps.prisma.userAssignment.createMany({
    data: [
      {
        userId: ana.id,
        sectorId: world.sectorId,
        shiftId: night.id,
        validTo: toDbDate(REFERENCE_DATE),
      },
      {
        userId: ana.id,
        sectorId: toSectorId,
        shiftId: night.id,
        validFrom: toDbDate(fireDay),
      },
    ],
  });
  await deps.prisma.user.update({
    where: { id: ana.id },
    data: { sectorId: toSectorId },
  });
}

describe('aceite 35 — turno noturno, disparo no dia seguinte', () => {
  it('aceite 35: turno noturno — a reconferência usa o rosterDate gravado, não a data do disparo', async () => {
    const notice = await scheduleNightNotice(['Ana', 'Bia', 'Caio']);
    const [ana, bia] = notice.people;
    const tick = overnightTick(notice);
    // Férias na data de referência retiram; as do dia do disparo não valem.
    await addException(deps, ana.id, 'VACATION', REFERENCE_DATE);
    await addException(deps, bia.id, 'VACATION', addDays(REFERENCE_DATE, 1));

    await fire(tick);

    expect(await snapshot(notice)).toEqual({
      outcomes: {
        Ana: ['SKIPPED', 'VACATION'],
        Bia: ['QUEUED', null],
        Caio: ['QUEUED', null],
      },
      queued: ['Bia', 'Caio'],
    });
    await expectFired(notice, tick);
  });

  it('aceite 35: disparo no dia seguinte ao rosterDate (turno das 23h, tick 00:30) — usa o vínculo da data de referência', async () => {
    const notice = await scheduleNightNotice(['Ana', 'Bia']);
    const outro = await seedWorld(deps);
    const tick = overnightTick(notice);
    // Cadastro já no outro setor; o vínculo da data de referência é o do setor.
    await transferOnFireDay(notice, outro.sectorId, todayIn(tick));

    await fire(tick);

    expect(await snapshot(notice)).toEqual({
      outcomes: { Ana: ['QUEUED', null], Bia: ['QUEUED', null] },
      queued: ['Ana', 'Bia'],
    });
    await expectFired(notice, tick);
  });
});
