import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Logger } from '@nestjs/common';
import { teamScheduledListResponseSchema } from '../../schemas/contracts/team-whatsapp.schema';
import { SCHEDULE_GRACE_MS } from './scheduled-recheck';
import {
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
} from './team-whatsapp.schedule-recheck.test-fixtures';

// Lote G, T6b: reconferência ligada ao claim do agendado e vencimento, contra
// Postgres real (GG4, DG2, DG5). Agendados criados pela prévia e pelo envio de
// verdade; o tick recebe `now` explícito. Os testes rodam em série e cada um
// fecha os seus agendados (o tick pega todo SCHEDULED vencido do banco).
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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Aviso de turno agendado (política FROZEN_RECHECK) para as pessoas dadas. */
async function scheduleNotice(names: string[]) {
  const world = await seedWorld(deps);
  const people = await Promise.all(
    names.map((name) => seedPerson(deps, world, name)),
  );
  const scheduled = await scheduleViaService(deps, {
    actorId: world.adminId,
    request: noticeAt(world),
  });
  return { world, people, ...scheduled };
}

/** Agendado de antes desta versão: sem política (dispara pela regra antiga). */
const makeLegacy = (dispatchId: string) =>
  deps.prisma.teamWhatsappDispatch.update({
    where: { id: dispatchId },
    data: { schedulePolicy: null },
  });

const statusesOf = async (dispatchId: string) =>
  (await storedOf(deps, dispatchId)).recipients.map((r) => r.status);

/** Ids dos destinatários e da fila, na mesma ordem (a do JS) para comparar. */
const recipientIdsOf = async (dispatchId: string) =>
  (await storedOf(deps, dispatchId)).recipients.map((r) => r.id).sort();
const sortedQueued = () => [...queuedIds(deps)].sort();

/** Trilhas de uma ação (o agendamento também grava as dele no mesmo dublê). */
const trailsOf = (action: string) =>
  deps.audit.log.mock.calls.filter(([name]) => name === action);

/**
 * Espia `claimScheduled` e segura cada chamada do envio até as duas chegarem:
 * os dois ticks já listaram o agendado antes de qualquer commit, então a disputa
 * é real (T6b-m1). Sem a segunda chamada em 3 s solta mesmo assim e o teste
 * falha na contagem, sem deixar o envio SCHEDULED para o teste seguinte.
 */
