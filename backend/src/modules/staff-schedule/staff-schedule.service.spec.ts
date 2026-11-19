import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffScheduleBoard } from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { AssignmentLine } from '../users/assignment-timeline';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
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
    ...actorWith(role, { id: `actor-${role}` }),
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
  assigned?: BoardPersonRow[];
  lines?: Record<string, AssignmentLine[]>;
  data?: Record<string, Partial<ScheduleData>>;
};

const byIds = <T extends { id: string }>(all: T[], ids: readonly string[]) =>
  Promise.resolve(all.filter((item) => ids.includes(item.id)));

function harness(input: HarnessInput = {}) {
  const { members = [], visitors = [], assigned = [], data = {} } = input;
  const ids = [...members, ...assigned, ...visitors].map((p) => p.id);
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
    listPeopleByIds: vi.fn((only: readonly string[]) =>
      byIds([...assigned, ...visitors], only),
    ),
    listAssignedUserIds: vi.fn().mockResolvedValue(assigned.map((a) => a.id)),
    loadAssignmentLines: vi
      .fn()
      .mockResolvedValue(new Map(Object.entries(input.lines ?? {}))),
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

const HOME_ANA = person('ana', { name: 'Ana' });
const GUEST_BIA = person('bia', { name: 'Bia', sectorId: LOG.id });
const swap = (userId: string, note: string) => ({
  id: `ex-${userId}`,
  userId,
  kind: 'SHIFT_SWAP' as const,
  startDate: '2026-10-21',
  endDate: '2026-10-21',
  shiftId: NIGHT.id,
  sectorId: null,
  note,
});

const inLog = (from: string | null, to: string | null): AssignmentLine => ({
  sectorId: LOG.id,
  shiftId: MORNING.id,
  levelId: null,
  from,
  to,
});
const inProd = (from: string | null, to: string | null): AssignmentLine => ({
  ...inLog(from, to),
  sectorId: PROD.id,
});

describe('StaffScheduleService.board — vínculo pela data (aceite 17)', () => {
  it('from >= hoje não consulta linhas de vínculo', async () => {
    const { repo, service } = harness({ actor: ADMIN, members: [HOME_ANA] });

    const board = await service.board(ADMIN.id, {
      sectorId: PROD.id,
      from: '2026-10-21',
      to: '2026-10-27',
    });

    expect(repo.listAssignedUserIds).not.toHaveBeenCalled();
    expect(repo.loadAssignmentLines).not.toHaveBeenCalled();
    expect(board.rows.map((row) => row.userId)).toEqual(['ana']);
  });

  it('período todo passado: entra quem estava no setor (mesmo hoje em outro) e sai quem chegou depois', async () => {
    const bia = person('bia', { name: 'Bia', sectorId: LOG.id });
    const past = { sectorId: PROD.id, from: '2026-10-12', to: '2026-10-18' };
    const { repo, service } = harness({
      actor: ADMIN,
      members: [HOME_ANA],
      assigned: [bia],
      lines: { ana: [inLog(null, '2026-10-20')], bia: [inProd(null, null)] },
    });

    const board = await service.board(ADMIN.id, past);

    expect(board.rows.map((row) => [row.userId, row.fromOtherSector])).toEqual([
      ['bia', false],
    ]);
    expect(board.rows[0].days[0].situation).toMatchObject({
      sectorId: PROD.id,
    });
    expect(repo.listAssignedUserIds).toHaveBeenCalledWith(
      PROD.id,
      past.from,
      past.to,
      501,
    );
    expect(repo.loadAssignmentLines).toHaveBeenCalledWith(
      ['ana', 'bia'],
      past.from,
      past.to,
    );
  });
});

describe('StaffScheduleService.board — o mesmo today', () => {
  it('usa o mesmo today no loadPeople e na resposta, mesmo se a meia-noite passa no meio', async () => {
    const { repo, service } = harness({ actor: ADMIN, members: [HOME_ANA] });
    repo.listSectorPeople.mockImplementation(() => {
      // 01:00 de 22/10 em Manaus: um segundo `todayIn` já daria 22/10.
      vi.setSystemTime(new Date('2026-10-22T05:00:00Z'));
      return Promise.resolve([HOME_ANA]);
    });

    const board = await service.board(ADMIN.id, WEEK);

    expect(board.today).toBe('2026-10-21');
    expect(repo.loadAssignmentLines).toHaveBeenCalledWith(
      ['ana'],
      WEEK.from,
      '2026-10-20',
    );
  });
});

const PHONE_A = '+5592911112222';
const PHONE_B = '+5592922221111';

describe('StaffScheduleService.board — nome que é telefone (D11)', () => {
  const members = [
    person('p1', { name: PHONE_A }),
    person('p2', { name: PHONE_B }),
    HOME_ANA,
  ];

  it('sem telefone.ver_completo: o nome-telefone sai mascarado, o número não aparece na resposta e a ordem é a da máscara exibida', async () => {
    const who: TeamActor = {
      ...actorWith('OPERATOR', { revoke: ['telefone.ver_completo'] }),
      managedSectorIds: [PROD.id],
    };
    const { service } = harness({ actor: who, members });

    const board = await service.board(who.id, WEEK);

    expect(board.rows.map((row) => [row.userId, row.name])).toEqual([
      ['p2', '•••• 1111'],
      ['p1', '•••• 2222'],
      ['ana', 'Ana'],
    ]);
    expect(JSON.stringify(board)).not.toMatch(/9111|9222/);
  });

  it.each([
    ['ADMIN', ADMIN],
    ['SUPERVISOR gestor', BOSS_PROD],
    ['OPERATOR gestor', actor('OPERATOR', [PROD.id])],
  ] as const)('matriz inicial: nome como gravado (%s)', async (_l, who) => {
    const { service } = harness({ actor: who, members });

    const board = await service.board(who.id, WEEK);

    expect(board.rows.map((row) => row.name)).toEqual([
      PHONE_A,
      PHONE_B,
      'Ana',
    ]);
  });
});

describe('StaffScheduleService.board — ordem do nome-telefone sem a chave (D11)', () => {
  it.each([
    ['+5592911112222', ['p1', 'p3']],
    ['+5592966662222', ['p3', 'p1']],
  ] as const)(
    'sem a chave: mesmos 4 últimos dígitos não revelam o número (%s): a posição não muda (desempate por id)',
    async (number, dbOrder) => {
      const who: TeamActor = {
        ...actorWith('OPERATOR', { revoke: ['telefone.ver_completo'] }),
        managedSectorIds: [PROD.id],
      };
      const names = { p1: number, p3: '+5592955552222' };
      const { service } = harness({
        actor: who,
        members: dbOrder.map((id) => person(id, { name: names[id] })),
      });

      const board = await service.board(who.id, WEEK);

      expect(board.rows.map((row) => row.userId)).toEqual(['p1', 'p3']);
    },
  );
});

describe('StaffScheduleService.board — canEdit com a matriz inicial (DB7)', () => {
  it.each([
    ['ADMIN', ADMIN, [true, true]],
    ['SUPERVISOR gestor do setor', BOSS_PROD, [true, false]],
    ['OPERATOR gestor do setor', actor('OPERATOR', [PROD.id]), [true, false]],
  ] as const)(
    'matriz inicial: canEdit igual a hoje (%s)',
    async (_l, who, edit) => {
      const { service } = harness({
        actor: who,
        members: [HOME_ANA],
        visitors: [GUEST_BIA],
      });

      const board = await service.board(who.id, WEEK);

      expect(board.rows.map((row) => row.canEdit)).toEqual(edit);
    },
  );
});

describe('StaffScheduleService.board — sem escala.alterar (DB7)', () => {
  it('OPERATOR gestor sem escala.alterar: canEdit false e a nota da exceção da pessoa do setor dele continua visível', async () => {
    const who: TeamActor = {
      ...actorWith('OPERATOR', { revoke: ['escala.alterar'] }),
      managedSectorIds: [PROD.id],
    };
    const { service } = harness({
      actor: who,
      members: [HOME_ANA],
      visitors: [GUEST_BIA],
      data: {
        ana: { exceptions: [swap('ana', 'Cobrir férias')] },
        bia: { exceptions: [swap('bia', 'Troca combinada')] },
      },
    });

    const board = await service.board(who.id, WEEK);

    expect(board.rows.map((row) => row.canEdit)).toEqual([false, false]);
    expect(board.exceptions.map((ex) => [ex.userId, ex.note])).toEqual([
      ['ana', 'Cobrir férias'],
      ['bia', null],
    ]);
  });
});

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
    expect(repo.listVisitorIds).toHaveBeenCalledWith(PROD.id, from, to, 501);
    expect(repo.listSectorPeople).toHaveBeenCalledWith(PROD.id, 501);
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

describe('StaffScheduleService.board — limite de pessoas (D13)', () => {
  const crowd = (n: number) =>
    Array.from({ length: n }, (_, i) => person(`p${i}`, { name: `P${i}` }));

  it.each<[string, number, number, boolean]>([
    ['501 pessoas: corta em 500 e avisa', 501, 500, true],
    ['3 pessoas: sem corte', 3, 3, false],
  ])('%s', async (_caso, total, linhas, truncated) => {
    const { service } = harness({ actor: ADMIN, members: crowd(total) });

    const board = await service.board(ADMIN.id, WEEK);

    expect(board.rows).toHaveLength(linhas);
    expect(board.truncated).toBe(truncated);
  });
});

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
