import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  SectorTargetInput,
  TeamAudienceRequest,
} from './dto/create-team-dispatch.dto';
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
  type Scheduled,
  type World,
} from './team-whatsapp.schedule-recheck.test-fixtures';

// Lote G, T10b: cenários T07 da reconferência na base vinculada (reunião e hora
// extra), contra Postgres real (GG3, DG4, GG10). Agendados criados pela prévia e
// pelo envio de verdade; o tick recebe `now` explícito; fila e auditoria são
// dublês (nunca envia). Em data de referência futura o vínculo é o espelho do
// cadastro (`User.sectorId`). Em série, cada teste fecha o seu agendado (o tick
// pega todo SCHEDULED vencido do banco).
let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

beforeEach(() => {
  deps.queue.addBulk.mockReset().mockResolvedValue([]);
  deps.audit.log.mockReset();
});

const sectorTarget = (
  world: World,
  extra: Partial<SectorTargetInput> = {},
): SectorTargetInput => ({
  type: 'sector',
  sectorIds: [world.sectorId],
  date: REFERENCE_DATE,
  ...extra,
});

/** Reunião (base vinculada) marcada para 09:00 da data de referência; a atividade é às 14:00. */
const meetingAt = (
  world: World,
  target: Partial<SectorTargetInput> = {},
  over: Partial<TeamAudienceRequest> = {},
): TeamAudienceRequest =>
  noticeAt(world, {
    purpose: 'meeting',
    text: 'Reunião de teste',
    at: { date: REFERENCE_DATE, time: '09:00' },
    activity: { date: REFERENCE_DATE, time: '14:00', place: 'Sala 2' },
    target: sectorTarget(world, { includeOff: true, ...target }),
    ...over,
  });

/** Hora extra nominal: só as pessoas marcadas, sem "Incluir folga". */
const overtimeAt = (world: World, userIds: string[]) =>
  meetingAt(
    world,
    { userIds, includeOff: false },
    {
      purpose: 'overtime',
      text: 'Hora extra de teste',
    },
  );

/** Setor novo com as pessoas dadas (ativas, 1º turno, contato autorizado). */
async function seedSector(...names: string[]) {
  const world = await seedWorld(deps);
  const people = await Promise.all(
    names.map((name) => seedPerson(deps, world, name)),
  );
  return { world, people };
}

/**
 * Agenda pelo caminho da tela e confere, antes de qualquer disparo, que o envio
 * nasceu congelado (base vinculada, FROZEN_RECHECK) com as pessoas esperadas.
 */
async function scheduleAssigned(
  world: World,
  request: TeamAudienceRequest,
  expected: { id: string }[],
): Promise<Scheduled> {
  const created = await scheduleViaService(deps, {
    actorId: world.adminId,
    request,
  });
  const stored = await storedOf(deps, created.dispatchId);
  const base = await deps.prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: created.dispatchId },
    select: { audienceBase: true },
  });
  expect(base).toEqual({ audienceBase: 'ASSIGNED' });
  expect(stored).toMatchObject({
    state: 'SCHEDULED',
    recheckedAt: null,
    schedulePolicy: 'FROZEN_RECHECK',
  });
  expect(stored.recipients.map((r) => r.userId).sort()).toEqual(
    expected.map((p) => p.id).sort(),
  );
  expect(stored.recipients.every((r) => r.status === 'SCHEDULED')).toBe(true);
  return created;
}

/** Apaga as exceções de escala da pessoa: quem estava de folga volta a se enquadrar. */
const clearExceptions = (userId: string) =>
  deps.prisma.staffScheduleException.deleteMany({ where: { userId } });

/** Pessoa que entrou depois, como o histórico a guarda (sem telefone). */
const lateOf = (world: World, person: { id: string; name: string | null }) => ({
  userId: person.id,
  name: person.name,
  sectorId: world.sectorId,
  sectorName: world.sectorName,
  shiftName: '1º turno',
  levelName: null,
});

