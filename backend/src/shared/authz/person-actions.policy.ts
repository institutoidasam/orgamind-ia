import type { AuditCategory, Role } from '@prisma/client';

/**
 * Políticas de pessoa e trilha (C3). Matriz inicial por papel: toda decisão
 * nova de quem inativa, autoriza, exclui ou consulta a trilha passa por aqui,
 * para o Lote B trocar o corpo por permissão sem tocar nos chamadores.
 */
export type PolicyActor = { id: string; role: Role };
export type PolicyPerson = { hasAccess: boolean };

/** Papéis que já escrevem pessoas do setor (`sector-people.policy.ts`). */
const PERSON_WRITE_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];

/** Categorias que a ficha mostra a quem não é ADMIN (sem Estrutura e Permissões). */
const PERSON_RECORD_CATEGORIES: readonly AuditCategory[] = [
  'PERSON',
  'ASSIGNMENT',
  'SCHEDULE',
];

function isAdmin(actor: PolicyActor): boolean {
  return actor.role === 'ADMIN';
}

/** pessoas.inativar: ADMIN qualquer pessoa; SUPERVISOR só sem login e no alcance; OPERATOR/VIEWER nunca. */
export function canChangePersonStatus(
  actor: PolicyActor,
  person: PolicyPerson,
  inReach: boolean,
): boolean {
  if (isAdmin(actor)) return true;
  return actor.role === 'SUPERVISOR' && !person.hasAccess && inReach;
}

/** Autorização de contato: pessoa com login, só ADMIN; sem login, quem já edita a pessoa. */
export function canEditContactAuthorization(
  actor: PolicyActor,
  person: PolicyPerson,
): boolean {
  if (person.hasAccess) return isAdmin(actor);
  return PERSON_WRITE_ROLES.includes(actor.role);
}

/** Exclusão física: só ADMIN. */
export function canDeletePerson(actor: PolicyActor): boolean {
  return isAdmin(actor);
}

/** trilha.consultar, consulta geral: só ADMIN. */
export function canQueryAuditTrail(actor: PolicyActor): boolean {
  return isAdmin(actor);
}

/** trilha.consultar, ficha: ADMIN sempre; SUPERVISOR só no alcance; OPERATOR/VIEWER nunca. */
export function canViewPersonHistory(
  actor: PolicyActor,
  inReach: boolean,
): boolean {
  if (isAdmin(actor)) return true;
  return actor.role === 'SUPERVISOR' && inReach;
}

/**
 * Categorias da ficha: ADMIN `null` (todas as categorizadas); demais Pessoa,
 * Vínculo e Escala. A consulta `personHistory` filtra também `category IS NOT
 * NULL`, então login, refresh e logout ficam fora em qualquer caso.
 */
export function personHistoryCategories(
  actor: PolicyActor,
): AuditCategory[] | null {
  return isAdmin(actor) ? null : [...PERSON_RECORD_CATEGORIES];
}
