import { DomainError, ForbiddenError } from '../../shared/errors/domain.error';

/** Fora da P1 (ator, papel, setor alheio ou inativo): 403 único, sem dizer se o setor existe. */
export function sectorPeopleForbidden(): ForbiddenError {
  return new ForbiddenError(
    'Você não gerencia este setor',
    'sector_people.forbidden',
  );
}

/** Só o ADMIN recebe 404; para o gestor, setor inexistente é 403. */
export function sectorPeopleSectorNotFound(): DomainError {
  return new DomainError({
    code: 'sector_people.sector_not_found',
    message: 'Setor não encontrado',
    status: 404,
  });
}

/** Pessoa inexistente ou inativa: nada é gravado. */
export function sectorPeoplePersonNotFound(): DomainError {
  return new DomainError({
    code: 'sector_people.person_not_found',
    message: 'Pessoa não encontrada',
    status: 404,
  });
}

/** Quem tem acesso sai do setor pelo cadastro em Usuários (ADMIN). */
export function sectorPeopleHasAccess(): DomainError {
  return new DomainError({
    code: 'sector_people.has_access',
    message: 'Quem tem acesso muda de setor pelo cadastro em Usuários',
    status: 422,
  });
}

/** Mesmo código do `UsersService` (Q3), conferido antes de criar qualquer pessoa. */
export function sectorPeopleInvalidShift(): DomainError {
  return new DomainError({
    code: 'users.invalid_shift',
    message: 'Turno inválido',
    status: 422,
  });
}

/** C9: a política `canChangePersonStatus` negou; pessoa com login só o administrador. */
export function sectorPeopleStatusForbidden(): DomainError {
  return new ForbiddenError(
    'Você não pode inativar ou reativar esta pessoa. Pessoa com acesso ao sistema, só o administrador.',
    'sector_people.status_forbidden',
  );
}

/** Guardas do `UsersService.updateUser` (em inglês lá); o setor as devolve em pt-BR com o mesmo código. */
const STATUS_GUARD_TEXTS: Readonly<Record<string, string>> = {
  'user.cannot_self_deactivate':
    'Você não pode inativar o seu próprio cadastro.',
  'user.last_admin':
    'Este é o último administrador ativo e não pode ser inativado.',
};

export function translateStatusGuard(error: unknown): unknown {
  if (!(error instanceof DomainError)) return error;
  const text = STATUS_GUARD_TEXTS[error.code];
  return text ? new ForbiddenError(text, error.code) : error;
}
