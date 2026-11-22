import { DEFAULT_PERMISSIONS, type PermissionKey } from '@/features/permissions/keys';
import type { UserRole } from '@/features/users/role';

/**
 * GC5: decisão de tela, só para esconder botão — a API decide de verdade.
 * Espelha as políticas do backend; as ações cobertas leem das permissões, e
 * `permissions` ausente (sessão antiga ou chamador que ainda não a repassa)
 * vale o padrão do papel.
 */

/** O papel tem `key`? Sem a lista, vale `DEFAULT_PERMISSIONS[role]` (mesma regra de `effectivePermissions`). */
export function roleHasPermission(role: UserRole, key: PermissionKey, permissions?: readonly PermissionKey[]): boolean {
  return (permissions ?? DEFAULT_PERMISSIONS[role]).includes(key);
}

/** Tem `pessoas.inativar`; quem tem acesso ao sistema só o ADMIN muda, os demais só pessoas sem login. */
export function canChangePersonStatusUi(
  role: UserRole,
  person: { hasAccess: boolean },
  permissions?: readonly PermissionKey[],
): boolean {
  return roleHasPermission(role, 'pessoas.inativar', permissions) && (role === 'ADMIN' || !person.hasAccess);
}

/** Histórico de uma pessoa: ADMIN, ou quem tem `trilha.consultar`. */
export function canViewPersonHistoryUi(role: UserRole, permissions?: readonly PermissionKey[]): boolean {
  return role === 'ADMIN' || roleHasPermission(role, 'trilha.consultar', permissions);
}

/** Consulta geral da trilha: só ADMIN. */
export function canQueryAuditTrailUi(role: UserRole): boolean {
  return role === 'ADMIN';
}
