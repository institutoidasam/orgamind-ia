import type { UserRole } from '@/features/users/role';

/**
 * GC5: decisão de tela, só para esconder botão — a API decide de verdade.
 * Espelha as políticas do backend (C3); o Lote B troca o corpo por permissão.
 */

/** ADMIN inativa e reativa qualquer pessoa; SUPERVISOR só quem não tem acesso ao sistema. */
export function canChangePersonStatusUi(role: UserRole, person: { hasAccess: boolean }): boolean {
  if (role === 'ADMIN') return true;
  return role === 'SUPERVISOR' && !person.hasAccess;
}

/** Histórico de uma pessoa: ADMIN e SUPERVISOR. */
export function canViewPersonHistoryUi(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'SUPERVISOR';
}

/** Consulta geral da trilha: só ADMIN. */
export function canQueryAuditTrailUi(role: UserRole): boolean {
  return role === 'ADMIN';
}
