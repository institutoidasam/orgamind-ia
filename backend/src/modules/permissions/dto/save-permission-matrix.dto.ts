import { createZodDto } from 'nestjs-zod';
import { savePermissionMatrixSchema } from '../../../schemas/contracts/permissions.schema';

/** Estado completo de SUPERVISOR e OPERATOR; ADMIN/VIEWER presentes → 422 no serviço. */
export class SavePermissionMatrixDto extends createZodDto(
  savePermissionMatrixSchema,
) {}
