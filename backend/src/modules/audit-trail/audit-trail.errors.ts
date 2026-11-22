import { DomainError, ForbiddenError } from '../../shared/errors/domain.error';

/**
 * Sem alcance, sem papel ou pessoa inexistente para quem não é ADMIN: o mesmo
 * 403 (C9), para a resposta não revelar quem existe.
 */
export function auditTrailForbidden(): ForbiddenError {
  return new ForbiddenError(
    'Você não pode ver o histórico desta pessoa.',
    'audit_trail.forbidden',
  );
}

/** Só quem vê qualquer pessoa (ADMIN) recebe 404 para pessoa inexistente. */
export function auditTrailPersonNotFound(): DomainError {
  return new DomainError({
    code: 'audit_trail.person_not_found',
    message: 'Pessoa não encontrada',
    status: 404,
  });
}
