import { z } from 'zod';
import { PERMISSION_KEYS } from './keys';

/**
 * Espelho de `permissionMatrixSchema` (backend/src/schemas/contracts/permissions.schema.ts, CB7).
 * Chave fora das 9 conhecidas derruba a leitura de propósito: tela que grava
 * permissão não pode descartar em silêncio o que não entende.
 */
const permissionKeySchema = z.enum(PERMISSION_KEYS);
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

export type PermissionMatrix = z.infer<typeof permissionMatrixSchema>;
