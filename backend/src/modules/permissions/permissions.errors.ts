import { DomainError } from '../../shared/errors/domain.error';

/** ADMIN ou VIEWER no corpo do PUT: as permissões dos dois são fixas (CB8, aceite 12). */
export function fixedRole(): DomainError {
  return new DomainError({
    code: 'permissions.fixed_role',
    message: 'Permissões não alteradas',
    detail:
      'Administrador e Leitura têm permissões fixas e não podem ser alterados.',
    status: 422,
  });
}

/** Duas gravações da matriz disputaram e a nossa perdeu em todas as tentativas (409). */
export function permissionsConflict(): DomainError {
  return new DomainError({
    code: 'permissions.conflict',
    message: 'Permissões não alteradas',
    detail:
      'As permissões foram alteradas por outra pessoa ao mesmo tempo. Recarregue a tela e tente de novo.',
    status: 409,
  });
}
