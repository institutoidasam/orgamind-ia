import type { AuthUser } from '@/stores/auth.store';
import { DEFAULT_PERMISSIONS, type PermissionKey } from './keys';

type PermissionSubject = Pick<AuthUser, 'role' | 'permissions'> | null;

const NO_PERMISSIONS: readonly PermissionKey[] = [];

/**
 * Permissões que a tela usa para esconder ou mostrar. Sessão sem a lista
 * (persistida antes das permissões) vale o padrão do papel até a primeira
 * releitura de `/auth/me`; sem sessão, nenhuma.
 */
export function effectivePermissions(user: PermissionSubject): readonly PermissionKey[] {
  if (!user) return NO_PERMISSIONS;
  return user.permissions ?? DEFAULT_PERMISSIONS[user.role];
}

export function hasPermission(user: PermissionSubject, key: PermissionKey): boolean {
  return effectivePermissions(user).includes(key);
}
