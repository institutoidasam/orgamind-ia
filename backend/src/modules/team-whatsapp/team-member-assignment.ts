import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import type { TeamMemberRow } from './team-whatsapp.repository';

/**
 * Linha de `UserAssignment` que cobre a data, na forma dos campos de vínculo de
 * `TeamMemberRow` (o turno vem como `shift`; na pessoa ele é `workShift`).
 */
export type AssignmentOnRow = {
  sectorId: string | null;
  sector: { isActive: boolean } | null;
  shiftId: string | null;
  shift: { name: string } | null;
  levelId: string | null;
  level: { id: string; name: string } | null;
};

/**
 * Pessoa da lista do dia com o vínculo da data (DV9, DV11): sem linha que cubra
 * a data fica como está (espelho, DV8); com linha, setor (e se está ativo),
 * turno e nível passam a ser os da linha. Contato, autorização e escala ficam.
 */
export function withAssignmentOn<T extends TeamMemberRow>(
  row: T,
  line: AssignmentOnRow | undefined,
): T {
  if (!line) return row;
  return {
    ...row,
    sectorId: line.sectorId,
    sector: line.sector,
    shiftId: line.shiftId,
    workShift: line.shift,
    levelId: line.levelId,
    level: line.level,
  };
}

/**
 * Visitante pelo setor da data (só data passada): `listVisitorIdsBySector`
 * descarta quem tem o setor no espelho; se o vínculo da data era outro, a
 * exceção OTHER_SECTOR para o setor (já lida para a data) volta a valer.
 */
export function hasOtherSectorTo(
  person: { exceptions: readonly ScheduleExceptionInput[] },
  sectorId: string,
): boolean {
  return person.exceptions.some(
    (e) => e.kind === 'OTHER_SECTOR' && e.sectorId === sectorId,
  );
}
