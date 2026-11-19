import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../../shared/authz/permissions';

export const PERMISSION_KEY = 'permission';

/**
 * Exige a permissão por ação (CB3). Num handler, vale no lugar do `@Roles`; na
 * classe, vale para os handlers sem `@Roles`. O `PermissionsGuard` confere a
 * matriz; o `RolesGuard` apenas deixa a rota passar para ele.
 */
export const RequirePermission = (key: PermissionKey) =>
  SetMetadata(PERMISSION_KEY, key);
