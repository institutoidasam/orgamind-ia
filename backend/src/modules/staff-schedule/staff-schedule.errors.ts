import { DomainError, ForbiddenError } from '../../shared/errors/domain.error';

/** Fora da política da escala (ver, editar ou destino): 403 único, sem detalhar o motivo. */
export function scheduleForbidden(): ForbiddenError {
  return new ForbiddenError(
    'Fora da política da escala',
    'staff_schedule.forbidden',
  );
}

/** `from > to` ou mais de 42 dias no quadro. */
export function invalidPeriod(): DomainError {
  return new DomainError({
    code: 'staff_schedule.invalid_period',
    message: 'Período inválido (de 1 a 42 dias)',
    status: 422,
  });
}

/** Pessoa da escala (rota ou dona da exceção) não existe. */
export function scheduleUserNotFound(): DomainError {
  return new DomainError({
    code: 'staff_schedule.user_not_found',
    message: 'Pessoa não encontrada',
    status: 404,
  });
}

export function scheduleExceptionNotFound(): DomainError {
  return new DomainError({
    code: 'staff_schedule.exception_not_found',
    message: 'Exceção não encontrada',
    status: 404,
  });
}

/** Turno do ciclo ou da exceção inexistente ou inativo. */
export function scheduleInvalidShift(): DomainError {
  return new DomainError({
    code: 'staff_schedule.invalid_shift',
    message: 'Turno inexistente ou inativo',
    status: 422,
  });
}

/** Destino de "Outro setor" inexistente ou inativo. */
export function scheduleInvalidSector(): DomainError {
  return new DomainError({
    code: 'staff_schedule.invalid_sector',
    message: 'Setor inexistente ou inativo',
    status: 422,
  });
}
