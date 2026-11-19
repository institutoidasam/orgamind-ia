import { addDays, type CivilDate } from '../staff-schedule/civil-date';

/** Setor, turno e nível de uma pessoa; null = sem valor. */
export type AssignmentValues = {
  sectorId: string | null;
  shiftId: string | null;
  levelId: string | null;
};

/** Alteração parcial: campo ausente mantém, null limpa. */
export type AssignmentPatch = Partial<AssignmentValues>;

/** Linha de vigência: início nulo = desde sempre; fim nulo = aberta; fim é inclusivo. */
export type AssignmentLine = AssignmentValues & {
  from: CivilDate | null;
  to: CivilDate | null;
};

export type AssignmentStep =
  | { kind: 'NONE' }
  | { kind: 'OPEN'; values: AssignmentValues; from: CivilDate }
  | { kind: 'UPDATE_OPEN'; values: AssignmentValues }
  | {
      kind: 'CLOSE_AND_OPEN';
      closeTo: CivilDate;
      values: AssignmentValues;
      from: CivilDate;
    };

export const NO_ASSIGNMENT: AssignmentValues = {
  sectorId: null,
  shiftId: null,
  levelId: null,
};

function keep<T>(patched: T | undefined, current: T): T {
  return patched === undefined ? current : patched;
}

export function mergeAssignment(
  current: AssignmentValues,
  patch: AssignmentPatch,
): AssignmentValues {
  return {
    sectorId: keep(patch.sectorId, current.sectorId),
    shiftId: keep(patch.shiftId, current.shiftId),
    levelId: keep(patch.levelId, current.levelId),
  };
}

export function sameAssignment(
  a: AssignmentValues,
  b: AssignmentValues,
): boolean {
  return (
    a.sectorId === b.sectorId &&
    a.shiftId === b.shiftId &&
    a.levelId === b.levelId
  );
}

/**
 * O que gravar para levar o vínculo aberto a `next` a partir de hoje. Sem linha
 * aberta abre hoje (mesmo com os três nulos); igual não grava; aberta que começou
 * hoje (ou depois) é atualizada no lugar; senão fecha na véspera e abre hoje.
 * A→B→A no mesmo dia não junta linhas: a aberta de hoje só recebe o valor.
 */
export function planAssignmentStep(
  open: AssignmentLine | null,
  next: AssignmentValues,
  today: CivilDate,
): AssignmentStep {
  if (open === null) return { kind: 'OPEN', values: next, from: today };
  if (sameAssignment(open, next)) return { kind: 'NONE' };
  if (open.from !== null && open.from >= today)
    return { kind: 'UPDATE_OPEN', values: next };
  return {
    kind: 'CLOSE_AND_OPEN',
    closeTo: addDays(today, -1),
    values: next,
    from: today,
  };
}

export function coversDate(
  line: Pick<AssignmentLine, 'from' | 'to'>,
  date: CivilDate,
): boolean {
  return (
    (line.from === null || line.from <= date) &&
    (line.to === null || date <= line.to)
  );
}

/**
 * Vínculo vigente em `date`: hoje e futuro usam o espelho (= linha aberta);
 * data passada usa a linha que cobre a data; sem linha que cubra, o espelho.
 */
export function assignmentOn(input: {
  mirror: AssignmentValues;
  lines: readonly AssignmentLine[];
  date: CivilDate;
  today: CivilDate;
}): AssignmentValues {
  const { mirror, lines, date, today } = input;
  if (date >= today) return mirror;
  const covering = lines.find((line) => coversDate(line, date));
  return covering
    ? {
        sectorId: covering.sectorId,
        shiftId: covering.shiftId,
        levelId: covering.levelId,
      }
    : mirror;
}
