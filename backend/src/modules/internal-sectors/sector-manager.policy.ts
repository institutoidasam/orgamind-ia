import type { PolicyActor } from '../../shared/authz/person-actions.policy';
import { ForbiddenError } from '../../shared/errors/domain.error';

/**
 * Gestor do setor só pelo ADMIN (DB20, GB6): regra fixa em código, o único
 * `role === 'ADMIN'` desta decisão. A permissão `estrutura.manter` nunca a
 * substitui, porque o gestor define o alcance sobre pessoas, telefones e envios.
 */
export function canSetSectorManager(actor: PolicyActor): boolean {
  return actor.role === 'ADMIN';
}

export function sectorManagerAdminOnly(): ForbiddenError {
  return new ForbiddenError(
    'Só o administrador escolhe o gestor do setor.',
    'sector.manager_admin_only',
  );
}

/**
 * Decide só entre seguir e 403: `requested` ausente (`undefined`) ou igual ao
 * `current` segue; diferente, só o ADMIN. Na criação `current` é `null`. Quem
 * não é ADMIN também não grava o campo, e isso é do serviço.
 */
export function assertManagerChangeAllowed(
  actor: PolicyActor,
  requested: string | null | undefined,
  current: string | null,
): void {
  if (requested === undefined || requested === current) return;
  if (!canSetSectorManager(actor)) throw sectorManagerAdminOnly();
}
