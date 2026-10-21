import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import {
  createTeamDispatchResponseSchema,
  teamScheduledListResponseSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import type { TeamActor } from './team-whatsapp.policy';
import type {
  ScheduledRow,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import {
  ADMIN,
  MANAGER,
  SHIFT_FIRST,
  SHIFT_SECOND,
  channel,
  createHarness,
  givenSector,
  member,
  onShift,
  sector,
  type Harness,
} from './team-whatsapp.test-fixtures';

// Noite de 21/10 começa às 22:00 de Manaus (UTC−4) = 2026-10-22T02:00Z.
const NOITE = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const DATE = '2026-10-21';
const OTHER_MANAGER: TeamActor = {
  ...MANAGER,
  id: 'g',
  managedSectorIds: ['s2'],
};
const ana = member({ id: 'ana', name: 'Ana', ...onShift(NOITE) });
const bia = member({
  id: 'bia',
  name: 'Bia',
  phoneE164: null,
  ...onShift(NOITE),
});
const caio = member({ id: 'caio', name: 'Caio', ...onShift(SHIFT_FIRST) });

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
  h = createHarness();
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.listActiveShifts.mockResolvedValue([SHIFT_FIRST, SHIFT_SECOND, NOITE]);
  givenSector(h, [ana, bia, caio]);
});
afterEach(() => {
  vi.useRealTimers();
});

type SectorTarget = Extract<
  CreateTeamDispatchInput['target'],
  { type: 'sector' }
>;
const schedule = (extra: Partial<SectorTarget> = {}) =>
  h.service.dispatch(ADMIN.id, {
    channelId: 'c1',
    text: 'Oi',
    when: 'shift_start',
    target: {
      type: 'sector',
      sectorId: 's1',
      date: DATE,
      shiftId: NOITE.id,
      ...extra,
    },
  });
const created = () => h.repo.createDispatch.mock.calls[0][0];
const statuses = () =>
  created().recipients.map((r) => [r.userName, r.status, r.skipReason]);
const expectNothingCreated = () => {
  expect(h.repo.createDispatch.mock.calls).toHaveLength(0);
  expect(h.queue.addBulk.mock.calls).toHaveLength(0);
  expect(h.audit.log.mock.calls).toHaveLength(0);
};

describe('agendar no início do turno', () => {
  it('agendar Noite de 21/10 às 16:00 de Manaus: grava SCHEDULED para 02:00Z, não enfileira', async () => {
    const out = createTeamDispatchResponseSchema.parse(await schedule());

    expect(out).toEqual({
      dispatchId: 'd1',
      queued: 0,
      scheduled: 1,
      scheduledFor: '2026-10-22T02:00:00.000Z',
      skipped: [{ userId: 'bia', name: 'Bia', reason: 'NO_PHONE' }],
    });
    expect(created()).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
      shiftId: NOITE.id,
      rosterDate: DATE,
    });
    expect(h.queue.addBulk.mock.calls).toHaveLength(0);
    expect(h.audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.schedule',
        'TeamWhatsappDispatch',
        'd1',
        { actorId: ADMIN.id, dispatchId: 'd1', scheduled: 1, skipped: 1 },
      ],
    ]);
  });

  it('sem telefone fica SKIPPED NO_PHONE no agendamento; o resto, SCHEDULED', async () => {
    await schedule();
    expect(statuses()).toEqual([
      ['Ana', 'SCHEDULED', null],
      ['Bia', 'SKIPPED', 'NO_PHONE'],
    ]);
  });
});

describe('início já passou → 422 schedule_in_past sem efeito', () => {
  it.each([
    ['igual ao início', '2026-10-21T10:00:00Z'],
    ['depois do início', '2026-10-21T12:00:00Z'],
  ])('1º turno de 21/10, agora %s', async (_label, now) => {
    vi.setSystemTime(new Date(now));
    givenSector(h, [member({ id: 'caio', ...onShift(SHIFT_FIRST) })]);
    await expect(schedule({ shiftId: SHIFT_FIRST.id })).rejects.toMatchObject({
      code: 'team_whatsapp.schedule_in_past',
      status: 422,
    });
    expectNothingCreated();
  });

  it('1º turno de 21/10 às 09:59Z (05:59 em Manaus) → aceita para 10:00Z', async () => {
    vi.setSystemTime(new Date('2026-10-21T09:59:00Z'));
    givenSector(h, [member({ id: 'caio', ...onShift(SHIFT_FIRST) })]);
    const out = await schedule({ shiftId: SHIFT_FIRST.id });
    expect(out.scheduledFor).toBe('2026-10-21T10:00:00.000Z');
  });
});

