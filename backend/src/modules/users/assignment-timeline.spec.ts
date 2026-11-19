import { describe, expect, it } from 'vitest';
import {
  assignmentOn,
  mergeAssignment,
  NO_ASSIGNMENT,
  planAssignmentStep,
  type AssignmentLine,
  type AssignmentValues,
} from './assignment-timeline';

const TODAY = '2026-11-19';
const A: AssignmentValues = { sectorId: 's-a', shiftId: 't-a', levelId: 'n-a' };
const B: AssignmentValues = { sectorId: 's-b', shiftId: 't-a', levelId: 'n-a' };

function line(
  values: AssignmentValues,
  from: string | null,
  to: string | null,
): AssignmentLine {
  return { ...values, from, to };
}

describe('planAssignmentStep', () => {
  it('planAssignmentStep: sem linha aberta abre hoje, inclusive sem setor, turno e nível', () => {
    expect(planAssignmentStep(null, B, TODAY)).toEqual({
      kind: 'OPEN',
      values: B,
      from: TODAY,
    });
    expect(planAssignmentStep(null, NO_ASSIGNMENT, TODAY)).toEqual({
      kind: 'OPEN',
      values: NO_ASSIGNMENT,
      from: TODAY,
    });
  });

  it('planAssignmentStep: igual à aberta não grava', () => {
    expect(planAssignmentStep(line(A, '2026-10-01', null), A, TODAY)).toEqual({
      kind: 'NONE',
    });
    expect(planAssignmentStep(line(A, null, null), { ...A }, TODAY)).toEqual({
      kind: 'NONE',
    });
  });

  it('planAssignmentStep: aberta desde antes de hoje (ou em branco) fecha em 2026-11-18 e abre 2026-11-19', () => {
    const expected = {
      kind: 'CLOSE_AND_OPEN',
      closeTo: '2026-11-18',
      values: B,
      from: TODAY,
    };
    expect(planAssignmentStep(line(A, '2026-10-01', null), B, TODAY)).toEqual(
      expected,
    );
    expect(planAssignmentStep(line(A, null, null), B, TODAY)).toEqual(expected);
  });
});

describe('planAssignmentStep no dia da abertura', () => {
  it('planAssignmentStep: aberta que começou hoje é atualizada no lugar', () => {
    expect(planAssignmentStep(line(A, TODAY, null), B, TODAY)).toEqual({
      kind: 'UPDATE_OPEN',
      values: B,
    });
  });

  it('planAssignmentStep: A→B→A no mesmo dia não junta linhas', () => {
    const closedYesterday = planAssignmentStep(
      line(A, '2026-10-01', null),
      B,
      TODAY,
    );
    expect(closedYesterday.kind).toBe('CLOSE_AND_OPEN');
    expect(planAssignmentStep(line(B, TODAY, null), A, TODAY)).toEqual({
      kind: 'UPDATE_OPEN',
      values: A,
    });
  });
});

describe('mergeAssignment', () => {
  it('mergeAssignment: campo ausente mantém, null limpa', () => {
    expect(mergeAssignment(A, {})).toEqual(A);
    expect(mergeAssignment(A, { sectorId: null })).toEqual({
      sectorId: null,
      shiftId: 't-a',
      levelId: 'n-a',
    });
    expect(mergeAssignment(A, { shiftId: 't-b', levelId: undefined })).toEqual({
      sectorId: 's-a',
      shiftId: 't-b',
      levelId: 'n-a',
    });
  });
});

describe('assignmentOn', () => {
  const closed = line(A, null, '2026-11-18');
  const open = line(B, TODAY, null);

  it('assignmentOn: hoje e futuro usam o espelho mesmo com linha fechada cobrindo', () => {
    const covering = line(A, null, '2026-12-31');
    const input = { mirror: B, lines: [covering], today: TODAY };
    expect(assignmentOn({ ...input, date: TODAY })).toEqual(B);
    expect(assignmentOn({ ...input, date: '2026-12-01' })).toEqual(B);
  });

  it('assignmentOn: data passada usa a linha que cobre; início em branco cobre qualquer passado; fim é inclusivo', () => {
    const input = { mirror: B, lines: [closed, open], today: TODAY };
    expect(assignmentOn({ ...input, date: '2026-11-18' })).toEqual(A);
    expect(assignmentOn({ ...input, date: '2000-01-01' })).toEqual(A);
  });

  it('assignmentOn: data passada sem linha que cubra usa o espelho', () => {
    const input = { mirror: B, lines: [line(A, '2026-11-10', '2026-11-12')] };
    expect(
      assignmentOn({ ...input, date: '2026-11-15', today: TODAY }),
    ).toEqual(B);
    expect(
      assignmentOn({ mirror: B, lines: [], date: '2026-11-15', today: TODAY }),
    ).toEqual(B);
  });
});
