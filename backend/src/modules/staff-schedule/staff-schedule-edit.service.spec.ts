import { describe, expect, it, vi } from 'vitest';
import type {
  CreateExceptionInput,
  StaffException,
} from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import { StaffScheduleEditService } from './staff-schedule-edit.service';

const PROD = 'sector-prod';
const LOG = 'sector-log';
const ACTIVE_SHIFTS = ['shift-morning', 'shift-night'];

function actor(role: TeamActor['role'], managed: string[] = []): TeamActor {
  return {
    id: `actor-${role}`,
    role,
    isActive: true,
    managedSectorIds: managed,
  };
}
const ADMIN = actor('ADMIN');
const BOSS_PROD = actor('SUPERVISOR', [PROD]);
const PLAIN = actor('OPERATOR');

const CYCLE = {
  template: 'CUSTOM' as const,
  startDate: '2026-10-19',
  cycleLength: 2,
  days: ['shift-morning', null],
};
const SWAP: CreateExceptionInput = {
  kind: 'SHIFT_SWAP',
  startDate: '2026-10-21',
  endDate: '2026-10-22',
  shiftId: 'shift-night',
};
const TO_LOG: CreateExceptionInput = {
  ...SWAP,
  kind: 'OTHER_SECTOR',
  sectorId: LOG,
};
const CREATED: StaffException = {
  id: 'ex-new',
  userId: 'joao',
  kind: 'OTHER_SECTOR',
  startDate: '2026-10-21',
  endDate: '2026-10-22',
  shiftId: 'shift-night',
  sectorId: LOG,
  note: 'Cobrir férias da Ana',
};

type HarnessInput = {
  actor?: TeamActor;
  person?: { id: string; sectorId: string | null } | null;
  sector?: { id: string; isActive: boolean } | null;
};