describe('agendar valida como o envio imediato (sem efeito)', () => {
  it.each<[string, () => void, Partial<SectorTarget>, object]>([
    [
      'seleção fora da escala → 422 invalid_selection',
      () => undefined,
      { userIds: ['caio'] },
      { code: 'team_whatsapp.invalid_selection', status: 422 },
    ],
    [
      'canal desconectado → 409 (D7)',
      () =>
        h.repo.findChannel.mockResolvedValue(
          channel({ connectionEvents: [{ state: 'close' }] }),
        ),
      {},
      { code: 'team_whatsapp.channel_disconnected', status: 409 },
    ],
    [
      'só quem não tem telefone → 422 no_recipients (D9)',
      () => givenSector(h, [bia]),
      {},
      { code: 'team_whatsapp.no_recipients', status: 422 },
    ],
  ])('%s', async (_label, arrange, extra, error) => {
    arrange();
    await expect(schedule(extra)).rejects.toMatchObject(error);
    expectNothingCreated();
  });
});

type ScheduleHarness = {
  repo: DeepMockProxy<TeamWhatsappRepository>;
  audit: DeepMockProxy<AuditService>;
  service: TeamWhatsappScheduleService;
};
const scheduleHarness = (): ScheduleHarness => {
  const repo = mockDeep<TeamWhatsappRepository>();
  const audit = mockDeep<AuditService>();
  repo.findDispatchForCancel.mockResolvedValue({
    id: 'd1',
    targetType: 'SECTOR',
    targetId: 's1',
    state: 'SCHEDULED',
  });
  repo.findSector.mockResolvedValue(sector());
  repo.cancelScheduled.mockResolvedValue(true);
  return {
    repo,
    audit,
    service: new TeamWhatsappScheduleService(repo, audit, mockDeep<Queue>()),
  };
};

describe('cancelar agendado — ADMIN e política', () => {
  let s: ScheduleHarness;
  beforeEach(() => {
    s = scheduleHarness();
  });

  it('cancelar: ADMIN → state CANCELLED, auditoria', async () => {
    s.repo.findActor.mockResolvedValue(ADMIN);
    await expect(s.service.cancel(ADMIN.id, 'd1')).resolves.toEqual({
      id: 'd1',
      state: 'CANCELLED',
    });
    expect(s.repo.cancelScheduled.mock.calls).toEqual([
      ['d1', ADMIN.id, new Date('2026-10-21T20:00:00Z')],
    ]);
    expect(s.audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.cancel',
        'TeamWhatsappDispatch',
        'd1',
        { actorId: ADMIN.id, dispatchId: 'd1' },
      ],
    ]);
  });

  it('cancelar: gestor de outro setor → 403, nada cancelado', async () => {
    s.repo.findActor.mockResolvedValue(OTHER_MANAGER);
    await expect(
      s.service.cancel(OTHER_MANAGER.id, 'd1'),
    ).rejects.toMatchObject({
      code: 'team_whatsapp.forbidden',
      status: 403,
    });
    expect(s.repo.cancelScheduled.mock.calls).toHaveLength(0);
  });
});