/** Um tick um minuto depois da hora marcada (o disparo é do envio criado). */
async function fireOnce({ scheduledFor }: Scheduled): Promise<Date> {
  const tick = minutesAfter(scheduledFor, 1);
  await expect(fireAt(deps, tick)).resolves.toEqual({ fired: 1 });
  return tick;
}

type Outcome = [status: string, skipReason: string | null, queued: boolean];
const QUEUED: Outcome = ['QUEUED', null, true];
const skipped = (reason: string): Outcome => ['SKIPPED', reason, false];

/**
 * Depois do disparo: situação, motivo e fila de cada destinatário (por
 * usuário), `firedAt`, `recheckedAt` e `audienceLateJoined`; e que nada além
 * do esperado foi para a fila.
 */
async function expectOutcome(
  { dispatchId }: Scheduled,
  tick: Date,
  expected: Record<string, Outcome>,
  lateJoined: unknown[] = [],
) {
  const stored = await storedOf(deps, dispatchId);
  const queued = new Set(queuedIds(deps));
  const byUser = Object.fromEntries(
    stored.recipients.map((r): [string, Outcome] => [
      r.userId ?? 'sem-usuario',
      [r.status, r.skipReason, queued.has(r.id)],
    ]),
  );
  expect(byUser).toEqual(expected);
  expect(queuedIds(deps)).toHaveLength(
    Object.values(expected).filter(([, , wasQueued]) => wasQueued).length,
  );
  expect(stored).toMatchObject({
    state: 'DISPATCHED',
    firedAt: tick,
    recheckedAt: tick,
    audienceLateJoined: lateJoined,
  });
}

describe('aceite 20 — reunião em data e hora (lista da criação)', () => {
  it('aceite 20: reunião daqui a 3 dias às 9h (atividade às 14h) sai na hora marcada para a lista da criação', async () => {
    const { world, people } = await seedSector('Ana', 'Bia');
    const [ana, bia] = people;
    const request = meetingAt(world, { shiftIds: [FIRST_SHIFT] });
    const created = await scheduleAssigned(world, request, people);
    expect(created.scheduledFor).toEqual(
      new Date(`${REFERENCE_DATE}T09:00:00-04:00`),
    );
    // Entram no setor depois do agendamento, criadas fora da ordem do nome.
    const zeca = await seedPerson(deps, world, 'Zeca');
    const davi = await seedPerson(deps, world, 'Davi');

    // Nem o início do turno (06:00) nem um minuto antes da hora marcada disparam.
    const shiftStart = new Date(`${REFERENCE_DATE}T06:00:00-04:00`);
    await expect(fireAt(deps, shiftStart)).resolves.toEqual({ fired: 0 });
    const before = minutesAfter(created.scheduledFor, -1);
    await expect(fireAt(deps, before)).resolves.toEqual({ fired: 0 });
    expect(deps.queue.addBulk).not.toHaveBeenCalled();

    const tick = await fireOnce(created);
    await expectOutcome(created, tick, { [ana.id]: QUEUED, [bia.id]: QUEUED }, [
      lateOf(world, davi),
      lateOf(world, zeca),
    ]);
  });
});

describe('aceite 33 — férias lançadas depois, base vinculada', () => {
  it('aceite 33: reunião, férias lançadas depois para um convidado — Férias', async () => {
    const { world, people } = await seedSector('Ana', 'Bia', 'Caio');
    const [ana, bia, caio] = people;
    const created = await scheduleAssigned(world, meetingAt(world), people);
    await addException(deps, bia.id, 'VACATION');

    const tick = await fireOnce(created);

    await expectOutcome(created, tick, {
      [ana.id]: QUEUED,
      [bia.id]: skipped('VACATION'),
      [caio.id]: QUEUED,
    });
    expect(deps.audit.log).toHaveBeenCalledWith(
      'team_whatsapp.scheduled_fire',
      'TeamWhatsappDispatch',
      created.dispatchId,
      expect.objectContaining({
        queued: 2,
        recheckSkipped: 1,
        lateJoined: 0,
        policy: 'frozen_recheck',
      }),
    );
  });

  it('aceite 33: hora extra nominal, férias lançadas depois — Férias', async () => {
    const { world, people } = await seedSector('Ana', 'Bia', 'Caio');
    const [ana, bia, caio] = people;
    // Caio é marcado, mas está de folga na criação (sem "Incluir folga"): fica fora.
    await addException(deps, caio.id, 'DAY_OFF');
    const request = overtimeAt(world, [ana.id, bia.id, caio.id]);
    const created = await scheduleAssigned(world, request, [ana, bia]);
    await addException(deps, ana.id, 'VACATION');
    await clearExceptions(caio.id);

    const tick = await fireOnce(created);

    // Caio volta a se enquadrar, mas a seleção é nominal: sem linha, sem fila
    // e fora de "entraram depois" (a lista fica vazia).
    await expectOutcome(
      created,
      tick,
      { [ana.id]: skipped('VACATION'), [bia.id]: QUEUED },
      [],
    );
  });
});

