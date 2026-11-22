import type { Prisma, Role } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  defaultPermissionsFor,
  isEditableRole,
  resolvePermissions,
  type PermissionKey,
} from '../../shared/authz/permissions';

/**
 * ÚNICO leitor da tabela `RolePermission` (GB3): sem cache e sem JWT, cada
 * chamada vai ao banco. ADMIN e VIEWER têm permissões fixas e não consultam.
 */
export async function findEffectivePermissions(
  client: Pick<PrismaService, 'rolePermission'> | Prisma.TransactionClient,
  role: Role,
): Promise<PermissionKey[]> {
  if (!isEditableRole(role)) return defaultPermissionsFor(role);
  const rows = await client.rolePermission.findMany({
    where: { role },
    select: { key: true, granted: true },
  });
  return resolvePermissions(role, rows);
}
