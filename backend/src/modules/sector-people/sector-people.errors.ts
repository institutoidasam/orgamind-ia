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
