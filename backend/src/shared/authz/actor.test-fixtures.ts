import type { Role } from '@prisma/client';
import {
  PERMISSION_KEYS,
  defaultPermissionsFor,
  type PermissionKey,
} from './permissions';

/** Fixture única de ator dos specs de autorização (CB2). */
export type PermissionChange = {
  grant?: readonly PermissionKey[];
  revoke?: readonly PermissionKey[];
};

/** Padrão do papel mais `grant` menos `revoke`, na ordem de `PERMISSION_KEYS`. */
export function permissionsWith(
  role: Role,
  change: PermissionChange = {},
): PermissionKey[] {
  const base = new Set<PermissionKey>(defaultPermissionsFor(role));
  for (const key of change.grant ?? []) base.add(key);
  for (const key of change.revoke ?? []) base.delete(key);
  return PERMISSION_KEYS.filter((key) => base.has(key));
}

/** Serve como `PeopleActor`; `TeamActor` = `{ ...actorWith(role), managedSectorIds }`. */
export function actorWith(
  role: Role,
  change: PermissionChange & { id?: string } = {},
): {
  id: string;
  role: Role;
  isActive: true;
  hasAccess: true;
  permissions: PermissionKey[];
} {
  return {
    id: change.id ?? `actor-${role.toLowerCase()}`,
    role,
    isActive: true,
    hasAccess: true,
    permissions: permissionsWith(role, change),
  };
}
