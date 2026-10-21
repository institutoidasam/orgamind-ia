import { addDays } from '@/lib/civil-date';
import type { CreateExceptionInput, StaffExceptionKind } from './schemas';

export const NOTE_MAX = 200;
/** Exceção mais longa aceita pelo servidor: um ano bissexto inteiro. */
const MAX_DAYS = 366;

export const KIND_OPTIONS: { value: StaffExceptionKind; label: string }[] = [
  { value: 'DAY_OFF', label: 'Folga' },
  { value: 'VACATION', label: 'Férias' },
  { value: 'SHIFT_SWAP', label: 'Troca de turno' },
  { value: 'OTHER_SECTOR', label: 'Outro setor' },
];

export type ExceptionDraft = {
  kind: StaffExceptionKind;
  startDate: string;
  endDate: string;
  shiftId: string;
  sectorId: string;
  note: string;
};

export type DraftErrors = Partial<Record<'endDate' | 'shiftId' | 'sectorId' | 'note', string>>;

/** Rascunho de um dia: folga de `date` a `date`. */
export function newDraft(date: string): ExceptionDraft {
  return { kind: 'DAY_OFF', startDate: date, endDate: date, shiftId: '', sectorId: '', note: '' };
}

export const needsShift = (kind: StaffExceptionKind) => kind === 'SHIFT_SWAP' || kind === 'OTHER_SECTOR';
export const needsSector = (kind: StaffExceptionKind) => kind === 'OTHER_SECTOR';

function periodError({ startDate, endDate }: ExceptionDraft): string | undefined {
  if (!startDate || !endDate) return 'Informe as duas datas.';
  if (endDate < startDate) return 'A data final deve ser igual ou posterior à inicial.';
  if (endDate > addDays(startDate, MAX_DAYS - 1)) return `O período pode ter até ${MAX_DAYS} dias.`;
  return undefined;
}

/** Campos com problema; vazio = pode enviar. */
export function validateDraft(draft: ExceptionDraft): DraftErrors {
  const errors: DraftErrors = {};
  const period = periodError(draft);
  if (period) errors.endDate = period;
  if (needsShift(draft.kind) && !draft.shiftId) errors.shiftId = 'Escolha o turno.';
  if (needsSector(draft.kind) && !draft.sectorId) errors.sectorId = 'Escolha o setor.';
  if (draft.note.trim().length > NOTE_MAX) errors.note = `A observação pode ter até ${NOTE_MAX} caracteres.`;
  return errors;
}

/** Corpo do POST: turno/setor só quando o tipo exige; `note` aparada, ausente se vazia. */
export function draftToInput(draft: ExceptionDraft): CreateExceptionInput {
  const note = draft.note.trim();
  return {
    kind: draft.kind,
    startDate: draft.startDate,
    endDate: draft.endDate,
    ...(needsShift(draft.kind) && { shiftId: draft.shiftId }),
    ...(needsSector(draft.kind) && { sectorId: draft.sectorId }),
    ...(note && { note }),
  };
}
