import { createZodDto } from 'nestjs-zod';
import { updateLevelSchema } from '../../../schemas/contracts/level.schema';

/** PATCH com ao menos um campo; `isActive: false` = desativar. */
export class UpdateLevelDto extends createZodDto(updateLevelSchema) {}
