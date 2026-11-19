import type { AuditCategory, Role } from '@prisma/client';
import { hasPermission, type PermissionHolder } from './permissions';

/**
 * Políticas de pessoa e trilha (C3). Toda decisão de quem inativa, autoriza,
 * exclui ou consulta a trilha passa por aqui. Inativar, autorizar contato e ver
 * o histórico da ficha dependem da permissão do ator (Lote B); exclusão,
 * consulta geral e categorias da ficha seguem fixas do ADMIN.
 */
export type PolicyActor = { id: string; role: Role };
export type PermissionActor = PolicyActor & PermissionHolder;
export type PolicyPerson = { hasAccess: boolean };

/** Categorias que a ficha mostra a quem não é ADMIN (sem Estrutura e Permissões). */
const PERSON_RECORD_CATEGORIES: readonly AuditCategory[] = [
  'PERSON',
  'ASSIGNMENT',
  'SCHEDULE',
];

function isAdmin(actor: PolicyActor): boolean {
  return actor.role === 'ADMIN';
}

/**
 * pessoas.inativar: exige a permissão; ADMIN inativa qualquer pessoa, os demais
 * só quem não tem login e no alcance (pessoa com login, só o ADMIN).
 */
export function canChangePersonStatus(
  actor: PermissionActor,
  person: PolicyPerson,
  inReach: boolean,
): boolean {
  if (!hasPermission(actor, 'pessoas.inativar')) return false;
  return isAdmin(actor) || (!person.hasAccess && inReach);
}

/** Autorização de contato: pessoa com login, só ADMIN; sem login, quem tem pessoas.editar (DB16). */
export function canEditContactAuthorization(
  actor: PermissionActor,
  person: PolicyPerson,
): boolean {
  if (person.hasAccess) return isAdmin(actor);
  return hasPermission(actor, 'pessoas.editar');
}

/** Exclusão física: só ADMIN. */
export function canDeletePerson(actor: PolicyActor): boolean {
  return isAdmin(actor);
}

/** trilha.consultar, consulta geral: só ADMIN. */
export function canQueryAuditTrail(actor: PolicyActor): boolean {
  return isAdmin(actor);
}

/** trilha.consultar, ficha: ADMIN sempre; os demais com a permissão e só no alcance. */
export function canViewPersonHistory(
  actor: PermissionActor,
  inReach: boolean,
): boolean {
  return (
    isAdmin(actor) || (hasPermission(actor, 'trilha.consultar') && inReach)
  );
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