// Ruling T9: setor desativado depois do agendamento — o ADMIN ainda cancela;
// o gestor depende de `canSendToSector` (setor ativo) e leva 403.
describe('cancelar agendado — setor desativado depois do agendamento', () => {
  it.each<[string, TeamActor, object]>([
    ['ADMIN cancela', ADMIN, { id: 'd1', state: 'CANCELLED' }],
    [
      'gestor do setor leva 403',
      MANAGER,
      { code: 'team_whatsapp.forbidden', status: 403 },
    ],
  ])('%s', async (_, actor, expected) => {
    const s = scheduleHarness();
    s.repo.findActor.mockResolvedValue(actor);
    s.repo.findSector.mockResolvedValue(sector({ isActive: false }));
    const result = await s.service
      .cancel(actor.id, 'd1')
      .catch((e: unknown) => e);
    expect(result).toMatchObject(expected);
    expect(s.repo.cancelScheduled.mock.calls).toHaveLength(
      actor.role === 'ADMIN' ? 1 : 0,
    );
  });
});

describe('cancelar agendado — recusas', () => {
  let s: ScheduleHarness;
  beforeEach(() => {
    s = scheduleHarness();
  });

  it('cancelar já disparado ou cancelado → 409 not_cancellable, sem auditoria', async () => {
    s.repo.findActor.mockResolvedValue(MANAGER);
    s.repo.cancelScheduled.mockResolvedValue(false);
    await expect(s.service.cancel(MANAGER.id, 'd1')).rejects.toMatchObject({
      code: 'team_whatsapp.not_cancellable',
      status: 409,
    });
    expect(s.audit.log.mock.calls).toHaveLength(0);
  });

  it('cancelar inexistente → 404', async () => {
    s.repo.findActor.mockResolvedValue(ADMIN);
    s.repo.findDispatchForCancel.mockResolvedValue(null);
    await expect(s.service.cancel(ADMIN.id, 'x')).rejects.toMatchObject({
      code: 'team_whatsapp.dispatch_not_found',
      status: 404,
    });
    expect(s.repo.cancelScheduled.mock.calls).toHaveLength(0);
  });
});

const scheduledRow = (over: Partial<ScheduledRow> = {}): ScheduledRow => ({
  id: 'd1',
  scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
  rosterDate: new Date('2026-10-21T00:00:00.000Z'),
  targetLabel: 'Produção · Noite · 21/10',
  // Snapshot gravado no agendamento (o turno atual pode ter mudado de hora).
  shiftId: NOITE.id,
  shiftName: 'Noite',
  shiftStartTime: '22:00',
  shiftEndTime: '06:00',
  author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
  channel: { id: 'c1', name: 'Canal equipe' },
  recipientCount: 2,
  ...over,
});

describe('listScheduled', () => {
  let s: ScheduleHarness;
  beforeEach(() => {
    s = scheduleHarness();
    s.repo.listScheduled.mockResolvedValue([scheduledRow()]);
  });

  it.each<[string, TeamActor, string[] | null]>([
    ['ADMIN vê todos', ADMIN, null],
    ['gestor só os setores que gerencia', MANAGER, ['s1']],
  ])('%s', async (_label, actor, onlySectorIds) => {
    s.repo.findActor.mockResolvedValue(actor);
    await s.service.listScheduled(actor.id);
    expect(s.repo.listScheduled.mock.calls).toEqual([[onlySectorIds]]);
  });

  it('quem não é ADMIN nem gestor → 403', async () => {
    s.repo.findActor.mockResolvedValue({ ...MANAGER, managedSectorIds: [] });
    await expect(s.service.listScheduled('x')).rejects.toMatchObject({
      status: 403,
    });
    expect(s.repo.listScheduled.mock.calls).toHaveLength(0);
  });

  it('shift vem do snapshot (startTime gravado), não do Shift atual', async () => {
    s.repo.findActor.mockResolvedValue(ADMIN);
    s.repo.listActiveShifts.mockResolvedValue([
      { ...NOITE, startTime: '23:00' },
    ]);
    const out = teamScheduledListResponseSchema.parse(
      await s.service.listScheduled(ADMIN.id),
    );
    expect(out.items).toEqual([
      {
        id: 'd1',
        scheduledFor: '2026-10-22T02:00:00.000Z',
        rosterDate: DATE,
        // Gravado: 22:00 (o Shift atual, acima, diz 23:00).
        shift: NOITE,
        label: 'Produção · Noite · 21/10',
        recipientCount: 2,
        channel: { id: 'c1', name: 'Canal equipe' },
        author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
      },
    ]);
  });
});