function harness(input: HarnessInput = {}) {
  const person =
    input.person === undefined ? { id: 'joao', sectorId: PROD } : input.person;
  const repo = {
    findActor: vi.fn().mockResolvedValue(input.actor ?? ADMIN),
    findPerson: vi.fn().mockResolvedValue(person),
    findShiftsActive: vi.fn((ids: readonly string[]) =>
      Promise.resolve(ids.filter((id) => ACTIVE_SHIFTS.includes(id))),
    ),
    findSector: vi
      .fn()
      .mockResolvedValue(
        input.sector === undefined ? { id: LOG, isActive: true } : input.sector,
      ),
    findException: vi
      .fn()
      .mockResolvedValue({ id: 'ex-old', userId: 'joao', sectorId: null }),
    replaceSchedule: vi.fn().mockResolvedValue(CYCLE),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    createExceptionTrimming: vi
      .fn()
      .mockResolvedValue({ exception: CREATED, adjusted: 2 }),
    deleteException: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new StaffScheduleEditService(repo as never, audit as never);
  return { repo, audit, service };
}
type Harness = ReturnType<typeof harness>;

/** Nada gravado nem auditado. */
function expectNothingWritten({ repo, audit }: Harness) {
  expect(repo.replaceSchedule).not.toHaveBeenCalled();
  expect(repo.deleteSchedule).not.toHaveBeenCalled();
  expect(repo.createExceptionTrimming).not.toHaveBeenCalled();
  expect(repo.deleteException).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
}

const FORBIDDEN = { status: 403, code: 'staff_schedule.forbidden' };
type Call = (h: Harness, actorId: string) => Promise<unknown>;
const ROUTES: [string, Call][] = [
  ['PUT schedule', (h, id) => h.service.putSchedule(id, 'joao', CYCLE)],
  ['DELETE schedule', (h, id) => h.service.deleteSchedule(id, 'joao')],
  ['POST exception', (h, id) => h.service.createException(id, 'joao', SWAP)],
  ['DELETE exception', (h, id) => h.service.deleteException(id, 'ex-old')],
];

describe('StaffScheduleEditService — quem edita (GC8)', () => {
  it.each(ROUTES)(
    'gestor não edita pessoa de setor que não gerencia → 403 e nada gravado (%s)',
    async (_route, call) => {
      const h = harness({
        actor: BOSS_PROD,
        person: { id: 'joao', sectorId: LOG },
      });

      await expect(call(h, BOSS_PROD.id)).rejects.toMatchObject(FORBIDDEN);
      expectNothingWritten(h);
    },
  );

  it.each(ROUTES)(
    'quem não é ADMIN nem gestor → 403 antes de ler a pessoa (%s)',
    async (_route, call) => {
      const h = harness({ actor: PLAIN });

      await expect(call(h, PLAIN.id)).rejects.toMatchObject(FORBIDDEN);
      expect(h.repo.findPerson).not.toHaveBeenCalled();
      expectNothingWritten(h);
    },
  );

  it('DELETE exception usa o setor principal da dona da exceção', async () => {
    const h = harness({
      actor: BOSS_PROD,
      person: { id: 'joao', sectorId: LOG },
    });

    await expect(
      h.service.deleteException(BOSS_PROD.id, 'ex-old'),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(h.repo.findPerson).toHaveBeenCalledWith('joao');
  });
});

describe('StaffScheduleEditService — destino de "Outro setor"', () => {
  it('gestor de Produção manda João para Logística (não gerencia) → 403; ADMIN pode', async () => {
    const boss = harness({ actor: BOSS_PROD });
    await expect(
      boss.service.createException(BOSS_PROD.id, 'joao', TO_LOG),
    ).rejects.toMatchObject(FORBIDDEN);
    expectNothingWritten(boss);

    const admin = harness({ actor: ADMIN });
    await admin.service.createException(ADMIN.id, 'joao', TO_LOG);
    expect(admin.repo.findSector).toHaveBeenCalledWith(LOG);
    expect(admin.repo.createExceptionTrimming).toHaveBeenCalledWith(
      'joao',
      TO_LOG,
      ADMIN.id,
    );
  });

  it.each([
    ['inativo', { id: LOG, isActive: false }],
    ['inexistente', null],
  ])(
    'OTHER_SECTOR para setor %s → 422 invalid_sector',
    async (_label, sector) => {
      const h = harness({ actor: ADMIN, sector });

      await expect(
        h.service.createException(ADMIN.id, 'joao', TO_LOG),
      ).rejects.toMatchObject({
        status: 422,
        code: 'staff_schedule.invalid_sector',
      });
      expectNothingWritten(h);
    },
  );
});

describe('StaffScheduleEditService — turnos', () => {
  const ghostCycle = { ...CYCLE, days: ['shift-morning', 'shift-ghost'] };
  it.each<[string, Call]>([
    ['no ciclo', (h, id) => h.service.putSchedule(id, 'joao', ghostCycle)],
    [
      'na exceção',
      (h, id) =>
        h.service.createException(id, 'joao', {
          ...SWAP,
          shiftId: 'shift-ghost',
        }),
    ],
  ])(
    'turno inexistente ou inativo %s → 422 invalid_shift',
    async (_label, call) => {
      const h = harness();

      await expect(call(h, ADMIN.id)).rejects.toMatchObject({
        status: 422,
        code: 'staff_schedule.invalid_shift',
      });
      expectNothingWritten(h);
    },
  );
});

describe('StaffScheduleEditService — pessoa ou exceção inexistente', () => {
  it.each(ROUTES.slice(0, 3))(
    'pessoa inexistente → 404 user_not_found (%s)',
    async (_route, call) => {
      const h = harness({ person: null });

      await expect(call(h, ADMIN.id)).rejects.toMatchObject({
        status: 404,
        code: 'staff_schedule.user_not_found',
      });
      expectNothingWritten(h);
    },
  );

  it('exceção inexistente → 404 exception_not_found', async () => {
    const h = harness();
    h.repo.findException.mockResolvedValue(null);

    await expect(
      h.service.deleteException(ADMIN.id, 'ex-ghost'),
    ).rejects.toMatchObject({
      status: 404,
      code: 'staff_schedule.exception_not_found',
    });
    expectNothingWritten(h);
  });
});

describe('StaffScheduleEditService — createException (GC10)', () => {
  it('createException devolve adjusted do repositório e audita sem nota', async () => {
    const h = harness();

    const result = await h.service.createException(ADMIN.id, 'joao', {
      ...TO_LOG,
      note: CREATED.note ?? '',
    });

    expect(result).toEqual({ exception: CREATED, adjusted: 2 });
    expect(h.audit.log).toHaveBeenCalledWith(
      'staff_schedule.exception_create',
      'StaffScheduleException',
      'ex-new',
      {
        actorId: ADMIN.id,
        userId: 'joao',
        adjusted: 2,
      },
    );
    expect(JSON.stringify(h.audit.log.mock.calls)).not.toContain('Ana');
  });
});

describe('StaffScheduleEditService — gravação do ciclo e remoções (GC10)', () => {
  it.each<[string, Call, string]>([
    ['PUT schedule', ROUTES[0][1], 'staff_schedule.put'],
    ['DELETE schedule', ROUTES[1][1], 'staff_schedule.delete'],
    ['DELETE exception', ROUTES[3][1], 'staff_schedule.exception_delete'],
  ])('%s grava e audita só ids', async (_route, call, action) => {
    const h = harness();

    await call(h, ADMIN.id);

    const [[logged, , , meta]] = h.audit.log.mock.calls as [
      string,
      string,
      string,
      object,
    ][];
    expect(logged).toBe(action);
    expect(meta).toMatchObject({ actorId: ADMIN.id, userId: 'joao' });
  });

  it('PUT schedule devolve o ciclo gravado e valida cada turno uma vez', async () => {
    const h = harness();
    const cycle = {
      ...CYCLE,
      days: ['shift-morning', null, 'shift-morning'],
      cycleLength: 3,
    };

    await expect(
      h.service.putSchedule(ADMIN.id, 'joao', cycle),
    ).resolves.toEqual(CYCLE);
    expect(h.repo.findShiftsActive).toHaveBeenCalledWith(['shift-morning']);
    expect(h.repo.replaceSchedule).toHaveBeenCalledWith(
      'joao',
      cycle,
      ADMIN.id,
    );
  });
});
