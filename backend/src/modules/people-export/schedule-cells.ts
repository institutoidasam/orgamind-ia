import type {
  BoardRow,
  DaySituationContract,
} from '../../schemas/contracts/staff-schedule.schema';
import { yesNo } from '../../shared/spreadsheet/cell-rules';

export type ScheduleCellInput = {
  situation: DaySituationContract;
  /** Setor do quadro: trabalhar nele mostra o turno; em outro, `Em <setor>`. */
  sectorId: string;
  shiftNames: ReadonlyMap<string, string>;
  sectorNames: ReadonlyMap<string, string>;
};

const UNKNOWN_SECTOR = 'outro setor';

/** Colunas fixas da pessoa; sem telefone nem e-mail (D2). */
export const SCHEDULE_FIXED_COLUMNS = ['nome', 'funcao', 'visitante'] as const;

/**
 * Células fixas da pessoa, na ordem de `SCHEDULE_FIXED_COLUMNS`. O quadro
 * monta o nome como `name ?? email` (colega com login convidado e sem nome):
 * o arquivo circula fora do sistema, então texto com `@` sai vazio na coluna
 * `nome`. A tela da Escala não muda.
 */
export function scheduleFixedCells(
  row: Pick<BoardRow, 'name' | 'jobTitle' | 'fromOtherSector'>,
): [name: string, jobTitle: string, otherSector: string] {
  const name = row.name.includes('@') ? '' : row.name;
  return [name, row.jobTitle ?? '', yesNo(row.fromOtherSector)];
}

/**
 * Texto da célula: turno, `Folga`, `Férias`, `Em <setor>` ou vazio (sem
 * escala). Cópia fiel de `cellLabel` do front (`board-cells.ts`): a planilha
 * diz o mesmo que a tela.
 */
export function scheduleCellLabel({
  situation,
  sectorId,
  shiftNames,
  sectorNames,
}: ScheduleCellInput): string {
  if (situation.kind === 'NONE') return '';
  if (situation.kind === 'OFF') {
    return situation.reason === 'VACATION' ? 'Férias' : 'Folga';
  }
  if (situation.sectorId === sectorId) {
    return shiftNames.get(situation.shiftId) ?? '';
  }
  const sectorName = situation.sectorId && sectorNames.get(situation.sectorId);
  return `Em ${sectorName || UNKNOWN_SECTOR}`;
}
