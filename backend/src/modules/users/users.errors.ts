import { ConflictError, DomainError } from '../../shared/errors/domain.error';

/** Pessoa sem acesso (D1): sem senha para redefinir e sem papel para mudar. */
export function noAccess(): DomainError {
  return new DomainError({
    code: 'users.no_access',
    message: 'Esta pessoa não tem acesso ao sistema',
    status: 422,
  });
}

/** Dar acesso a quem já tem (inclusive quando outro pedido concorrente ganhou). */
export function alreadyHasAccess(): DomainError {
  return new DomainError({
    code: 'users.already_has_access',
    message: 'Esta pessoa já tem acesso',
    status: 409,
  });
}

/** Pessoa sem acesso não tem e-mail: o nome é obrigatório (spec §1). */
export function nameRequired(): DomainError {
  return new DomainError({
    code: 'users.name_required',
    message: 'Informe o nome',
    status: 422,
  });
}

/** Nível inexistente, ou inativo e diferente do atual da pessoa. */
export function invalidLevel(): DomainError {
  return new DomainError({
    code: 'users.invalid_level',
    message: 'Nível inválido',
    status: 422,
  });
}

export function emailTaken(): ConflictError {
  return new ConflictError('Email already taken', 'user.email_taken');
}

/**
 * Dar acesso (C2): papel ≠ ADMIN exige setor ativo, como no convite, mas o
 * contrato da rota nova responde 422. O convite e o PATCH seguem com o 409 de hoje.
 */
export function accessSectorError(
  code: 'user.sector_required' | 'user.sector_invalid',
): DomainError {
  return new DomainError({
    code,
    message: 'An active sector is required',
    status: 422,
  });
}

/** Matrícula repetida (A1): a chave em minúsculas já pertence a outra pessoa. */
export function registrationTaken(): DomainError {
  return new DomainError({
    code: 'user.registration_taken',
    message: 'Já existe uma pessoa com esta matrícula',
    status: 422,
  });
}

/** A data da autorização é um dia já vivido: hoje no fuso do app ou antes. */
export function authorizationFutureDate(): DomainError {
  return new DomainError({
    code: 'user.authorization_future_date',
    message: 'A data da autorização não pode ser futura.',
    status: 422,
  });
}

/** Motivo da alteração (A4): de 3 a 200 caracteres, aparado. */
export function reasonRequired(): DomainError {
  return new DomainError({
    code: 'user.reason_required',
    message: 'Informe o motivo da alteração, de 3 a 200 caracteres.',
    status: 422,
  });
}

/** Exclusão física só de quem não deixou histórico (A3): com histórico, inativa. */
export function hasHistory(): ConflictError {
  return new ConflictError(
    'Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro.',
    'user.has_history',
  );
}
