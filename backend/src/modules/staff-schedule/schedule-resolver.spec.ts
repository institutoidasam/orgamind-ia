import { describe, expect, it } from 'vitest';
import {
  cycleIndex,
  exceptionOn,
  resolveDay,
  type DaySituation,
  type RosterPerson,
  type ScheduleCycle,
  type ScheduleExceptionInput,
} from './schedule-resolver';

type WorkSource = 'PROFILE' | 'CYCLE' | 'EXCEPTION';
const SECTOR = 'sec_producao';
const M = 'manha';

const work = (
  shiftId: string,
  source: WorkSource = 'CYCLE',
  sectorId: string | null = SECTOR,
): DaySituation => ({ kind: 'WORK', sectorId, shiftId, source });
const off = (
  reason: 'DAY_OFF' | 'VACATION' = 'DAY_OFF',
  source: 'CYCLE' | 'EXCEPTION' = 'CYCLE',
): DaySituation => ({ kind: 'OFF', reason, source });
const cycle = (startDate: string, days: (string | null)[]): ScheduleCycle => ({
  startDate,
  cycleLength: days.length,
  days,
});
const person = (over: Partial<RosterPerson> = {}): RosterPerson => ({
  id: 'u1',
  sectorId: SECTOR,
  profileShiftId: null,
  cycle: null,
  exceptions: [],
  ...over,
});
const exception = (
  over: Partial<ScheduleExceptionInput>,
): ScheduleExceptionInput => ({
  id: 'ex1',
  kind: 'DAY_OFF',
  startDate: '2026-10-27',
  endDate: '2026-10-27',
  shiftId: null,
  sectorId: null,
  ...over,
});

const WEEKLY = cycle('2026-10-26', [M, M, M, M, M, null, null]);
const TWELVE_36 = cycle('2026-12-30', ['noite', null]);
const ROTATION = cycle('2026-12-21', [
  ...Array<string>(5).fill('a'),
  null,
  null,
  ...Array<string>(5).fill('b'),
  null,
  null,
]);

describe('resolveDay — cadastro e início do ciclo', () => {
  it('antes da data de início cai no turno do cadastro', () => {
    const before = person({ cycle: ROTATION, profileShiftId: 'shift_first' });
    expect(cycleIndex(ROTATION, '2026-12-20')).toBeNull();
    expect(resolveDay(before, '2026-12-20')).toEqual(
      work('shift_first', 'PROFILE'),
    );
    expect(
      resolveDay({ ...before, profileShiftId: null }, '2026-12-20'),
    ).toEqual({ kind: 'NONE' });
  });

  it('sem escala: turno do cadastro todos os dias', () => {
    const profileOnly = person({ profileShiftId: 'shift_first' });
    expect(resolveDay(profileOnly, '2026-10-24')).toEqual(
      work('shift_first', 'PROFILE'),
    );
    expect(resolveDay(person(), '2026-10-24')).toEqual({ kind: 'NONE' });
  });
});

describe('resolveDay — mod do ciclo de 2, 7 e 14 dias atravessa mês e ano', () => {
  it.each<[string, ScheduleCycle, string, DaySituation]>([
    ['12x36', TWELVE_36, '2026-12-31', off()],
    ['12x36', TWELVE_36, '2027-01-01', work('noite')],
    ['12x36', TWELVE_36, '2027-01-02', off()],
    ['semanal', WEEKLY, '2026-11-01', off()],
    ['semanal', WEEKLY, '2026-11-02', work(M)],
    ['semanal', WEEKLY, '2027-01-03', off()],
    ['semanal', WEEKLY, '2027-01-04', work(M)],
    ['rodízio', ROTATION, '2026-12-28', work('b')],
    ['rodízio', ROTATION, '2027-01-01', work('b')],
    ['rodízio', ROTATION, '2027-01-02', off()],
    ['rodízio', ROTATION, '2027-01-04', work('a')],
    ['rodízio', ROTATION, '2027-01-11', work('b')],
  ])('%s em %s → %o', (_, c, date, expected) => {
    expect(resolveDay(person({ cycle: c }), date)).toEqual(expected);
  });
});

const VACATION = exception({
  kind: 'VACATION',
  startDate: '2026-11-02',
  endDate: '2026-11-06',
});

describe('resolveDay — exceção vence o ciclo', () => {
  it.each<[string, ScheduleExceptionInput, string, DaySituation]>([
    [
      'folga em dia de trabalho',
      exception({}),
      '2026-10-27',
      off('DAY_OFF', 'EXCEPTION'),
    ],
    [
      'férias no meio do período',
      VACATION,
      '2026-11-04',
      off('VACATION', 'EXCEPTION'),
    ],
    ['fora do período volta ao ciclo', VACATION, '2026-11-09', work(M)],
    [
      'troca de turno',
      exception({ kind: 'SHIFT_SWAP', shiftId: 'noite' }),
      '2026-10-27',
      work('noite', 'EXCEPTION'),
    ],
    [
      'outro setor',
      exception({
        kind: 'OTHER_SECTOR',
        startDate: '2026-10-31',
        endDate: '2026-10-31',
        shiftId: M,
        sectorId: 'sec_logistica',
      }),
      '2026-10-31',
      work(M, 'EXCEPTION', 'sec_logistica'),
    ],
    [
      'troca sem turno (dado inválido)',
      exception({ kind: 'SHIFT_SWAP' }),
      '2026-10-27',
      { kind: 'NONE' },
    ],
  ])('%s', (_, ex, date, expected) => {
    const p = person({ cycle: WEEKLY, exceptions: [ex] });
    expect(resolveDay(p, date)).toEqual(expected);
  });
});

describe('exceptionOn', () => {
  it('acha só a exceção que cobre a data (período inclusivo)', () => {
    const list = [exception({}), { ...VACATION, id: 'ex2' }];
    expect(exceptionOn(list, '2026-11-06')?.id).toBe('ex2');
    expect(exceptionOn(list, '2026-10-28')).toBeNull();
  });
});

describe('resolveDay — turno que atravessa a meia-noite', () => {
  it('Noite de 21/10 é de quem o ciclo põe na Noite em 21/10', () => {
    const p = person({ cycle: cycle('2026-10-21', ['noite', null]) });
    expect(resolveDay(p, '2026-10-21')).toEqual(work('noite'));
    // A madrugada de 22/10 pertence à entrada de 21/10: 22/10 é folga no ciclo.
    expect(resolveDay(p, '2026-10-22')).toEqual(off());
  });
});
