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