describe('aceite 23 — folga lançada depois, com e sem "Incluir folga"', () => {
  it('aceite 23: reunião com Incluir folga, folga lançada depois — continua recebendo', async () => {
    const { world, people } = await seedSector('Ana', 'Bia', 'Caio');
    const [ana, bia, caio] = people;
    // Bia já estava de folga na criação (entrou por "Incluir folga").
    await addException(deps, bia.id, 'DAY_OFF');
    const created = await scheduleAssigned(world, meetingAt(world), people);
    await addException(deps, caio.id, 'DAY_OFF');

    const tick = await fireOnce(created);

    await expectOutcome(created, tick, {
      [ana.id]: QUEUED,
      [bia.id]: QUEUED,
      [caio.id]: QUEUED,
    });
  });

  it('aceite 23: sem Incluir folga, folga lançada depois — Folga; quem já estava de folga segue de fora', async () => {
    const { world, people } = await seedSector('Ana', 'Bia', 'Caio');
    const [ana, bia, caio] = people;
    await addException(deps, bia.id, 'DAY_OFF');
    const request = meetingAt(world, { includeOff: false });
    const created = await scheduleAssigned(world, request, [ana, caio]);
    await addException(deps, caio.id, 'DAY_OFF');

    const tick = await fireOnce(created);

    await expectOutcome(created, tick, {
      [ana.id]: QUEUED,
      [caio.id]: skipped('DAY_OFF'),
    });
  });
});

describe('aceite 34 — transferência de setor, base vinculada', () => {
  it('aceite 34: transferência de setor depois — Saiu do setor ou turno', async () => {
    const { world, people } = await seedSector('Ana', 'Bia');
    const [ana, bia] = people;
    const created = await scheduleAssigned(world, meetingAt(world), people);
    const other = await seedWorld(deps);
    await deps.prisma.user.update({
      where: { id: bia.id },
      data: { sectorId: other.sectorId },
    });

    const tick = await fireOnce(created);

    await expectOutcome(created, tick, {
      [ana.id]: QUEUED,
      [bia.id]: skipped('LEFT_SECTOR'),
    });
  });
});

describe('seleção nominal — ninguém "entra depois"', () => {
  it('seleção nominal: ninguém em audienceLateJoined, nem o marcado que volta a se enquadrar', async () => {
    const { world, people } = await seedSector('Ana', 'Bia', 'Caio');
    const [ana, bia, caio] = people;
    // Caio é marcado, mas está de folga na criação sem "Incluir folga": fica fora.
    await addException(deps, caio.id, 'DAY_OFF');
    const request = meetingAt(world, {
      userIds: [ana.id, bia.id, caio.id],
      includeOff: false,
    });
    const created = await scheduleAssigned(world, request, [ana, bia]);
    // A folga de Caio é apagada antes do tick; Duda chega depois, sem marca.
    await clearExceptions(caio.id);
    await seedPerson(deps, world, 'Duda');

    const tick = await fireOnce(created);

    // Mapa exato e total da fila: Caio sem linha e sem fila; "entraram depois" vazia.
    await expectOutcome(
      created,
      tick,
      { [ana.id]: QUEUED, [bia.id]: QUEUED },
      [],
    );
  });
});
