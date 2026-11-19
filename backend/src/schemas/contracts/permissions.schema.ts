import { z } from 'zod';
import { PERMISSION_KEYS } from '../../shared/authz/permissions';

/**
 * Matriz de permissões por papel (CB7). A tela edita só SUPERVISOR e OPERATOR;
 * ADMIN e VIEWER aparecem fixos na resposta e, se vierem no corpo do PUT, o
 * serviço responde 422 (`permissions.fixed_role`).
 */
export const permissionKeySchema = z.enum(PERMISSION_KEYS);
const keyList = permissionKeySchema.array();

export const permissionMatrixSchema = z.object({
  keys: keyList,
  roles: z.object({
    ADMIN: keyList,
    SUPERVISOR: keyList,
    OPERATOR: keyList,
    VIEWER: keyList,
  }),
  defaults: z.object({ SUPERVISOR: keyList, OPERATOR: keyList }),
  editableRoles: z.enum(['SUPERVISOR', 'OPERATOR']).array(),
});

export const savePermissionMatrixSchema = z
  .object({
    roles: z
      .object({
        SUPERVISOR: keyList,
        OPERATOR: keyList,
        ADMIN: keyList.optional(),
        VIEWER: keyList.optional(),
      })
      .strict(),
  })
  .strict();

export type PermissionMatrix = z.infer<typeof permissionMatrixSchema>;
export type SavePermissionMatrix = z.infer<typeof savePermissionMatrixSchema>;
