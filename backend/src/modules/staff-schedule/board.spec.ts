import { describe, expect, it } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { StaffException } from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { AssignmentLine } from '../users/assignment-timeline';
import {
  buildBoardRows,
  selectBoardPeople,
  type BoardPersonInput,
} from './board';

const A = 'sec-a';
const B = 'sec-b';
const SHIFT_A = 'shift-a';
const SHIFT_B = 'shift-b';
const TODAY = '2026-11-19';
const WEEK = [
  '2026-11-16',
  '2026-11-17',
  '2026-11-18',
  '2026-11-19',
  '2026-11-20',
  '2026-11-21',
  '2026-11-22',
];
const PAST = ['2026-11-10', '2026-11-11', '2026-11-12'];
const NO_VISITORS: ReadonlySet<string> = new Set();

const line = (
  sectorId: string,
  from: string | null,
  to: string | null,
): AssignmentLine => ({
  sectorId,
  shiftId: sectorId === A ? SHIFT_A : SHIFT_B,
  levelId: null,
  from,
  to,
});

/** Pessoa de hoje no setor `sectorId` (espelho), com as linhas do trecho passado. */
function person(
  id: string,
  sectorId: string,
  assignments: AssignmentLine[] = [],
  exceptions: StaffException[] = [],
): BoardPersonInput {
  return {
    id,
    name: id,
    email: `${id}@test.local`,
    jobTitle: null,
    sectorId,
    shiftId: sectorId === A ? SHIFT_A : SHIFT_B,
    cycle: null,
    schedule: null,
    exceptions,
    assignments,
  };
}

function managerOf(sectorId: string): TeamActor {
  return {
    ...actorWith('SUPERVISOR', { id: `boss-${sectorId}` }),
    managedSectorIds: [sectorId],
  };
}

function boardOf(
  sectorId: string,
  dates: string[],
  people: BoardPersonInput[],
) {
  const input = { sectorId, dates, today: TODAY, people };
  const shown = selectBoardPeople({ ...input, visitorIds: NO_VISITORS });
  return buildBoardRows({
    actor: managerOf(sectorId),
    ...input,
    people: shown,
  });
}

const SWAPPED = [line(A, null, '2026-11-18'), line(B, '2026-11-19', null)];

describe('board — período que cruza a troca de setor', () => {
  it('dias antes no setor antigo, a partir de hoje no novo; é membro nos dois quadros', () => {
    const ana = person('ana', B, SWAPPED);

    const [inA] = boardOf(A, WEEK, [ana]);
    const [inB] = boardOf(B, WEEK, [ana]);

    expect(inA.fromOtherSector).toBe(false);
    expect(inB.fromOtherSector).toBe(false);
    expect(inA.days[2].situation).toMatchObject({
      kind: 'WORK',
      sectorId: A,
      shiftId: SHIFT_A,
    });
    expect(inA.days[3].situation).toMatchObject({
      kind: 'WORK',
      sectorId: B,
      shiftId: SHIFT_B,
    });
    expect(inB.days[0].situation).toMatchObject({ sectorId: A });
  });
});

describe('board — só datas passadas', () => {
  it('mostra quem estava no setor e esconde quem chegou depois', () => {
    const was = person('ana', B, [line(A, null, '2026-11-15')]);
    const later = person('bia', A, [line(B, null, '2026-11-17')]);

    const rows = boardOf(A, PAST, [was, later]);

    expect(rows.map((row) => row.userId)).toEqual(['ana']);
    for (const day of rows[0].days) {
      expect(day.situation).toMatchObject({ kind: 'WORK', sectorId: A });
    }
  });
});

describe('board — visitante e quem nunca passou pelo setor', () => {
  it('visitante por exceção continua fromOtherSector; quem nunca esteve nem visitou fica fora', () => {
    const visit: StaffException = {
      id: 'ex-caio',
      userId: 'caio',
      kind: 'OTHER_SECTOR',
      startDate: '2026-11-11',
      endDate: '2026-11-11',
      shiftId: SHIFT_A,
      sectorId: A,
      note: null,
    };
    const caio = person('caio', B, [line(B, null, null)], [visit]);
    const dora = person('dora', B, [line(B, null, null)]);

    const rows = boardOf(A, PAST, [caio, dora]);

    expect(rows.map((row) => [row.userId, row.fromOtherSector])).toEqual([
      ['caio', true],
    ]);
    expect(rows[0].days[1].situation).toMatchObject({
      kind: 'WORK',
      sectorId: A,
    });
  });
});

describe('board — canEdit e profileShiftId', () => {
  it('seguem o cadastro atual (espelho), não o vínculo do dia', () => {
    const ana = person('ana', B, SWAPPED);

    const [byOldBoss] = boardOf(A, WEEK, [ana]);
    const [byNewBoss] = boardOf(B, WEEK, [ana]);

    expect(byOldBoss.canEdit).toBe(false);
    expect(byNewBoss.canEdit).toBe(true);
    expect(byOldBoss.profileShiftId).toBe(SHIFT_B);
  });
});
