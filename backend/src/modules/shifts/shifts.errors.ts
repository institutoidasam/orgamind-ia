import { DomainError } from '../../shared/errors/domain.error';
import type { ShiftUsageKind } from '../../schemas/contracts/shift.schema';

export function shiftNotFound(): DomainError {
  return new DomainError({
    code: 'shifts.not_found',
    message: 'Turno não encontrado',
    status: 404,
  });
}

/** Nome já usado por outro turno (comparação sem caixa, após trim). */
export function shiftNameTaken(): DomainError {
  return new DomainError({
    code: 'shifts.name_taken',
    message: 'Já existe um turno com esse nome',
    status: 409,
  });
}

/** Desativar turno em uso; `detail` lista só os motivos (nada de dado pessoal). */
export function shiftInUse(kinds: readonly ShiftUsageKind[]): DomainError {
  return new DomainError({
    code: 'shifts.in_use',
    message: 'Turno em uso não pode ser desativado',
    status: 409,
    detail: kinds.join(', '),
  });
}

/** Ids repetidos ou diferentes do conjunto de todos os turnos. */
export function invalidShiftOrder(): DomainError {
  return new DomainError({
    code: 'shifts.invalid_order',
    message: 'A ordem deve conter cada turno exatamente uma vez',
    status: 422,
  });
}
