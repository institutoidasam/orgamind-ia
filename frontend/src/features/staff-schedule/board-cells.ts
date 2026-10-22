import type { DaySituation } from './schemas';

type CellInput = {
  situation: DaySituation;
  /** Setor do quadro: trabalhar nele mostra o turno; em outro, `Em <setor>`. */
  sectorId: string;
  shiftNames: ReadonlyMap<string, string>;
  sectorNames: ReadonlyMap<string, string>;
};

const UNKNOWN_SECTOR = 'outro setor';

/** Texto da célula: turno, `Folga`, `Férias`, `Em <setor>` ou vazio (sem escala). */
export function cellLabel({ situation, sectorId, shiftNames, sectorNames }: CellInput): string {
  if (situation.kind === 'NONE') return '';
  if (situation.kind === 'OFF') return situation.reason === 'VACATION' ? 'Férias' : 'Folga';
  if (situation.sectorId === sectorId) return shiftNames.get(situation.shiftId) ?? '';
  return `Em ${(situation.sectorId && sectorNames.get(situation.sectorId)) || UNKNOWN_SECTOR}`;
}
