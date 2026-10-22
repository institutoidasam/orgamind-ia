import { createZodDto } from 'nestjs-zod';
import { updateShiftSchema } from '../../../schemas/contracts/shift.schema';

/** PATCH com ao menos um campo; `isActive: false` = desativar. */
export class UpdateShiftDto extends createZodDto(updateShiftSchema) {}
