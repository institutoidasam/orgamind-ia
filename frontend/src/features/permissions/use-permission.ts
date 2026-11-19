import { useAuthStore } from '@/stores/auth.store';
import { effectivePermissions, hasPermission } from './access';
import type { PermissionKey } from './keys';

export function usePermission(key: PermissionKey): boolean {
  return useAuthStore((state) => hasPermission(state.user, key));
}

export function usePermissions(): readonly PermissionKey[] {
  return useAuthStore((state) => effectivePermissions(state.user));
}