function holdClaimsUntilBoth(dispatchId: string) {
  const original = deps.repo.claimScheduled.bind(
    deps.repo,
  ) as typeof deps.repo.claimScheduled;
  let arrived = 0;
  let release: () => void = () => undefined;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  return vi
    .spyOn(deps.repo, 'claimScheduled')
    .mockImplementation(async (...args) => {
      if (args[0] === dispatchId) {
        if (++arrived === 2) release();
        await Promise.race([
          both,
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }
      return original(...args);
    });
}

describe('aceite 25 — falha e disputa no disparo (GG4)', () => {
  it('aceite 25: erro na reconferência (loadDayPeopleMany lança) — nada enfileirado, envio SCHEDULED; o tick seguinte dispara uma vez', async () => {
    const { dispatchId, scheduledFor } = await scheduleNotice(['Ana', 'Bia']);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(deps.repo, 'loadDayPeopleMany').mockRejectedValueOnce(
      new Error('leitura indisponível'),
    );

    await expect(fireAt(deps, minutesAfter(scheduledFor, 1))).resolves.toEqual({
      fired: 0,
    });
    expect(await storedOf(deps, dispatchId)).toMatchObject({
      state: 'SCHEDULED',
      firedAt: null,
      recheckedAt: null,
    });
    expect(await statusesOf(dispatchId)).toEqual(['SCHEDULED', 'SCHEDULED']);
    expect(deps.queue.addBulk).not.toHaveBeenCalled();

    const next = minutesAfter(scheduledFor, 2);
    await expect(fireAt(deps, next)).resolves.toEqual({ fired: 1 });
    expect(sortedQueued()).toEqual(await recipientIdsOf(dispatchId));
    expect(await storedOf(deps, dispatchId)).toMatchObject({
      state: 'DISPATCHED',
      firedAt: next,
      recheckedAt: next,
    });
  });
});

describe('aceite 25 — dois fireDue em disputa de verdade (GG4)', () => {
  it('aceite 25: dois fireDue concorrentes — os dois chegam ao claim do envio; cada mensagem enfileirada uma vez', async () => {
    const { dispatchId, scheduledFor } = await scheduleNotice([
      'Caio',
      'Duda',
      'Edu',
    ]);
    const tick = minutesAfter(scheduledFor, 1);
    const claim = holdClaimsUntilBoth(dispatchId);

    const results = await Promise.all([fireAt(deps, tick), fireAt(deps, tick)]);

    expect(claim.mock.calls.filter(([id]) => id === dispatchId)).toHaveLength(
      2,
    );
    expect(results.map((r) => r.fired).sort()).toEqual([0, 1]);
    expect(sortedQueued()).toEqual(await recipientIdsOf(dispatchId));
    expect(await statusesOf(dispatchId)).toEqual(Array(3).fill('QUEUED'));
    expect(trailsOf('team_whatsapp.scheduled_fire')).toHaveLength(1);
  });
});

describe('aceites 26 e 36 — vencimento no teto de 2 h (DG5)', () => {
  it('aceite 26: agendado novo vencido há mais de 2 h — EXPIRED, nada enfileirado', async () => {
    const { dispatchId, scheduledFor } = await scheduleNotice(['Fabi', 'Gil']);
    const tick = new Date(scheduledFor.getTime() + SCHEDULE_GRACE_MS + 60_000);

    await expect(fireAt(deps, tick)).resolves.toEqual({ fired: 0 });

    const stored = await storedOf(deps, dispatchId);
    expect(stored).toMatchObject({
      state: 'EXPIRED',
      firedAt: null,
      recheckedAt: null,
    });
    expect(stored.recipients.map((r) => [r.status, r.skipReason])).toEqual(
      Array(2).fill(['SKIPPED', 'EXPIRED']),
    );
    expect(deps.queue.addBulk).not.toHaveBeenCalled();
    expect(trailsOf('team_whatsapp.scheduled_expired')).toEqual([
      [
        'team_whatsapp.scheduled_expired',
        'TeamWhatsappDispatch',
        dispatchId,
        { dispatchId, skipped: 2 },
      ],
    ]);
  });

  it('aceite 36: agendado antigo (política nula) vencido há mais de 2 h — EXPIRED', async () => {
    const { dispatchId, scheduledFor } = await scheduleNotice(['Hugo']);
    await makeLegacy(dispatchId);
    const tick = new Date(scheduledFor.getTime() + 3 * SCHEDULE_GRACE_MS);

    await expect(fireAt(deps, tick)).resolves.toEqual({ fired: 0 });

    expect(await storedOf(deps, dispatchId)).toMatchObject({
      state: 'EXPIRED',
      schedulePolicy: null,
      recipients: [expect.objectContaining({ skipReason: 'EXPIRED' })],
    });
    expect(deps.queue.addBulk).not.toHaveBeenCalled();
  });
});

describe('aceite 27 — agendado antigo dispara pela regra antiga', () => {
  it('aceite 27: agendado antigo dentro do prazo dispara pela regra antiga, sem recheckedAt', async () => {
    const { dispatchId, scheduledFor, people } = await scheduleNotice([
      'Iris',
      'Juca',
    ]);
    await makeLegacy(dispatchId);
    // Férias lançadas depois: a regra antiga não reconfere, então não pula.
    await addException(deps, people[0].id, 'VACATION');
    const tick = minutesAfter(scheduledFor, 1);

    await expect(fireAt(deps, tick)).resolves.toEqual({ fired: 1 });

    expect(await statusesOf(dispatchId)).toEqual(['QUEUED', 'QUEUED']);
    expect(await storedOf(deps, dispatchId)).toMatchObject({
      state: 'DISPATCHED',
      recheckedAt: null,
      audienceLateJoined: null,
    });
    expect(trailsOf('team_whatsapp.scheduled_fire')).toEqual([
      [
        'team_whatsapp.scheduled_fire',
        'TeamWhatsappDispatch',
        dispatchId,
        {
          dispatchId,
          queued: 2,
          skipped: 0,
          failed: 0,
          policy: null,
          recheckSkipped: 0,
          lateJoined: 0,
        },
      ],
    ]);
  });
});

describe('lista de agendados — "data e hora" com todos os turnos (G1/G3)', () => {
  it('agendado em data e hora com todos os turnos aparece na lista e cancela', async () => {
    const world = await seedWorld(deps);
    await seedPerson(deps, world, 'Lia');
    // Reunião sem turnos escolhidos (todos): o envio não grava turno.
    const { dispatchId, scheduledFor } = await scheduleViaService(deps, {
      actorId: world.adminId,
      request: noticeAt(world, {
        purpose: 'meeting',
        text: 'Reunião de teste',
        activity: { date: REFERENCE_DATE, time: '14:00', place: 'Sala 2' },
        target: {
          type: 'sector',
          sectorIds: [world.sectorId],
          date: REFERENCE_DATE,
        },
      }),
    });

    const list = teamScheduledListResponseSchema.parse(
      await deps.schedule.listScheduled(world.adminId, {
        page: 1,
        pageSize: 50,
      }),
    );
    expect(list.items.find((i) => i.id === dispatchId)).toMatchObject({
      shift: null,
      scheduledFor: scheduledFor.toISOString(),
      rosterDate: REFERENCE_DATE,
    });

    await expect(
      deps.schedule.cancel(world.adminId, dispatchId),
    ).resolves.toEqual({ id: dispatchId, state: 'CANCELLED' });
    expect((await storedOf(deps, dispatchId)).state).toBe('CANCELLED');
    expect(await statusesOf(dispatchId)).toEqual(['CANCELLED']);
  });
});
