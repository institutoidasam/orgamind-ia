import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffScheduleBoard } from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { BoardPersonRow, ScheduleData } from './staff-schedule.repository';
import { StaffScheduleService } from './staff-schedule.service';

const PROD = { id: 'sector-prod', name: 'Produção' };
const LOG = { id: 'sector-log', name: 'Logística' };
const ACTIVE_SECTORS = [LOG, PROD];
const MORNING = {
  id: 'shift-morning',
  name: 'Manhã',
  startTime: '06:00',
  endTime: '14:00',
};
const NIGHT = {
  id: 'shift-night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};

function actor(role: TeamActor['role'], managed: string[] = []): TeamActor {
  return {
    id: `actor-${role}`,
    role,
    isActive: true,
    hasAccess: true,
    managedSectorIds: managed,
  };
}
const ADMIN = actor('ADMIN');
const BOSS_PROD = actor('SUPERVISOR', [PROD.id]);
const BOSS_LOG = actor('OPERATOR', [LOG.id]);
const PLAIN = actor('OPERATOR');

function person(
  id: string,
  over: Partial<BoardPersonRow> = {},
): BoardPersonRow {
  return {
    id,
    name: id,
    email: `${id}@test.local`,
    jobTitle: null,
    sectorId: PROD.id,
    shiftId: MORNING.id,
    ...over,
  };
}

const EMPTY: ScheduleData = { cycle: null, schedule: null, exceptions: [] };

type HarnessInput = {
  actor?: TeamActor | null;
  members?: BoardPersonRow[];
  visitors?: BoardPersonRow[];
  data?: Record<string, Partial<ScheduleData>>;
};

const byIds = <T extends { id: string }>(all: T[], ids: readonly string[]) =>
  Promise.resolve(all.filter((item) => ids.includes(item.id)));

function harness(input: HarnessInput = {}) {
  const { members = [], visitors = [], data = {} } = input;
  const ids = [...members, ...visitors].map((p) => p.id);
  const loaded = new Map(ids.map((id) => [id, { ...EMPTY, ...data[id] }]));
  const repo = {
    findActor: vi.fn().mockResolvedValue(input.actor ?? null),
    listSectors: vi.fn((only: readonly string[] | null) =>
      only === null
        ? Promise.resolve(ACTIVE_SECTORS)
        : byIds(ACTIVE_SECTORS, only),
    ),
    listActiveShifts: vi.fn().mockResolvedValue([MORNING, NIGHT]),
    listSectorPeople: vi.fn().mockResolvedValue(members),
    listVisitorIds: vi.fn().mockResolvedValue(visitors.map((v) => v.id)),
    listPeopleByIds: vi.fn((only: readonly string[]) => byIds(visitors, only)),
    loadScheduleData: vi.fn().mockResolvedValue(loaded),
    findSectorsByIds: vi.fn((only: readonly string[]) =>
      byIds(ACTIVE_SECTORS, only),
    ),
    findShiftsByIds: vi.fn((only: readonly string[]) =>
      byIds(
        [MORNING, NIGHT].map((s) => ({ ...s, isActive: true })),
        only,
      ),
    ),
  };
  return { repo, service: new StaffScheduleService(repo as never) };
}

const WEEK = { sectorId: PROD.id, from: '2026-10-19', to: '2026-10-25' };
const FORBIDDEN = { status: 403, code: 'staff_schedule.forbidden' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 21:00 de 21/10 em Manaus (UTC-4): "hoje" é 21/10, não o 22/10 de UTC.
  vi.setSystemTime(new Date('2026-10-22T01:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('StaffScheduleService.options', () => {
  it.each([
    ['ADMIN vê todos os setores ativos', ADMIN, null, ACTIVE_SECTORS],
    ['gestor só os que gerencia', BOSS_PROD, [PROD.id], [PROD]],
  ] as const)("today '2026-10-21'; %s", async (_l, who, asked, sectors) => {
    const { repo, service } = harness({ actor: who });

    await expect(service.options(who.id)).resolves.toEqual({
      today: '2026-10-21',
      sectors,
      shifts: [MORNING, NIGHT],
    });
    expect(repo.listSectors).toHaveBeenCalledWith(asked);
  });
});

describe('StaffScheduleService — 403 staff_schedule.forbidden', () => {
  it.each([
    ['operador sem setor gerenciado', PLAIN],
    ['ator inexistente', null],
    ['gestor inativo', { ...BOSS_PROD, isActive: false }],
  ] as const)('options/board de %s', async (_l, who) => {
    const { repo, service } = harness({ actor: who });

    await expect(service.options('x')).rejects.toMatchObject(FORBIDDEN);
    await expect(service.board('x', WEEK)).rejects.toMatchObject(FORBIDDEN);
    expect(repo.listSectorPeople).not.toHaveBeenCalled();
  });

  it.each([
    ['gestor em setor que não gerencia', BOSS_LOG, PROD.id],
    ['ADMIN em setor inativo ou inexistente', ADMIN, 'sector-old'],
  ] as const)('board: %s', async (_l, who, sectorId) => {
    const { repo, service } = harness({ actor: who });

    await expect(
      service.board(who.id, { ...WEEK, sectorId }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(repo.listSectorPeople).not.toHaveBeenCalled();
    expect(repo.listVisitorIds).not.toHaveBeenCalled();
  });
});

describe('StaffScheduleService.board — período', () => {
  it.each([
    ['from > to', '2026-10-21', '2026-10-20'],
    ['43 dias', '2026-10-01', '2026-11-12'],
  ])(
    'período inválido (%s) → 422 staff_schedule.invalid_period',
    async (_l, from, to) => {
      const { repo, service } = harness({ actor: ADMIN });

      await expect(
        service.board(ADMIN.id, { sectorId: PROD.id, from, to }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'staff_schedule.invalid_period',
      });
      expect(repo.listSectorPeople).not.toHaveBeenCalled();
    },
  );

  it('42 dias é aceito, com um dia por data', async () => {
    const { service } = harness({ actor: ADMIN, members: [person('ana')] });

    const board = await service.board(ADMIN.id, {
      sectorId: PROD.id,
      from: '2026-10-01',
      to: '2026-11-11',
    });
    expect(board.rows[0].days).toHaveLength(42);
    expect(board.rows[0].days.at(-1)?.date).toBe('2026-11-11');
  });
});

const VISIT = {
  id: 'ex-bia',
  userId: 'bia',
  kind: 'OTHER_SECTOR' as const,
  startDate: '2026-10-21',
  endDate: '2026-10-21',
  shiftId: NIGHT.id,
  sectorId: PROD.id,
  note: null,
};
const VISIT_WORK = { kind: 'WORK', sectorId: PROD.id, shiftId: NIGHT.id };

describe('StaffScheduleService.board — linhas', () => {
  it("setor principal por nome com jobTitle, depois 'de outro setor'; canEdit false para quem vem de fora quando o ator é o gestor do destino", async () => {
    const { repo, service } = harness({
      actor: BOSS_PROD,
      members: [
        person('bruno', { name: 'Bruno' }),
        person('alvaro', { name: 'Álvaro', jobTitle: 'Operador' }),
      ],
      visitors: [person('bia', { name: 'Bia', sectorId: LOG.id })],
      data: { bia: { exceptions: [VISIT] } },
    });

    const board = await service.board(BOSS_PROD.id, WEEK);

    const summary = board.rows.map((r) => [
      r.name,
      r.jobTitle,
      r.fromOtherSector,
      r.canEdit,
    ]);
    expect(summary).toEqual([
      ['Álvaro', 'Operador', false, true],
      ['Bruno', null, false, true],
      ['Bia', null, true, false],
    ]);
    const { from, to } = WEEK;
    expect(repo.listVisitorIds).toHaveBeenCalledWith(PROD.id, from, to);
    const ids = ['bruno', 'alvaro', 'bia'];
    expect(repo.loadScheduleData).toHaveBeenCalledWith(ids, from, to);
    expect(board.rows[2].days[2]).toEqual({
      date: '2026-10-21',
      situation: { ...VISIT_WORK, source: 'EXCEPTION' },
      exceptionId: 'ex-bia',
    });
    expect(board).toMatchObject({ exceptions: [VISIT], sectors: [LOG, PROD] });
  });
});

const VACATION = {
  id: 'ex-maria',
  userId: 'maria',
  kind: 'VACATION' as const,
  startDate: '2026-10-20',
  endDate: '2026-10-24',
  shiftId: null,
  sectorId: null,
  note: 'Férias de outubro',
};
const weekdays = (shift: string) => [
  ...Array<string>(5).fill(shift),
  null,
  null,
];
const ROTATION = {
  template: 'WEEKLY_ROTATION' as const,
  startDate: '2026-10-19',
  cycleLength: 14,
  days: [...weekdays(MORNING.id), ...weekdays(NIGHT.id)],
};
type Day = StaffScheduleBoard['rows'][number]['days'][number];
/** Célula resumida: id do turno, `<motivo>:<exceptionId|->` ou NONE. */
function cell({ situation: s, exceptionId }: Day): string {
  if (s.kind === 'WORK') return s.shiftId;
  return s.kind === 'OFF' ? `${s.reason}:${exceptionId ?? '-'}` : 'NONE';
}

describe('StaffScheduleService.board — células (aceite 2 e 3)', () => {
  it('Maria com VACATION 2026-10-20..2026-10-24 → OFF VACATION com exceptionId; João no rodízio alterna turno e fim de semana OFF', async () => {
    const { service } = harness({
      actor: ADMIN,
      members: [
        person('maria', { name: 'Maria' }),
        person('joao', { name: 'João', shiftId: null }),
      ],
      data: {
        maria: { exceptions: [VACATION] },
        joao: { schedule: ROTATION, cycle: ROTATION },
      },
    });

    const board = await service.board(ADMIN.id, {
      sectorId: PROD.id,
      from: '2026-10-19',
      to: '2026-11-01',
    });

    const [joao, maria] = board.rows;
    const vacation = Array<string>(5).fill('VACATION:ex-maria');
    expect(maria.days.map(cell).slice(0, 7)).toEqual([
      MORNING.id,
      ...vacation,
      MORNING.id,
    ]);
    const expected = ROTATION.days.map((s) => s ?? 'DAY_OFF:-');
    expect(joao.days.map(cell)).toEqual(expected);
    expect(joao).toMatchObject({ schedule: ROTATION, profileShiftId: null });
    expect(board).toMatchObject({
      today: '2026-10-21',
      exceptions: [VACATION],
    });
    const active = [MORNING, NIGHT].map((s) => ({ ...s, isActive: true }));
    expect(board.shifts).toEqual(active);
  });
});

describe('StaffScheduleService.board — nota da exceção', () => {
  const BIA = person('bia', { name: 'Bia', sectorId: LOG.id });
  const NOTED = { ...VISIT, note: 'Cobrir férias' };
  it.each<[string, TeamActor, string, string | null]>([
    ['ADMIN no destino vê', ADMIN, PROD.id, NOTED.note],
    ['gestor do destino (canEdit false) não vê', BOSS_PROD, PROD.id, null],
    ['gestor do setor principal vê', BOSS_LOG, LOG.id, NOTED.note],
  ])('%s a nota', async (_label, viewer, sectorId, note) => {
    const atHome = sectorId === LOG.id;
    const { service } = harness({
      actor: viewer,
      members: atHome ? [BIA] : [],
      visitors: atHome ? [] : [BIA],
      data: { bia: { exceptions: [NOTED] } },
    });

    const board = await service.board(viewer.id, { ...WEEK, sectorId });

    expect(board.exceptions).toEqual([{ ...NOTED, note }]);
  });
});
